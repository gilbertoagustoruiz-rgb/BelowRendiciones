import pdf from "pdf-parse";
import { createWorker } from "tesseract.js";

let workerPromise;

function normalizeText(text="") {
  return String(text)
    .replace(/\r/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function parseMoney(raw) {
  if (!raw) return null;
  let value=String(raw).replace(/[^0-9.,]/g,"");
  if (!value) return null;

  const lastComma=value.lastIndexOf(",");
  const lastDot=value.lastIndexOf(".");
  if (lastComma > lastDot) {
    value=value.replace(/\./g,"").replace(",",".");
  } else {
    value=value.replace(/,/g,"");
  }

  const n=Number(value);
  return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : null;
}

function parseDate(raw) {
  if (!raw) return null;
  const s=String(raw).trim();
  let m=s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) {
    const [,d,mo,y]=m;
    return `${y}-${mo.padStart(2,"0")}-${d.padStart(2,"0")}`;
  }
  m=s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (m) {
    const [,y,mo,d]=m;
    return `${y}-${mo.padStart(2,"0")}-${d.padStart(2,"0")}`;
  }
  return null;
}

function extractIssuerRuc(text) {
  const ownRuc=String(process.env.SUNAT_QUERY_RUC || "").trim();
  const preferred=[...text.matchAll(/\bR\.?U\.?C\.?\s*(?:N[°ºo.]?\s*)?[:\-]?\s*(\d{11})\b/gi)]
    .map(m=>m[1])
    .filter(r=>r!==ownRuc);
  if (preferred.length) return preferred[0];

  const all=[...text.matchAll(/\b(\d{11})\b/g)]
    .map(m=>m[1])
    .filter(r=>r!==ownRuc);
  return all[0] || null;
}

function extractDocType(text, series) {
  const upper=text.toUpperCase();
  if (/BOLETA(?:\s+DE\s+VENTA)?/.test(upper)) return "03";
  if (/FACTURA/.test(upper)) return "01";
  if (series?.startsWith("B")) return "03";
  if (series?.startsWith("F")) return "01";
  return "01";
}

function extractSeriesNumber(text) {
  const upper=text.toUpperCase();

  const contextualPatterns=[
    /(?:FACTURA|BOLETA(?:\s+DE\s+VENTA)?)\s*(?:ELECTR[ÓO]NICA)?[\s\S]{0,120}?\b([A-Z0-9]{1,4})\s*[-–]\s*(\d{1,8})\b/i,
    /(?:SERIE\s*[:\-]?\s*)?\b([A-Z][A-Z0-9]{0,3})\s*[-–]\s*(\d{1,8})\b/i,
  ];

  for (const re of contextualPatterns) {
    const m=upper.match(re);
    if (m) return { series:m[1].replace(/\s/g,""), document_number:m[2] };
  }
  return { series:null, document_number:null };
}

function extractDate(text) {
  const patterns=[
    /(?:FECHA\s+(?:DE\s+)?EMISI[ÓO]N|F\.\s*EMISI[ÓO]N)\s*[:\-]?\s*(\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4})/i,
    /\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{4})\b/,
    /\b(\d{4}[\/-]\d{1,2}[\/-]\d{1,2})\b/,
  ];
  for (const re of patterns) {
    const m=text.match(re);
    if (m) {
      const parsed=parseDate(m[1]);
      if (parsed) return parsed;
    }
  }
  return null;
}

function extractTotal(text) {
  const patterns=[
    /(?:IMPORTE\s+TOTAL|TOTAL\s+A\s+PAGAR|TOTAL\s+VENTA|TOTAL)\s*(?:S\/?\.?|USD|US\$|\$)?\s*[:\-]?\s*([0-9][0-9.,]*)/gi,
  ];

  const candidates=[];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const n=parseMoney(m[1]);
      if (n) candidates.push(n);
    }
  }

  if (candidates.length) return candidates[candidates.length-1];
  return null;
}

export function parseReceiptText(rawText) {
  const text=normalizeText(rawText);
  const sn=extractSeriesNumber(text);

  return {
    issuer_ruc: extractIssuerRuc(text),
    document_type: extractDocType(text, sn.series),
    series: sn.series,
    document_number: sn.document_number,
    issue_date: extractDate(text),
    amount: extractTotal(text),
    raw_text_preview: text.slice(0,1200),
  };
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise=createWorker("spa");
  }
  return workerPromise;
}

export async function readReceiptDocument(file) {
  if (!file) throw new Error("No se recibió documento.");

  let text="";
  let source="";
  let confidence=null;

  if (file.mimetype === "application/pdf") {
    const data=await pdf(file.buffer);
    text=data.text || "";
    source="PDF_TEXT";

    if (normalizeText(text).length < 25) {
      return {
        source,
        confidence:null,
        fields:parseReceiptText(text),
        warning:"El PDF parece ser escaneado o no contiene texto extraíble. Sube una foto nítida o completa los campos manualmente.",
      };
    }
  } else {
    const worker=await getWorker();
    const result=await worker.recognize(file.buffer);
    text=result?.data?.text || "";
    confidence=Number.isFinite(result?.data?.confidence) ? result.data.confidence : null;
    source="OCR_IMAGE";
  }

  const fields=parseReceiptText(text);
  const missing=Object.entries(fields)
    .filter(([key,value])=>key!=="raw_text_preview" && (value===null || value===""))
    .map(([key])=>key);

  return {
    source,
    confidence,
    fields,
    warning: missing.length
      ? "Se detectó parte del comprobante. Revisa los campos antes de validar en SUNAT."
      : null,
  };
}
