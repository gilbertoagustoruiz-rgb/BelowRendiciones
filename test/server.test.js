import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import { PGlite } from '@electric-sql/pglite';
import { setPool } from '../src/db.js';
import { ensureSchema } from '../src/schema-init.js';
import { contentDisposition, detectEvidenceType, passwordError } from '../src/security.js';
import { parseCsv } from '../src/spreadsheet-import.js';

let db, pool, server, base, app, loginLimiter;
const PASSWORD = 'Clave2026';

before(async()=>{
  process.env.DATABASE_URL ||= 'postgresql://test@localhost/test';
  db = new PGlite();
  // PGlite is one connection: serialise leases exactly like a pool with max=1.
  let queue = Promise.resolve();
  const run = (text, params = []) => (!params.length && /;\s*\S/.test(text))
    ? db.exec(text).then(results => ({ ...results.at(-1), rowCount: results.at(-1)?.affectedRows }))
    : db.query(text, params).then(r => ({ ...r, rowCount: r.affectedRows ?? r.rows.length }));
  pool = {
    query: run,
    connect: async () => {
      const previous = queue; let release;
      queue = new Promise(resolve => { release = resolve; });
      await previous;
      return { query: run, release };
    },
    end: async () => {},
  };
  setPool(pool);
  const logs = [];
  await ensureSchema({ db: pool, log: line => logs.push(line) });
  ({ app, loginLimiter } = await import('../src/server.js'));
  const hash = await bcrypt.hash(PASSWORD, 4);
  await pool.query(`
    INSERT INTO clients(id,name,ruc,responsible_person) VALUES(1,'Cliente','20123456789','Contacto');
    INSERT INTO personnel(id,full_name,document_number,profile_id,password_hash,status)
      SELECT i,'Usuario '||i,
        CASE i WHEN 6 THEN '20000004' ELSE '2000000'||i END,
        (SELECT id FROM profiles WHERE name=CASE i WHEN 1 THEN 'ADMIN' WHEN 2 THEN 'PRODUCTOR' WHEN 3 THEN 'PRODUCTOR' WHEN 4 THEN 'COORDINADOR' WHEN 5 THEN 'EJECUTIVO' ELSE 'PRODUCTOR' END),
        '${hash}','ACTIVO' FROM generate_series(1,6) i;
    SELECT setval(pg_get_serial_sequence('personnel','id'), 50);
    SELECT setval(pg_get_serial_sequence('clients','id'), 50);
    INSERT INTO projects(id,client_id,contact_name,service_type,project_code,project_name,event_location,number_of_dates,producer_id,subproducer_id,executive_id)
      VALUES(1,1,'Contacto','Evento','P001','Proyecto 1','Lima',1,2,3,5);
    INSERT INTO project_event_concepts(project_id,concept_id) SELECT 1,(SELECT MIN(id) FROM event_concepts);
    INSERT INTO advance_requests(id,company,applicant_name,applicant_personnel_id,account_number,account_type,account_holder,bank,beneficiary_document,beneficiary_name,amount,project_id,deposit_date,settlement_date,observations,expected_document_type)
      SELECT i,'BELOW SAC','Usuario '||(i+1),i+1,'1910000'||i,'AHORRO','Titular '||i,'BCP','1234567'||i,'Beneficiario '||i,500,1,CURRENT_DATE,CURRENT_DATE,'Evento','FACTURA' FROM generate_series(1,2) i;`);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async()=>{ await (await import('../src/document-reader.js')).closeDocumentReader(); if (server) await new Promise(resolve => server.close(resolve)); if (db) await db.close(); });
beforeEach(async()=>{ loginLimiter.reset(); });

async function login(document_number, password = PASSWORD, extra = {}) {
  const res = await fetch(base + '/api/auth/login', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({document_number,password,...extra}) });
  const body = await res.json();
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { res, body, cookie };
}
async function api(path, cookie, options = {}) {
  const res = await fetch(base + path, { ...options, headers: { ...(options.headers || {}), cookie } });
  const type = res.headers.get('content-type') || '';
  return { res, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

test('el PDF del anticipo (con datos bancarios) solo lo ven el solicitante y los revisores', async()=>{
  const productor2 = (await login('20000002')).cookie;
  const productor3 = (await login('20000003')).cookie;
  const admin = (await login('20000001')).cookie;
  assert.equal((await api('/api/advances/1/pdf', productor2)).res.status, 200);
  assert.equal((await api('/api/advances/1/pdf', productor3)).res.status, 404);
  assert.equal((await api('/api/advances/2/pdf', productor2)).res.status, 404);
  const pdf = await api('/api/advances/2/pdf', admin);
  assert.equal(pdf.res.status, 200); assert.equal(pdf.body.subarray(0,5).toString(), '%PDF-');
  // Listing never falls back to matching by name.
  const list = await api('/api/advances', productor3);
  assert.equal(list.body.rows.length, 1); assert.equal(Number(list.body.rows[0].id), 2);
});

test('un documento con varios perfiles debe elegir perfil; nunca entra con uno al azar', async()=>{
  const first = await login('20000004');
  assert.equal(first.res.status, 409);
  assert.equal(first.body.code, 'PROFILE_REQUIRED');
  assert.deepEqual(first.body.profiles.map(p => p.name).sort(), ['COORDINADOR','PRODUCTOR']);
  const productorId = first.body.profiles.find(p => p.name === 'PRODUCTOR').id;
  const chosen = await login('20000004', PASSWORD, { profile_id: productorId });
  assert.equal(chosen.res.status, 200); assert.equal(chosen.body.profile, 'PRODUCTOR');
  const me = await api('/api/auth/me', chosen.cookie);
  assert.equal(me.body.profile, 'PRODUCTOR');
});

test('el login bloquea intentos repetidos y responde igual si el usuario no existe', async()=>{
  for (let i = 0; i < 8; i++) assert.equal((await login('20000002', 'incorrecta1')).res.status, 401);
  const blocked = await login('20000002');
  assert.equal(blocked.res.status, 429); assert(Number(blocked.res.headers.get('retry-after')) > 0);
  assert.equal((await login('20000003')).res.status, 200, 'otra cuenta no queda bloqueada');
  const ghost = await login('99999999', 'incorrecta1');
  assert.equal(ghost.res.status, 401); assert.equal(ghost.body.error, 'Documento o contraseña incorrectos.');
});

test('cambiar la contraseña cierra las demás sesiones y exige una clave robusta', async()=>{
  const admin = (await login('20000001')).cookie;
  const victim = (await login('20000003')).cookie;
  assert.equal((await api('/api/auth/me', victim)).res.status, 200);
  const payload = { full_name:'Usuario 3', document_number:'20000003', profile_id:null, status:'ACTIVO' };
  payload.profile_id = (await pool.query("SELECT id FROM profiles WHERE name='PRODUCTOR'")).rows[0].id;
  const weak = await api('/api/personnel/3', admin, { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({ ...payload, password:'123456' }) });
  assert.equal(weak.res.status, 400);
  const ok = await api('/api/personnel/3', admin, { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({ ...payload, password:'NuevaClave99' }) });
  assert.equal(ok.res.status, 200, JSON.stringify(ok.body));
  assert.equal((await api('/api/auth/me', victim)).res.status, 401);
  assert.equal((await login('20000003', 'NuevaClave99')).res.status, 200);
  await pool.query('UPDATE personnel SET password_hash=(SELECT password_hash FROM personnel WHERE id=1) WHERE id=3');
});

test('no se puede dejar el sistema sin un ADMIN activo ni eliminarse a sí mismo', async()=>{
  const admin = (await login('20000001')).cookie;
  const adminProfile = (await pool.query("SELECT id FROM profiles WHERE name='ADMIN'")).rows[0].id;
  const res = await api('/api/personnel/1', admin, { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({ full_name:'Usuario 1', document_number:'20000001', profile_id:adminProfile, status:'INACTIVO' }) });
  assert.equal(res.res.status, 409);
  assert.equal((await api('/api/personnel/1', admin, { method:'DELETE' })).res.status, 409);
});

test('los productores solo reciben su propio registro de personal', async()=>{
  const productor = (await login('20000002')).cookie;
  const { body } = await api('/api/personnel', productor);
  assert.equal(body.length, 1); assert.equal(Number(body[0].id), 2);
  const admin = (await login('20000001')).cookie;
  assert((await api('/api/personnel', admin)).body.length >= 6);
});

test('rechaza archivos disfrazados de PDF o imagen', async()=>{
  const productor = (await login('20000002')).cookie;
  const form = new FormData();
  form.append('document', new Blob(['<html><script>alert(1)</script></html>'], { type:'application/pdf' }), 'comprobante.pdf');
  const scan = await api('/api/expenses/scan', productor, { method:'POST', body:form });
  assert.equal(scan.res.status, 400); assert.match(scan.body.error, /no es un PDF/);
  const expense = new FormData();
  for (const [k,v] of Object.entries({ project_id:1, concept_id:(await pool.query('SELECT MIN(id) AS id FROM event_concepts')).rows[0].id, producer_id:2, document_type:'01', issuer_ruc:'20987654321', series:'F001', document_number:'77', issue_date:'2026-10-01', amount:'10.50' })) expense.append(k, String(v));
  expense.append('document', new Blob(['no soy imagen'], { type:'image/png' }), 'foto.png');
  const created = await api('/api/expenses', productor, { method:'POST', body:expense });
  assert.equal(created.res.status, 400);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM expense_reports')).rows[0].n, 0);
});

test('bloquea operaciones enviadas desde otro sitio y agrega cabeceras de seguridad', async()=>{
  const admin = (await login('20000001')).cookie;
  const evil = await api('/api/clients', admin, { method:'POST', headers:{ origin:'https://atacante.example', 'content-type':'application/json' }, body:JSON.stringify({ name:'X', ruc:'20111111111', responsible_person:'Y' }) });
  assert.equal(evil.res.status, 403);
  const same = await api('/api/clients', admin, { method:'POST', headers:{ origin:base, 'content-type':'application/json' }, body:JSON.stringify({ name:'Cliente B', ruc:'20111111111', responsible_person:'Y' }) });
  assert.equal(same.res.status, 201, JSON.stringify(same.body));
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-powered-by'), null);
  const bad = await api('/api/clients', admin, { method:'POST', headers:{'content-type':'application/json'}, body:'{mal json' });
  assert.equal(bad.res.status, 400); assert.doesNotMatch(JSON.stringify(bad.body), /SyntaxError|at /);
});

test('importa clientes desde Excel y CSV con punto y coma, y rechaza .xls antiguo', async()=>{
  const admin = (await login('20000001')).cookie;
  const wb = new ExcelJS.Workbook(); const sheet = wb.addWorksheet('Clientes');
  sheet.addRow(['RUC','Razón social','Responsable']); sheet.addRow(['20222222222','Empresa Ñandú','Ana']); sheet.addRow(['123','Mal','X']);
  let form = new FormData(); form.append('file', new Blob([await wb.xlsx.writeBuffer()]), 'clientes.xlsx');
  let res = await api('/api/clients/import', admin, { method:'POST', body:form });
  assert.equal(res.res.status, 200, JSON.stringify(res.body)); assert.equal(res.body.inserted, 1); assert.equal(res.body.errors.length, 1);
  form = new FormData(); form.append('file', new Blob(['﻿RUC;CLIENTE;CONTACTO\n20333333333;"Comercial ""Sur"" SAC";Luis\n']), 'clientes.csv');
  res = await api('/api/clients/import', admin, { method:'POST', body:form });
  assert.equal(res.body.inserted, 1);
  assert.equal((await pool.query("SELECT name FROM clients WHERE ruc='20333333333'")).rows[0].name, 'Comercial "Sur" SAC');
  form = new FormData(); form.append('file', new Blob([Buffer.from([0xd0,0xcf,0x11,0xe0,1,2,3])]), 'viejo.xls');
  res = await api('/api/clients/import', admin, { method:'POST', body:form });
  assert.equal(res.res.status, 400); assert.match(res.body.error, /\.xls/);
});

test('las migraciones solo se aplican cuando cambia un archivo SQL', async()=>{
  const logs = [];
  await ensureSchema({ db: pool, log: line => logs.push(line) });
  assert.deepEqual(logs, ['Esquema PostgreSQL al día (sin cambios).']);
  await pool.query("UPDATE schema_migrations SET checksum=repeat('0',64) WHERE name='sql/workflow.sql'");
  logs.length = 0;
  await ensureSchema({ db: pool, log: line => logs.push(line) });
  assert.deepEqual(logs, ['Aplicando sql/workflow.sql…', 'Aplicando sql/finance.sql…', 'Esquema PostgreSQL actualizado.']);
});

test('utilidades de seguridad: tipos reales, nombres de archivo y contraseñas', ()=>{
  assert.equal(detectEvidenceType(Buffer.from('%PDF-1.7 x')), 'application/pdf');
  assert.equal(detectEvidenceType(Buffer.from('<svg>')), null);
  const header = contentDisposition('inline', 'Factura “Lima” 😀 ñ.pdf');
  assert.match(header, /^inline; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
  assert.doesNotThrow(() => new Headers({ 'content-disposition': header }));
  assert.equal(passwordError('Clave2026'), null);
  assert(passwordError('12345678')); assert(passwordError('corta1'));
  assert.deepEqual(parseCsv('a,b\n"1,5","x"\n'), [['a','b'],['1,5','x']]);
});

test('el endpoint de escaneo devuelve los datos del QR de SUNAT', async()=>{
  const { default: QRCode } = await import('qrcode');
  const productor = (await login('20000002')).cookie;
  const png = await QRCode.toBuffer('20987654326|03|B001|4567|0.00|45.50|2026-10-15|1|12345678|', { width: 300, margin: 4 });
  const form = new FormData(); form.append('document', new Blob([png], { type:'image/png' }), 'boleta.png');
  const { res, body } = await api('/api/expenses/scan', productor, { method:'POST', body:form });
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.source, 'QR');
  assert.deepEqual([body.fields.issuer_ruc, body.fields.document_type, body.fields.series, body.fields.document_number, body.fields.issue_date, body.fields.amount],
    ['20987654326', '03', 'B001', '4567', '2026-10-15', 45.5]);
});
