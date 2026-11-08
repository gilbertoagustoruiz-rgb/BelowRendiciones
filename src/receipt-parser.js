// Extracts receipt data (factura / boleta) from SUNAT QR codes and from OCR/PDF text.
// Pure functions: no I/O, so they are easy to test.

const RUC_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** SUNAT RUC: valid prefix and modulo-11 check digit. Catches most OCR misreads. */
export function isValidRuc(value) {
  const ruc = String(value ?? "");
  if (!/^(10|15|16|17|20)\d{9}$/.test(ruc)) return false;
  const sum = RUC_WEIGHTS.reduce((acc, w, i) => acc + w * Number(ruc[i]), 0);
  let check = 11 - (sum % 11);
  if (check === 10) check = 0;
  if (check === 11) check = 1;
  return check === Number(ruc[10]);
}

export function normalizeText(text = "") {
  return String(text)
    .replace(/\r/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Peruvian receipts use "1,250.80"; some use "1.250,80". A lone separator followed by
 * exactly three digits is a thousands separator ("1,250" = 1250), never decimals.
 */
export function parseMoney(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).replace(/[^\d.,]/g, "").replace(/[.,]+$/, "");
  if (!/\d/.test(s)) return null;
  const hasDot = s.includes("."), hasComma = s.includes(",");
  if (hasDot && hasComma) {
    const decimal = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    s = s.split(thousands).join("").replace(decimal, ".");
  } else if (hasDot || hasComma) {
    const sep = hasDot ? "." : ",";
    const parts = s.split(sep);
    const last = parts.at(-1);
    const groupsOk = parts.slice(1).every((p) => p.length === 3) && parts[0].length >= 1 && parts[0].length <= 3;
    if (parts.length > 2) {
      if (!groupsOk) return null;
      s = parts.join("");
    } else if (last.length === 3 && parts[0] !== "0") {
      s = parts.join(""); // 1,250 → 1250
    } else if (last.length >= 1 && last.length <= 2) {
      s = parts[0] + "." + last;
    } else if (last.length === 3) {
      s = parts[0] + "." + last; // 0.500
    } else {
      return null;
    }
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n < 10_000_000 ? Number(n.toFixed(2)) : null;
}

const MONTHS = {
  ENE: 1, ENERO: 1, FEB: 2, FEBRERO: 2, MAR: 3, MARZO: 3, ABR: 4, ABRIL: 4, MAY: 5, MAYO: 5,
  JUN: 6, JUNIO: 6, JUL: 7, JULIO: 7, AGO: 8, AGOSTO: 8, SET: 9, SEP: 9, SETIEMBRE: 9,
  SEPTIEMBRE: 9, OCT: 10, OCTUBRE: 10, NOV: 11, NOVIEMBRE: 11, DIC: 12, DICIEMBRE: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

/** Returns YYYY-MM-DD only for real calendar dates in a plausible range. */
export function toIsoDate(year, month, day) {
  let y = Number(year);
  if (String(year).length === 2) y += 2000;
  const m = Number(month), d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  const maxYear = new Date().getUTCFullYear() + 1;
  if (y < 2000 || y > maxYear) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseDate(raw) {
  const s = String(raw ?? "").trim().toUpperCase();
  let m = s.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/);
  if (m) return toIsoDate(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)/);
  if (m) return toIsoDate(m[3], m[2], m[1]);
  m = s.match(new RegExp(`^(\\d{1,2})\\s*(?:DE\\s+|[-/.]\\s*)?(${MONTH_RE})\\.?\\s*(?:DE(?:L)?\\s+|[-/.]\\s*)?(\\d{4})`));
  if (m) return toIsoDate(m[3], MONTHS[m[2]], m[1]);
  return null;
}

const DATE_PATTERNS = [
  /(?<!\d)\d{4}[/.-]\d{1,2}[/.-]\d{1,2}(?!\d)/g,
  /(?<!\d)\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})(?!\d)/g,
  new RegExp(`(?<!\\d)\\d{1,2}\\s*(?:DE\\s+|[-/.]\\s*)?(?:${MONTH_RE})\\.?\\s*(?:DE(?:L)?\\s+|[-/.]\\s*)?\\d{4}(?!\\d)`, "gi"),
];

/** Prefers the date labelled "fecha de emisión" and skips due/print dates. */
function extractDate(text) {
  const found = [];
  for (const re of DATE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const iso = parseDate(m[0]);
      if (!iso) continue;
      const before = text.slice(Math.max(0, m.index - 45), m.index).toUpperCase();
      const lineBefore = before.slice(before.lastIndexOf("\n") + 1);
      let rank = 1;
      if (/EMISI[ÓO]N|F\.?\s*EMI|FEC\.?\s*EMI/.test(before)) rank = 0;
      else if (/VENC|CUOTA|IMPRES|PAGO|ENTREGA|NACIM/.test(lineBefore)) rank = 3;
      found.push({ iso, rank, index: m.index });
    }
  }
  found.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return found.find((f) => f.rank < 3)?.iso || null;
}

const CUSTOMER_CONTEXT = /(CLIENTE|ADQUIRENTE|SE[ÑN]OR(?:\(?ES\)?)?|SR(?:ES)?\.|DESTINATARIO|COMPRADOR|USUARIO|DOC\.?\s*IDENT)/;

function companyRucs() {
  return new Set(
    [process.env.SUNAT_QUERY_RUC, ...String(process.env.COMPANY_RUCS || "").split(",")]
      .map((r) => String(r || "").trim())
      .filter(Boolean)
  );
}

/** Issuer RUC: valid check digit, not one of our companies, not in the customer block. */
function extractIssuerRuc(text) {
  const own = companyRucs();
  const candidates = [];
  let previousEnd = 0;
  for (const m of text.matchAll(/(?<!\d)(\d{11})(?!\d)/g)) {
    const ruc = m[1];
    // Context starts after the previous number, so a customer label does not leak onto the next RUC.
    const before = text.slice(Math.max(previousEnd, m.index - 50), m.index).toUpperCase();
    previousEnd = m.index + ruc.length;
    if (!isValidRuc(ruc) || own.has(ruc)) continue;
    const customer = CUSTOMER_CONTEXT.test(before) && !/EMISOR|PROVEEDOR|VENDEDOR/.test(before);
    const labelled = /R\.?\s?U\.?\s?C\.?\s*(?:N[°ºO.]*)?\s*[:\-]?\s*$/.test(before);
    candidates.push({ ruc, rank: customer ? 2 : labelled ? 0 : 1, index: m.index });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return candidates.find((c) => c.rank < 2)?.ruc || null;
}

const KEYWORD_RE = /(FACTURA|BOLETA)/g;

/**
 * SUNAT electronic series are 4 characters starting with F (factura), B (boleta) or
 * E (SEE-SOL); printed receipts use 4 digits. OCR often reads "0" as "O".
 */
function extractSeriesNumber(text) {
  const upper = text.toUpperCase();
  const keywords = [...upper.matchAll(KEYWORD_RE)].map((m) => m.index);
  const nearKeyword = (index) => keywords.some((k) => index >= k && index - k <= 160);
  const candidates = [];
  const electronic = /(?<![A-Z0-9])([FBE][A-Z0-9O]{3})\s*[-–—]\s*([0-9O]{1,8})(?![0-9])/g;
  for (const m of upper.matchAll(electronic)) {
    const series = m[1][0] + m[1].slice(1).replace(/O/g, "0");
    if (!/^[FBE](?=.*\d)[A-Z0-9]{3}$/.test(series)) continue;
    candidates.push({ series, number: m[2].replace(/O/g, "0"), rank: nearKeyword(m.index) ? 0 : 1, index: m.index });
  }
  const printed = /(?:N[°ºO.]*|NRO\.?|SERIE)\s*[:\-]?\s*(\d{4})\s*[-–—]\s*(\d{1,8})(?![\d/.-])/g;
  for (const m of upper.matchAll(printed)) {
    candidates.push({ series: m[1], number: m[2], rank: 2, index: m.index });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.index - b.index);
  const best = candidates[0];
  return best ? { series: best.series, document_number: best.number } : { series: null, document_number: null };
}

const CREDIT_NOTE = /NOTA\s+(?:DE\s+)?(?:CR[ÉE]DITO|D[ÉE]BITO)/i;

function extractDocType(text, series) {
  if (CREDIT_NOTE.test(text)) return null;
  if (series?.startsWith("F")) return "01";
  if (series?.startsWith("B")) return "03";
  const upper = text.toUpperCase();
  const factura = upper.search(/FACTURA/), boleta = upper.search(/BOLETA/);
  if (factura < 0 && boleta < 0) return null;
  if (factura < 0) return "03";
  if (boleta < 0) return "01";
  return factura < boleta ? "01" : "03";
}

const AMOUNT = "([0-9][0-9.,]*[0-9]|[0-9])";
const GAP = "[^0-9\\n]{0,24}?";
const NOT_TOTAL = "(?!\\s*(?:DE\\s+)?(?:ITEMS?|ART|UNID|CANT|IGV|I\\.G\\.V|ISC|DSCTO|DESC|GRAV|EXON|INAF|GRAT|ANTIC|PAGAD|RECIB|VUELTO|CUOTA|PUNTOS|BULTOS|KG|PESO|PERCEP|RETEN))";
const TOTAL_PATTERNS = [
  { rank: 0, re: new RegExp(`(?:IMPORTE\\s+TOTAL|TOTAL\\s+A\\s+PAGAR|TOTAL\\s+VENTA|MONTO\\s+TOTAL|TOTAL\\s+FACTURA|TOTAL\\s+BOLETA|TOTAL\\s+COMPROBANTE)${GAP}${AMOUNT}`, "gi") },
  { rank: 1, re: new RegExp(`(?<![A-Z.])(?<!SUB\\s?)TOTAL${NOT_TOTAL}${GAP}${AMOUNT}`, "gi") },
];

function extractTotal(text) {
  const upper = text.toUpperCase();
  const found = [];
  for (const { rank, re } of TOTAL_PATTERNS) {
    for (const m of upper.matchAll(re)) {
      const amount = parseMoney(m[1]);
      if (!amount) continue;
      const usd = /US\$|USD|D[ÓO]LAR/.test(m[0]);
      found.push({ amount, rank, usd });
    }
    if (found.length) break; // keep only the most specific label that appears
  }
  if (!found.length) return { amount: null, currency: null };
  const best = found.reduce((a, b) => (b.amount > a.amount ? b : a));
  return { amount: best.amount, currency: best.usd ? "USD" : "PEN" };
}

/** Reads receipt fields from free text (PDF text layer or OCR). */
export function parseReceiptText(rawText) {
  const text = normalizeText(rawText);
  const sn = extractSeriesNumber(text);
  const total = extractTotal(text);
  return {
    issuer_ruc: extractIssuerRuc(text),
    document_type: extractDocType(text, sn.series),
    series: sn.series,
    document_number: sn.document_number,
    issue_date: extractDate(text),
    amount: total.amount,
    currency: total.currency,
    credit_note: CREDIT_NOTE.test(text),
    raw_text_preview: text.slice(0, 1200),
  };
}

/**
 * SUNAT QR (Resolución 097-2012/SUNAT and later):
 * RUC | TIPO | SERIE | NUMERO | IGV | TOTAL | FECHA | TIPO DOC ADQ | NUM DOC ADQ | HASH | FIRMA
 * Returns null when the content is not a SUNAT receipt QR (e.g. a Yape/Plin payment QR).
 */
export function parseSunatQr(content) {
  const parts = String(content ?? "").trim().split("|").map((p) => p.trim());
  while (parts[0] === "") parts.shift();
  if (parts.length < 7) return null;
  const [ruc, rawType, rawSeries, rawNumber, , rawTotal, rawDate] = parts;
  if (!/^\d{11}$/.test(ruc)) return null;
  const type = rawType.padStart(2, "0");
  if (!["01", "03", "07", "08"].includes(type)) return null;
  const series = rawSeries.toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(series) || !/^\d{1,8}$/.test(rawNumber)) return null;
  const total = Number(rawTotal.replace(/,/g, ""));
  const date = parseDate(rawDate);
  return {
    issuer_ruc: ruc,
    ruc_valid: isValidRuc(ruc),
    document_type: ["01", "03"].includes(type) ? type : null,
    credit_note: ["07", "08"].includes(type),
    series,
    document_number: rawNumber,
    issue_date: date,
    amount: Number.isFinite(total) && total > 0 ? Number(total.toFixed(2)) : null,
    customer_document: parts[8] || null,
  };
}
