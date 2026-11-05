import ExcelJS from "exceljs";

const MAX_ROWS = 20000;
const MAX_COLUMNS = 60;

export class ImportFormatError extends Error {}

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
    if ("result" in value) return cellText(value.result);
    if ("text" in value) return cellText(value.text);
    if ("error" in value) return "";
    return "";
  }
  return String(value);
}

function rowsToObjects(matrix) {
  const nonEmpty = matrix.filter((row) => row.some((v) => String(v).trim() !== ""));
  if (!nonEmpty.length) return [];
  const [header, ...body] = nonEmpty;
  if (body.length > MAX_ROWS) throw new ImportFormatError(`El archivo supera el máximo de ${MAX_ROWS} filas.`);
  const keys = header.slice(0, MAX_COLUMNS).map((h) => String(h).trim());
  return body.map((row) => Object.fromEntries(keys.map((key, i) => [key, String(row[i] ?? "").trim()]).filter(([key]) => key)));
}

/** Minimal RFC 4180 parser; accepts comma or semicolon (Excel in Spanish uses ";"). */
export function parseCsv(text) {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] || "";
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && clean[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
      if (rows.length > MAX_ROWS + 1) throw new ImportFormatError(`El archivo supera el máximo de ${MAX_ROWS} filas.`);
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Reads the first sheet of an .xlsx or a .csv file into objects keyed by header. */
export async function readSpreadsheetRows(file) {
  const buffer = file?.buffer;
  if (!buffer?.length) throw new ImportFormatError("El archivo está vacío.");
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  const isOle = buffer.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  if (isOle) throw new ImportFormatError("El formato .xls antiguo no es compatible. Guarda el archivo como .xlsx o .csv.");

  if (isZip) {
    const workbook = new ExcelJS.Workbook();
    try { await workbook.xlsx.load(buffer); }
    catch { throw new ImportFormatError("No se pudo leer el Excel. Verifica que sea un archivo .xlsx válido."); }
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new ImportFormatError("El archivo no tiene hojas.");
    if (sheet.rowCount > MAX_ROWS + 1) throw new ImportFormatError(`El archivo supera el máximo de ${MAX_ROWS} filas.`);
    const matrix = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = [];
      for (let c = 1; c <= Math.min(row.cellCount, MAX_COLUMNS); c++) values.push(cellText(row.getCell(c).value));
      matrix.push(values);
    });
    return rowsToObjects(matrix);
  }

  if (buffer.includes(0)) throw new ImportFormatError("El archivo no es un Excel (.xlsx) ni un CSV de texto.");
  return rowsToObjects(parseCsv(buffer.toString("utf8")));
}
