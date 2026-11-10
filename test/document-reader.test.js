import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import { createCanvas } from '@napi-rs/canvas';
import { readReceiptDocument, closeDocumentReader, extractPdfText } from '../src/document-reader.js';
import { isValidRuc, parseMoney, parseDate, parseReceiptText, parseSunatQr } from '../src/receipt-parser.js';

const EMISOR = '20987654326';   // valid check digit
const CLIENTE = '20123456786';  // valid check digit
// A recent date: the reader warns about receipts older than a year.
const ISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date(Date.now() - 10 * 86400000));
const DMY = ISO.split('-').reverse().join('/');
const QR = `${EMISOR}|01|F001|00012345|190.80|1250.80|${ISO}|6|${CLIENTE}|aGFzaA==|`;
after(closeDocumentReader);

function receipt({ lines, qr = null, width = 1000, height = 1400, font = 38 }) {
  const canvas = createCanvas(width, height);
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, width, height);
  g.fillStyle = '#000'; g.font = `${font}px sans-serif`;
  lines.forEach((line, i) => g.fillText(line, 60, 90 + i * (font * 1.9)));
  const png = canvas.toBuffer('image/png');
  return qr ? sharp(png).composite([{ input: qr, left: Math.round(width / 2 - 110), top: height - 380 }]).png().toBuffer() : png;
}
const LINES = ['RESTAURANTE EL SOL S.A.C.', 'AV. LIMA-15 SAN ISIDRO', `RUC: ${EMISOR}`, 'FACTURA ELECTRONICA', 'F001-00012345',
  `FECHA DE EMISION: ${DMY}`, `CLIENTE RUC: ${CLIENTE}`, 'SUBTOTAL 1,060.00', 'IGV 190.80', 'IMPORTE TOTAL S/ 1,250.80'];
const EXPECTED = { issuer_ruc: EMISOR, document_type: '01', series: 'F001', document_number: '00012345', issue_date: ISO, amount: 1250.8 };
const pick = (fields) => Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, fields[k]]));
const pdfOf = (draw) => new Promise((resolve) => {
  const doc = new PDFDocument({ size: 'A4' }); const chunks = [];
  doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); draw(doc); doc.end();
});

test('RUC con dígito verificador, montos, fechas y QR de SUNAT', () => {
  assert(isValidRuc(EMISOR)); assert(!isValidRuc('20987654321')); assert(!isValidRuc('30987654326'));
  assert.equal(parseMoney('1,250'), 1250); assert.equal(parseMoney('S/ 1,250.80'), 1250.8);
  assert.equal(parseMoney('1.250,80'), 1250.8); assert.equal(parseMoney('12,5'), 12.5); assert.equal(parseMoney('0.500'), 0.5);
  assert.equal(parseDate('45/13/2026'), null); assert.equal(parseDate('29/02/2026'), null);
  assert.equal(parseDate('15/10/26'), '2026-10-15'); assert.equal(parseDate('15 de octubre de 2026'), '2026-10-15');
  assert.equal(parseDate('15-OCT-2026'), '2026-10-15'); assert.equal(parseDate('2026-10-15'), '2026-10-15');
  assert.deepEqual(pick(parseSunatQr(QR)), EXPECTED);
  assert.equal(parseSunatQr('000201010212yape-payment'), null);
  assert.equal(parseSunatQr(`${EMISOR}|07|F001|9|0|10|2026-10-15`).credit_note, true);
});

test('el texto no confunde dirección, cliente, subtotal, vencimiento ni ítems', () => {
  const fields = parseReceiptText([
    'TICKET', 'AV. LIMA-15 SAN ISIDRO', `CLIENTE RUC ${CLIENTE}`, 'EMISOR', `RUC ${EMISOR}`, 'B001-00004567',
    'FECHA DE VENCIMIENTO: 30/11/2026', 'FECHA DE EMISION: 15/10/2026', 'SUBTOTAL 1,060.00', 'TOTAL S/ 1,250', 'TOTAL DE ITEMS 3', 'VUELTO 4.00',
  ].join('\n'));
  assert.deepEqual(pick(fields), { issuer_ruc: EMISOR, document_type: '03', series: 'B001', document_number: '00004567', issue_date: '2026-10-15', amount: 1250 });
  assert.equal(parseReceiptText(`FACTURA F001-9\nRUC 20987654321\nTOTAL 10`).issuer_ruc, null, 'RUC mal leído no se propone');
  const usd = parseReceiptText(`FACTURA F001-9\nRUC ${EMISOR}\nIMPORTE TOTAL US$ 300.00`);
  assert.equal(usd.currency, 'USD');
});

test('lee el QR de una foto pequeña y borrosa sin pasar por OCR', async () => {
  const qr = await QRCode.toBuffer(QR, { width: 220, margin: 2 });
  const photo = await sharp(await receipt({ lines: LINES.slice(0, 3), qr })).resize(520).blur(1.2).jpeg({ quality: 55 }).toBuffer();
  const started = Date.now();
  const result = await readReceiptDocument({ buffer: photo, mimetype: 'image/jpeg' });
  assert.equal(result.source, 'QR'); assert.equal(result.qr, true);
  assert.deepEqual(pick(result.fields), EXPECTED);
  assert.equal(result.warning, null);
  assert(Date.now() - started < 5000, 'sin OCR debe ser rápido');
});

test('ignora un QR de pago (Yape/Plin) y lee el de SUNAT', async () => {
  const pay = await QRCode.toBuffer('00020101021126360014PE.YAPE.PAGOS0112987654321', { width: 200, margin: 2 });
  const sunat = await QRCode.toBuffer(QR, { width: 220, margin: 2 });
  const img = await sharp(await receipt({ lines: ['PAGA CON YAPE'] })).composite([{ input: pay, left: 60, top: 300 }, { input: sunat, left: 600, top: 900 }]).png().toBuffer();
  const result = await readReceiptDocument({ buffer: img, mimetype: 'image/png' });
  assert.deepEqual(pick(result.fields), EXPECTED);
});

test('OCR de foto sin QR, respetando la orientación EXIF del celular', async () => {
  const upright = await receipt({ lines: LINES });
  // Stored sideways with EXIF orientation 6, exactly as many phones save photos.
  const sideways = await sharp(upright).rotate(-90).jpeg({ quality: 85 }).withMetadata({ orientation: 6 }).toBuffer();
  const result = await readReceiptDocument({ buffer: sideways, mimetype: 'image/jpeg' });
  assert.equal(result.source, 'OCR_IMAGE');
  assert.deepEqual(pick(result.fields), EXPECTED);
});

test('OCR de foto girada sin datos EXIF (reintenta otras orientaciones)', async () => {
  const rotated = await sharp(await receipt({ lines: LINES })).rotate(90).jpeg({ quality: 85 }).toBuffer();
  const result = await readReceiptDocument({ buffer: rotated, mimetype: 'image/jpeg' });
  assert.deepEqual(pick(result.fields), EXPECTED);
});

test('PDF escaneado sin texto ni QR se lee con OCR', async () => {
  const photo = await sharp(await receipt({ lines: LINES })).jpeg({ quality: 80 }).toBuffer();
  const pdf = await pdfOf((doc) => doc.image(photo, 40, 40, { width: 500 }));
  assert.equal((await extractPdfText(pdf)).text.trim(), '');
  const result = await readReceiptDocument({ buffer: pdf, mimetype: 'application/pdf' });
  assert.equal(result.source, 'OCR_PDF'); assert.equal(result.media, 'PDF');
  assert.deepEqual(pick(result.fields), EXPECTED);
});

test('PDF digital: el QR manda sobre el texto, y el texto basta si no hay QR', async () => {
  const qr = await QRCode.toBuffer(QR, { width: 300, margin: 2 });
  // The text layer has a typo in the total; the QR value must win.
  const withQr = await pdfOf((doc) => { doc.fontSize(12).text(`FACTURA ELECTRONICA F001-00012345\nRUC ${EMISOR}\nFECHA DE EMISION ${DMY}\nIMPORTE TOTAL S/ 1,205.80`); doc.image(qr, 200, 400, { width: 160 }); });
  let result = await readReceiptDocument({ buffer: withQr, mimetype: 'application/pdf' });
  assert.equal(result.source, 'QR'); assert.equal(result.fields.amount, 1250.8); assert(result.from_qr.includes('amount'));
  const textOnly = await pdfOf((doc) => doc.fontSize(12).text(LINES.join('\n')));
  result = await readReceiptDocument({ buffer: textOnly, mimetype: 'application/pdf' });
  assert.equal(result.source, 'PDF_TEXT'); assert.deepEqual(pick(result.fields), EXPECTED);
});

test('avisa notas de crédito y rechaza imágenes dañadas', async () => {
  const qr = await QRCode.toBuffer(`${EMISOR}|07|F001|9|0.00|50.00|2026-10-15|6|${CLIENTE}|`, { width: 220, margin: 2 });
  const result = await readReceiptDocument({ buffer: await receipt({ lines: ['NOTA DE CREDITO'], qr }), mimetype: 'image/png' });
  assert.equal(result.fields.document_type, null); assert.match(result.warning, /nota de crédito/);
  await assert.rejects(readReceiptDocument({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0, 1, 2]), mimetype: 'image/jpeg' }), /No se pudo abrir la imagen/);
});

test('OCR resiste objetos oscuros al borde de la foto (sombra, mesa, QR cortado)', async () => {
  const clean = await receipt({ lines: LINES.slice(0, 6).concat(LINES.slice(9)), width: 900, height: 1300, font: 34 });
  const blob = await sharp({ create: { width: 30, height: 160, channels: 3, background: '#000' } }).png().toBuffer();
  const cluttered = await sharp(clean).composite([{ input: blob, left: 0, top: 300 }, { input: blob, left: 0, top: 480 }]).jpeg({ quality: 70 }).toBuffer();
  const result = await readReceiptDocument({ buffer: cluttered, mimetype: 'image/jpeg' });
  assert.deepEqual(pick(result.fields), EXPECTED);
});

// ---- v1.12: recibos por honorarios, tickets térmicos, fotos inclinadas y controles del importe ----
import { amountInWords, crossCheckTotal } from '../src/receipt-parser.js';
import { estimateRotation } from '../src/document-reader.js';

const RH_RUC = '10432187654';   // persona natural, dígito verificador válido
const BELOW = '20509876542';
const RH_LINES = ['RECIBO POR HONORARIOS ELECTRÓNICO', 'Nro: E001-245', 'QUISPE MAMANI ROSA ELENA', `RUC: ${RH_RUC}`,
  'Recibí de: BELOW TRADE S.A.C.', `Identificado con RUC número ${BELOW}`, 'La suma de: MIL QUINIENTOS CON 00/100 SOLES',
  'Por concepto de: SERVICIO DE ANIMACION DE EVENTO', `Fecha de emisión: ${DMY}`,
  'Total por honorarios:   1,500.00', 'Retención (8 %) IR:       120.00', 'Total neto recibido:  1,380.00 SOLES'];
const RH_EXPECTED = { issuer_ruc: RH_RUC, document_type: 'R1', series: 'E001', document_number: '245', issue_date: ISO, amount: 1500 };

/** Phone-like photo: tilt, uneven light and JPEG compression. */
async function photo(png, { angle = 3, width = 1500 } = {}) {
  const rotated = await sharp(png).rotate(angle, { background: '#7d7468' }).png().toBuffer();
  const { width: w, height: h } = await sharp(rotated).metadata();
  const shade = Buffer.from(`<svg width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#9a9288"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`);
  return sharp(rotated).composite([{ input: shade, blend: 'multiply' }]).resize({ width }).jpeg({ quality: 62 }).toBuffer();
}

test('parser: RH, monto en letras y control aritmético del total', () => {
  const rh = parseReceiptText(RH_LINES.join('\n'));
  assert.deepEqual(pick(rh), RH_EXPECTED, 'toma el emisor (no el RUC de "Recibí de") y el total por honorarios');
  assert.equal(rh.amount_check, 'OK');
  assert.equal(parseSunatQr(`${RH_RUC}|R1|E001|245|0.00|1500.00|${ISO}|6|${BELOW}|`).document_type, 'R1');
  assert.equal(amountInWords('SON: DOS MIL OCHOCIENTOS TREINTA Y DOS CON 00/100 SOLES'), 2832);
  assert.equal(amountInWords('SON: UN MILLON DOSCIENTAS MIL CON 50/100'), 1200000.5);
  assert.equal(amountInWords('SON: DOS MIL OCHOCIEMTOS CON 00/100'), null, 'palabra ilegible: no adivina');
  const ticket = 'BOLETA B015-1\nOP. GRAVADA S/ 174.07\nIGV 18% S/ 13.33\nTOTAL s/ 187.40\nEFECTIVO S/ 100.00\nVUELTO S/ 12.60';
  assert.deepEqual([parseReceiptText(ticket).amount, parseReceiptText(ticket).amount_check], [87.4, 'AJUSTADO'], 'quita el "1" que agrega el OCR tras S/');
  assert.equal(parseReceiptText('BOLETA B1-1\nOP. GRAVADA 127.12\nIGV 18% 22.88\nTOTAL 150.00').amount, 150, 'un total real que empieza en 1 no se toca');
  assert.equal(crossCheckTotal('OP. GRAVADA 74.07\nIGV 18% 13.33', 87.46, '87.46').check, 'NO_CUADRA', 'seis céntimos de diferencia no cuadran');
  assert.equal(parseReceiptText('BOLETA B1-1\nTOTAL s/ 87.0').amount_check, 'DUDOSO', 'un solo decimal es sospechoso');
  assert.equal(parseReceiptText('BOLETA B1-1\nOP. GRAVADA 90.91\nIGV 10% 9.09\nTOTAL 100.00').amount_check, 'OK', 'IGV de restaurantes (10%)');
});

test('estima la inclinación de la foto para enderezarla', async () => {
  const page = await receipt({ lines: LINES });
  for (const angle of [-9, -3.5, 4, 12]) {
    const tilted = sharp(await sharp(await photo(page, { angle })).png().toBuffer());
    const estimated = await estimateRotation(tilted);
    assert(Math.abs(estimated + angle) <= 0.5, `inclinación ${angle}°: estimó corregir ${estimated}°`);
  }
  assert.equal(await estimateRotation(sharp(page)), 0, 'una imagen derecha no se rota');
});

test('foto muy inclinada (9°) se endereza y se lee completa', async () => {
  const result = await readReceiptDocument({ buffer: await photo(await receipt({ lines: LINES }), { angle: 9 }), mimetype: 'image/jpeg' });
  assert.deepEqual(pick(result.fields), EXPECTED);
});

test('recibo por honorarios en PDF de SUNAT y en foto', async () => {
  const pdf = await pdfOf((doc) => doc.fontSize(11).text(RH_LINES.join('\n')));
  let result = await readReceiptDocument({ buffer: pdf, mimetype: 'application/pdf' });
  assert.equal(result.source, 'PDF_TEXT');
  assert.deepEqual({ ...pick(result.fields), document_number: result.fields.document_number }, RH_EXPECTED);
  assert.match(result.note, /total por honorarios/);
  result = await readReceiptDocument({ buffer: await photo(await receipt({ lines: RH_LINES, width: 1400, height: 1500, font: 32 })), mimetype: 'image/jpeg' });
  assert.deepEqual(pick(result.fields), RH_EXPECTED);
});

test('boleta de ticket térmico (texto gris, monoespaciado) sin QR', async () => {
  const lines = ['MINIMARKET DON LUCHO E.I.R.L.', 'RUC: 20611223341', 'BOLETA DE VENTA ELECTRONICA', 'B015-00128733', `FECHA: ${DMY}  HORA: 14:22`,
    'AGUA SAN LUIS X24    31.90', 'GASEOSA 3L           12.50', 'HIELO BOLSA X3       15.00', '------------------------',
    'OP. GRAVADA  S/   74.07', 'IGV 18%      S/   13.33', 'TOTAL        S/   87.40', 'EFECTIVO     S/  100.00', 'VUELTO       S/   12.60'];
  const canvas = createCanvas(576, 900); const g = canvas.getContext('2d');
  g.fillStyle = '#f2f0ea'; g.fillRect(0, 0, 576, 900); g.fillStyle = '#4a4a4a'; g.font = '20px DejaVu Sans Mono, monospace';
  lines.forEach((line, i) => g.fillText(line, 24, 50 + i * 32));
  const result = await readReceiptDocument({ buffer: await photo(canvas.toBuffer('image/png'), { angle: -3, width: 1000 }), mimetype: 'image/jpeg' });
  assert.deepEqual(pick(result.fields), { issuer_ruc: '20611223341', document_type: '03', series: 'B015', document_number: '00128733', issue_date: ISO, amount: 87.4 });
});
