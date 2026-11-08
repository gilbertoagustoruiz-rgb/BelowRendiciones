// Reads receipts (factura / boleta) from photos and PDFs.
// Order of evidence: SUNAT QR code (exact) → PDF text layer → OCR of the image or rendered PDF.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createScheduler, createWorker } from "tesseract.js";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import { normalizeText, parseReceiptText, parseSunatQr } from "./receipt-parser.js";

export { parseReceiptText, parseSunatQr } from "./receipt-parser.js";

const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 45000);
const OCR_WORKERS = Math.max(1, Math.min(4, Number(process.env.OCR_WORKERS || 1)));
const MAX_PDF_PAGES = 3;
const MAX_INPUT_PIXELS = 60_000_000; // larger images are rejected instead of exhausting memory
const RENDER_LONG_SIDE = 2400;

const require = createRequire(import.meta.url);
const PDFJS_ROOT = fileURLToPath(new URL("../../", import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs")));
const PDF_OPTIONS = {
  isEvalSupported: false,       // never compile code found inside a PDF
  disableFontFace: true,
  useSystemFonts: false,
  enableXfa: false,
  stopAtErrors: false,
  maxImageSize: 40_000_000,
  verbosity: 0,
  standardFontDataUrl: PDFJS_ROOT + "standard_fonts/",
  cMapUrl: PDFJS_ROOT + "cmaps/",
  cMapPacked: true,
  wasmUrl: PDFJS_ROOT + "wasm/",   // JBIG2 / JPEG 2000 decoders used by scanners
  iccUrl: PDFJS_ROOT + "iccs/",
};

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/* ----------------------------- QR (zxing) ----------------------------- */

let zxingReady;
function loadZxing() {
  // The WASM ships inside the package: nothing is downloaded at runtime.
  zxingReady ||= prepareZXingModule({
    overrides: { wasmBinary: fs.readFileSync(fileURLToPath(import.meta.resolve("zxing-wasm/reader/zxing_reader.wasm"))) },
    fireImmediately: true,
  }).catch((error) => { zxingReady = null; throw error; });
  return zxingReady;
}

async function decodeQrFromRaw({ data, info }) {
  await loadZxing();
  const results = await readBarcodes(
    { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height, colorSpace: "srgb" },
    { formats: ["QRCode"], tryHarder: true, tryRotate: true, maxNumberOfSymbols: 4 }
  );
  // A receipt may also carry a payment QR (Yape, Plin): keep the one SUNAT defines.
  for (const result of results) {
    const parsed = parseSunatQr(result.text);
    if (parsed) return parsed;
  }
  return null;
}

/** Tries the image as is, then contrast-enhanced and downscaled variants. */
async function findSunatQr(image) {
  const variants = [
    (img) => img.clone().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }),
    (img) => img.clone().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).grayscale().normalise(),
    (img) => img.clone().resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true }).grayscale().normalise().sharpen(),
  ];
  for (const variant of variants) {
    try {
      const raw = await variant(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const found = await decodeQrFromRaw(raw);
      if (found) return found;
    } catch (error) {
      console.error("[lector] QR:", error.message);
      return null;
    }
  }
  return null;
}

/* ------------------------------ OCR pool ------------------------------ */

let schedulerPromise;

function bundledLangPath() {
  try {
    return path.join(path.dirname(require.resolve("@tesseract.js-data/spa/package.json")), "4.0.0_best_int");
  } catch {
    return undefined;
  }
}

async function buildScheduler() {
  const scheduler = createScheduler();
  // Spanish model ships with the app (@tesseract.js-data/spa); no CDN download in production.
  const options = { langPath: process.env.TESSERACT_LANG_PATH || bundledLangPath(), gzip: true, cacheMethod: "none" };
  scheduler.addWorker(await createWorker("spa", 1, options));
  // Extra workers start in the background so the first scan is not delayed.
  for (let i = 1; i < OCR_WORKERS; i++) {
    createWorker("spa", 1, options).then((w) => scheduler.addWorker(w)).catch((e) => console.error("[lector] OCR worker:", e.message));
  }
  return scheduler;
}

function getScheduler() {
  schedulerPromise ||= buildScheduler().catch((error) => { schedulerPromise = null; throw error; });
  return schedulerPromise;
}

async function resetScheduler() {
  const current = schedulerPromise;
  schedulerPromise = null;
  if (current) {
    try { await (await current).terminate(); } catch { /* already gone */ }
  }
}

export async function closeDocumentReader() {
  await resetScheduler();
}

async function recognize(png, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 3000) throw new Error("La lectura del comprobante tardó demasiado.");
  try {
    const scheduler = await getScheduler();
    const result = await withTimeout(scheduler.addJob("recognize", png), Math.min(OCR_TIMEOUT_MS, remaining), "La lectura del comprobante tardó demasiado.");
    return { text: result?.data?.text || "", confidence: Number.isFinite(result?.data?.confidence) ? result.data.confidence : null };
  } catch (error) {
    // A stuck or crashed worker would break every later scan: start fresh next time.
    await resetScheduler();
    throw error;
  }
}

/**
 * "enhanced": grayscale + contrast stretch at a size Tesseract reads well (~1800–2400 px).
 * "plain": grayscale only, original size. Sharpening is avoided on purpose: in tests it
 * made Tesseract drop whole lines of the receipt.
 */
async function prepareForOcr(image, { angle = 0, mode = "enhanced" } = {}) {
  const { width = 0, height = 0 } = await image.metadata(); // image is already materialised
  let img = image.clone();
  if (angle) img = img.rotate(angle, { background: "#ffffff" });
  if (mode === "plain") return img.grayscale().png({ compressionLevel: 3 }).toBuffer();
  const longSide = Math.max(width, height);
  const target = longSide < 1600 ? 1800 : Math.min(longSide, 2400);
  return img
    .resize({ width: target, height: target, fit: "inside" })
    .grayscale()
    .normalise()
    .png({ compressionLevel: 3 })
    .toBuffer();
}

const KEY_FIELDS = ["issuer_ruc", "series", "document_number", "issue_date", "amount"];
const score = (fields) => KEY_FIELDS.filter((k) => fields[k] !== null && fields[k] !== undefined && fields[k] !== "").length;

/** OCR; when a pass finds little, retries unprocessed and then sideways/upside-down. */
const OCR_ATTEMPTS = [
  { angle: 0, mode: "enhanced" }, { angle: 0, mode: "plain" },
  { angle: 90, mode: "enhanced" }, { angle: 270, mode: "enhanced" }, { angle: 180, mode: "enhanced" },
];
async function ocrImage(image, deadline) {
  let best = null;
  for (const attempt of OCR_ATTEMPTS) {
    if (best && Date.now() > deadline - 8000) break;
    const ocr = await recognize(await prepareForOcr(image, attempt), deadline);
    const fields = parseReceiptText(ocr.text);
    const current = { ...ocr, fields, score: score(fields) };
    if (!best || current.score > best.score) best = current;
    if (best.score >= 3) break;
  }
  return best;
}

/* -------------------------------- PDF -------------------------------- */

function textFromContent(content) {
  return content.items.map((item) => (item.str || "") + (item.hasEOL ? "\n" : " ")).join("");
}

/** Text of every page (used by reports' tests too). */
export async function extractPdfText(buffer, { maxPages = Infinity } = {}) {
  const loading = getDocument({ ...PDF_OPTIONS, data: new Uint8Array(buffer) });
  try {
    const doc = await loading.promise;
    const pages = [];
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      pages.push(textFromContent(await (await doc.getPage(n)).getTextContent()));
    }
    return { text: pages.join("\n"), pages, numPages: doc.numPages };
  } finally {
    await loading.destroy();
  }
}

async function renderPage(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, RENDER_LONG_SIDE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas.toBuffer("image/png");
}

async function readPdf(buffer, deadline) {
  const loading = getDocument({ ...PDF_OPTIONS, data: new Uint8Array(buffer) });
  try {
    const doc = await withTimeout(loading.promise, 15000, "No se pudo abrir el PDF.");
    if (doc.numPages < 1) throw new Error("El PDF no tiene páginas.");
    const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
    const texts = [];
    const renders = [];
    for (let n = 1; n <= pageCount; n++) {
      const page = await doc.getPage(n);
      texts.push(textFromContent(await page.getTextContent()));
      if (n <= 2) renders.push(await renderPage(page));
    }
    const text = texts.join("\n");

    let qr = null;
    for (const png of renders) {
      qr = await findSunatQr(sharp(png));
      if (qr) break;
    }

    if (normalizeText(text).length >= 25) {
      return { source: "PDF_TEXT", text, confidence: null, qr };
    }
    if (qr) return { source: "OCR_PDF", text: "", confidence: null, qr }; // QR is enough
    // Scanned PDF: no text layer, so OCR the rendered pages.
    let best = null;
    for (const png of renders) {
      if (best && Date.now() > deadline - 8000) break;
      const result = await ocrImage(sharp(png), deadline);
      if (!best || result.score > best.score) best = result;
      if (best.score >= 4) break;
    }
    return { source: "OCR_PDF", text: best?.text || "", confidence: best?.confidence ?? null, qr };
  } finally {
    await loading.destroy();
  }
}

/* ------------------------------ Merging ------------------------------ */

function mergeFields(textFields, qr) {
  if (!qr) return { fields: textFields, from_qr: [] };
  const fields = { ...textFields };
  const fromQr = [];
  for (const key of ["issuer_ruc", "document_type", "series", "document_number", "issue_date", "amount"]) {
    if (qr[key] !== null && qr[key] !== undefined) {
      fields[key] = qr[key];
      fromQr.push(key);
    }
  }
  fields.credit_note = Boolean(qr.credit_note || textFields.credit_note);
  if (qr.credit_note) fields.document_type = null;
  return { fields, from_qr: fromQr };
}

function buildWarnings(fields, { qr, confidence, source }) {
  const warnings = [];
  if (fields.credit_note) warnings.push("El documento es una nota de crédito o débito: solo se rinden facturas o boletas.");
  if (qr && !qr.ruc_valid) warnings.push("El RUC del código QR no es válido; verifica el comprobante.");
  if (fields.currency === "USD") warnings.push("El total parece estar en dólares; las rendiciones se registran en soles (PEN).");
  if (!qr && confidence !== null && confidence < 60) warnings.push("La imagen es poco legible: verifica cada dato o sube una foto más nítida.");
  const missing = KEY_FIELDS.filter((k) => fields[k] === null || fields[k] === undefined || fields[k] === "");
  if (missing.length) {
    warnings.push(source === "OCR_PDF" && !qr && missing.length === KEY_FIELDS.length
      ? "No se pudo leer el PDF escaneado. Sube una foto nítida o completa los campos manualmente."
      : "Se detectó parte del comprobante. Revisa los campos antes de validar en SUNAT.");
  }
  return warnings;
}

/* ------------------------------- Entry -------------------------------- */

export async function readReceiptDocument(file) {
  if (!file?.buffer?.length) throw new Error("No se recibió documento.");
  const deadline = Date.now() + OCR_TIMEOUT_MS + 15000;

  let read;
  if (file.mimetype === "application/pdf") {
    read = await readPdf(file.buffer, deadline);
  } else {
    // rotate() applies the EXIF orientation of phone photos before anything else.
    let image;
    try {
      image = sharp(file.buffer, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).rotate();
      await image.clone().metadata();
    } catch {
      throw Object.assign(new Error("No se pudo abrir la imagen. Sube un JPG, PNG o WEBP válido."), { status: 400 });
    }
    const flat = sharp(await image.clone().flatten({ background: "#ffffff" }).png().toBuffer(), { limitInputPixels: MAX_INPUT_PIXELS });
    const qr = await findSunatQr(flat);
    if (qr && qr.issue_date && qr.amount) {
      read = { source: "OCR_IMAGE", text: "", confidence: null, qr }; // QR complete: skip OCR
    } else {
      const ocr = await ocrImage(flat, deadline);
      read = { source: "OCR_IMAGE", text: ocr.text, confidence: ocr.confidence, qr };
    }
  }

  const { fields, from_qr } = mergeFields(parseReceiptText(read.text), read.qr);
  const warnings = buildWarnings(fields, read);
  return {
    source: read.qr ? "QR" : read.source,
    media: file.mimetype === "application/pdf" ? "PDF" : "IMAGE",
    confidence: read.confidence,
    qr: Boolean(read.qr),
    from_qr,
    fields,
    warning: warnings.length ? warnings.join(" ") : null,
    warnings,
  };
}
