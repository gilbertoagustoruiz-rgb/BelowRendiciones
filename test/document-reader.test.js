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
const QR = `${EMISOR}|01|F001|00012345|190.80|1250.80|2026-10-15|6|${CLIENTE}|aGFzaA==|`;
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
  'FECHA DE EMISION: 15/10/2026', `CLIENTE RUC: ${CLIENTE}`, 'SUBTOTAL 1,060.00', 'IGV 190.80', 'IMPORTE TOTAL S/ 1,250.80'];
const EXPECTED = { issuer_ruc: EMISOR, document_type: '01', series: 'F001', document_number: '00012345', issue_date: '2026-10-15', amount: 1250.8 };
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
  const withQr = await pdfOf((doc) => { doc.fontSize(12).text(`FACTURA ELECTRONICA F001-00012345\nRUC ${EMISOR}\nFECHA DE EMISION 15/10/2026\nIMPORTE TOTAL S/ 1,205.80`); doc.image(qr, 200, 400, { width: 160 }); });
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
