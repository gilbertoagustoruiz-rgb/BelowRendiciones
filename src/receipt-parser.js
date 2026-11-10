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

// "Recibí de … identificado con RUC" is the customer block of a recibo por honorarios.
const CUSTOMER_CONTEXT = /(CLIENTE|ADQUIRI?ENTE|SE[ÑN]OR(?:\(?ES\)?)?|SR(?:ES)?\.|DESTINATARIO|COMPRADOR|USUARIO|DOC\.?\s*IDENT|RECIB[IÍ]\s+DE|IDENTIFICAD[OA]\s+CON)/;

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

const KEYWORD_RE = /(FACTURA|BOLETA|HONORARIOS)/g;
const HONORARIOS = /RECIBO\s+(?:POR\s+|DE\s+)?HONORARIOS/i;

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
  // Recibo por honorarios: electronic series E001… or a printed 4-digit series.
  if (HONORARIOS.test(text)) return "R1";
  const upper = text.toUpperCase();
  const factura = upper.search(/FACTURA/), boleta = upper.search(/BOLETA/);
  if (factura < 0 && boleta < 0) return null;
  if (factura < 0) return "03";
  if (boleta < 0) return "01";
  return factura < boleta ? "01" : "03";
}

const AMOUNT = "([0-9][0-9.,]*[0-9]|[0-9])";
const GAP = "[^0-9\\n]{0,24}?";
// "TOTAL NETO" (RH, after retention) and similar are not the receipt total.
const NOT_TOTAL = "(?!\\s*(?:DE\\s+)?(?:ITEMS?|ART|UNID|CANT|IGV|I\\.G\\.V|ISC|DSCTO|DESC|GRAV|EXON|INAF|GRAT|ANTIC|PAGAD|RECIB|VUELTO|CUOTA|PUNTOS|BULTOS|KG|PESO|PERCEP|RETEN|NETO))";
const TOTAL_PATTERNS = [
  // RH: "Total por honorarios" is the gross amount (before the 8% retention), the one SUNAT validates.
  { rank: 0, re: new RegExp(`TOTAL\\s+(?:POR\\s+|DE\\s+)?HONORARIOS${GAP}${AMOUNT}`, "gi") },
  { rank: 1, re: new RegExp(`(?:IMPORTE\\s+TOTAL|TOTAL\\s+A\\s+PAGAR|TOTAL\\s+VENTA|MONTO\\s+TOTAL|TOTAL\\s+FACTURA|TOTAL\\s+BOLETA|TOTAL\\s+COMPROBANTE)${GAP}${AMOUNT}`, "gi") },
  { rank: 2, re: new RegExp(`(?<![A-Z.])(?<!SUB\\s?)TOTAL${NOT_TOTAL}${GAP}${AMOUNT}`, "gi") },
];

function extractTotal(text) {
  const upper = text.toUpperCase();
  const found = [];
  for (const { rank, re } of TOTAL_PATTERNS) {
    for (const m of upper.matchAll(re)) {
      const amount = parseMoney(m[1]);
      if (!amount) continue;
      const usd = /US\$|USD|D[ÓO]LAR/.test(m[0]);
      found.push({ amount, rank, usd, raw: m[1] });
    }
    if (found.length) break; // keep only the most specific label that appears
  }
  if (!found.length) return { amount: null, currency: null, raw: null };
  const best = found.reduce((a, b) => (b.amount > a.amount ? b : a));
  return { amount: best.amount, currency: best.usd ? "USD" : "PEN", raw: best.raw };
}

/* ---------- Arithmetic cross-check of the total ---------- */

const AMT = "([0-9][0-9.,]*[0-9]|[0-9])";
const LABELLED = {
  base: new RegExp(`(?:OP\\.?\\s*GRAVADAS?|OPERACI[OÓ]N(?:ES)?\\s+GRAVADAS?|VALOR\\s+(?:DE\\s+)?VENTA|(?<![A-Z])SUB\\s?TOTAL)[^0-9\\n]{0,24}?${AMT}`, "i"),
  igv: new RegExp(`I\\.?\\s?G\\.?\\s?V\\.?(?:\\s*\\(?\\s*(\\d{1,2})(?:[.,]\\d+)?\\s*%\\s*\\)?)?[^0-9\\n]{0,20}?${AMT}`, "i"),
  cash: new RegExp(`(?:EFECTIVO|PAGO\\s+CON|RECIBIDO)(?!\\s*(?:DE|:?\\s*[A-Z]{3,}))[^0-9\\n]{0,20}?${AMT}`, "i"),
  change: new RegExp(`(?:VUELTO|CAMBIO)[^0-9\\n]{0,20}?${AMT}`, "i"),
  retention: new RegExp(`RETENCI[OÓ]N[^\\n]{0,30}?${AMT}(?=[^0-9%]*$)`, "im"),
  net: new RegExp(`(?:TOTAL\\s+)?NETO(?:\\s+RECIBIDO|\\s+A\\s+PAGAR)?[^0-9\\n]{0,24}?${AMT}`, "i"),
};

function labelled(text, key) {
  const m = text.match(LABELLED[key]);
  if (!m) return null;
  const raw = m[m.length - 1];
  return { value: parseMoney(raw), raw, rate: key === "igv" && m[1] && m.length > 2 ? Number(m[1]) / 100 : null };
}

/** OCR of thermal tickets often adds a "1" in the gap after "S/" ("S/   87.40" → 187.40). */
function withoutSpuriousOne(raw) {
  const digits = String(raw || "").replace(/[^\d.,]/g, "");
  return /^1\d/.test(digits) ? parseMoney(digits.slice(1)) : null;
}

// Receipts add up to the cent; one or two cents of rounding are normal (IGV per line).
const near = (a, b, tolerance = 0.02) => a !== null && b !== null && Math.abs(a - b) <= tolerance + 1e-9;

const WORD_VALUES = {
  CERO: 0, UN: 1, UNO: 1, UNA: 1, DOS: 2, TRES: 3, CUATRO: 4, CINCO: 5, SEIS: 6, SIETE: 7, OCHO: 8, NUEVE: 9,
  DIEZ: 10, ONCE: 11, DOCE: 12, TRECE: 13, CATORCE: 14, QUINCE: 15, DIECISEIS: 16, DIECISIETE: 17, DIECIOCHO: 18,
  DIECINUEVE: 19, VEINTE: 20, VEINTIUN: 21, VEINTIUNO: 21, VEINTIDOS: 22, VEINTITRES: 23, VEINTICUATRO: 24,
  VEINTICINCO: 25, VEINTISEIS: 26, VEINTISIETE: 27, VEINTIOCHO: 28, VEINTINUEVE: 29, TREINTA: 30, CUARENTA: 40,
  CINCUENTA: 50, SESENTA: 60, SETENTA: 70, OCHENTA: 80, NOVENTA: 90, CIEN: 100, CIENTO: 100, DOSCIENTOS: 200,
  TRESCIENTOS: 300, CUATROCIENTOS: 400, QUINIENTOS: 500, SEISCIENTOS: 600, SETECIENTOS: 700, OCHOCIENTOS: 800,
  NOVECIENTOS: 900,
};

/** "SON: DOS MIL OCHOCIENTOS TREINTA Y DOS CON 00/100 SOLES" → 2832. Null if any word is unknown. */
export function amountInWords(text) {
  const m = String(text).toUpperCase().match(/(?:\bSON|LA\s+SUMA\s+DE|IMPORTE\s+EN\s+LETRAS)\s*:?\s*([A-ZÁÉÍÓÚÑ ]+?)\s+CON\s+(\d{1,2})\s*\/\s*100/);
  if (!m) return null;
  const words = m[1].normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\s+/).filter((w) => w && w !== "Y");
  let total = 0, current = 0;
  for (const raw of words) {
    const w = raw.replace(/AS$/, "OS"); // DOSCIENTAS → DOSCIENTOS
    if (w === "MIL") { total += (current || 1) * 1000; current = 0; }
    else if (w === "MILLON" || w === "MILLONES") { total += (current || 1) * 1_000_000; current = 0; }
    else if (w in WORD_VALUES) current += WORD_VALUES[w];
    else return null;
  }
  const value = total + current + Number(m[2]) / 100;
  return value > 0 ? Number(value.toFixed(2)) : null;
}

/**
 * Checks the total against the receipt's own figures: base + IGV, the IGV rate, cash − change,
 * and for RH the 8% retention. Returns the amount that agrees with them and how it was checked.
 */
export function crossCheckTotal(text, amount, rawAmount) {
  if (amount === null) return { amount, check: null };
  const base = labelled(text, "base"), igv = labelled(text, "igv"), cash = labelled(text, "cash"),
    change = labelled(text, "change"), retention = labelled(text, "retention"), net = labelled(text, "net");
  const bases = [base?.value, withoutSpuriousOne(base?.raw)].filter((v) => v !== null && v !== undefined);
  const rates = igv?.rate ? [igv.rate] : [0.18, 0.10, 0.105];
  const tests = [];
  if (bases.length && igv?.value) tests.push((t) => bases.some((b) => near(b + igv.value, t)));
  // Rate check only without a base: the total implied by the IGV is less precise than base + IGV.
  if (igv?.value && !bases.length) tests.push((t) => rates.some((r) => near((igv.value * (1 + r)) / r, t, 0.05)));
  if (cash?.value && change?.value !== null && change?.value !== undefined && cash.value > change.value) tests.push((t) => near(cash.value - change.value, t));
  if (retention?.value && net?.value && HONORARIOS.test(text)) tests.push((t) => near(net.value + retention.value, t));
  const words = amountInWords(text);
  if (words) tests.push((t) => near(words, t, 0.005));
  // Totals are printed with two decimals; "87.0" means OCR lost a digit.
  const oneDecimal = /[.,]\d$/.test(String(rawAmount || "").trim());
  if (!tests.length) return { amount, check: oneDecimal ? "DUDOSO" : null };
  const score = (t) => tests.filter((fn) => fn(t)).length;
  const original = score(amount);
  const alternative = withoutSpuriousOne(rawAmount);
  if (alternative && score(alternative) > original) return { amount: alternative, check: "AJUSTADO" };
  // Nothing agrees with the digits read, but the amount in words parsed cleanly: prefer it.
  if (original === 0 && words && score(words) > 0) return { amount: words, check: "AJUSTADO" };
  return { amount, check: original > 0 ? "OK" : "NO_CUADRA" };
}

/** Reads receipt fields from free text (PDF text layer or OCR). */
export function parseReceiptText(rawText) {
  const text = normalizeText(rawText);
  const sn = extractSeriesNumber(text);
  const total = extractTotal(text);
  const checked = crossCheckTotal(text, total.amount, total.raw);
  return {
    issuer_ruc: extractIssuerRuc(text),
    document_type: extractDocType(text, sn.series),
    series: sn.series,
    document_number: sn.document_number,
    issue_date: extractDate(text),
    amount: checked.amount,
    amount_check: checked.check,
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
  const type = rawType.toUpperCase().padStart(2, "0");
  if (!["01", "03", "07", "08", "R1", "R7"].includes(type)) return null;
  const series = rawSeries.toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(series) || !/^\d{1,8}$/.test(rawNumber)) return null;
  const total = Number(rawTotal.replace(/,/g, ""));
  const date = parseDate(rawDate);
  return {
    issuer_ruc: ruc,
    ruc_valid: isValidRuc(ruc),
    document_type: ["01", "03", "R1"].includes(type) ? type : null,
    credit_note: ["07", "08", "R7"].includes(type),
    series,
    document_number: rawNumber,
    issue_date: date,
    amount: Number.isFinite(total) && total > 0 ? Number(total.toFixed(2)) : null,
    customer_document: parts[8] || null,
  };
}
