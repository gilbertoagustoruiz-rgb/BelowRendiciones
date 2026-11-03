import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';
import crypto from 'node:crypto';
import * as XLSX from 'xlsx';
import parsePdf from 'pdf-parse/lib/pdf-parse.js';
import { PGlite } from '@electric-sql/pglite';
import { createWorkflowRouter, moneyCents } from '../src/workflow.js';
import { createFinanceRouter, loadProjectFinance } from '../src/finance.js';
import { financePdf } from '../src/finance-export.js';

let db, server, base;
const stored=new Map();
let failStore=false;
const users={1:{id:1,profile:'ADMIN'},2:{id:2,profile:'PRODUCTOR'},3:{id:3,profile:'SUB PRODUCTOR'},4:{id:4,profile:'COORDINADOR'},5:{id:5,profile:'EJECUTIVO'}};
before(async()=>{
  db=new PGlite();
  await db.exec(await readFile('sql/schema.sql','utf8'));
  await db.exec(await readFile('sql/workflow.sql','utf8'));
  await db.exec(await readFile('sql/finance.sql','utf8'));
  await db.exec(`INSERT INTO clients(id,name,ruc,responsible_person) VALUES(1,'Cliente','20123456789','Contacto');
    INSERT INTO personnel(id,full_name,document_number,profile_id) SELECT i,'Usuario '||i,'1234567'||i,(SELECT id FROM profiles WHERE name=CASE i WHEN 1 THEN 'ADMIN' WHEN 2 THEN 'PRODUCTOR' WHEN 3 THEN 'SUB PRODUCTOR' WHEN 4 THEN 'COORDINADOR' ELSE 'EJECUTIVO' END) FROM generate_series(1,5) i;
    INSERT INTO projects(id,client_id,contact_name,service_type,project_code,project_name,event_location,number_of_dates,producer_id,subproducer_id,executive_id)
      SELECT i,1,'Contacto','Evento','P00'||i,'Proyecto '||i,'Lima',1,2,3,5 FROM generate_series(1,2) i;
    INSERT INTO project_event_concepts(project_id,concept_id) SELECT id,(SELECT MIN(id) FROM event_concepts) FROM projects;`);
  // PGlite is a real single-connection PostgreSQL engine. Serialize leases just
  // as a pool with max=1 does, including the concurrent duplicate request test.
  let queue=Promise.resolve();
  const pool={query:(...args)=>db.query(...args),connect:async()=>{
    const previous=queue; let release;
    queue=new Promise(resolve=>{release=resolve;});
    await previous;
    return {query:(...args)=>db.query(...args),release};
  }};
  const app=express();
  app.use(express.json());
  app.use((req,res,next)=>{req.user=users[req.get('x-user') || 1];next();});
  app.use('/api/workflow',createWorkflowRouter(pool,{
    async saveEvidence(file,folder){
      if(failStore) throw new Error('Storage unavailable (test)');
      const key=folder+'/'+crypto.randomUUID();stored.set(key,file);return {storage:'memory',key};
    },
    async removeEvidence(file){stored.delete(file.key);},
    async sendEvidence(res,file){res.type(file.file_mime).send(stored.get(file.file_key).buffer);},
  }));
  app.use('/api/finance',createFinanceRouter(pool));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  base=`http://127.0.0.1:${server.address().port}/api/workflow`;
});
after(async()=>{if(server) await new Promise(resolve=>server.close(resolve));if(db) await db.close();});
beforeEach(async()=>{
  stored.clear();failStore=false;
  await db.exec(`TRUNCATE project_budgets,budget_history,movement_files,workflow_history,advance_movements,advance_expenses,expense_reports,advance_requests RESTART IDENTITY CASCADE;
    UPDATE projects SET budget_revision=0;
    INSERT INTO advance_requests(id,company,applicant_name,applicant_personnel_id,account_number,account_type,account_holder,bank,beneficiary_document,beneficiary_name,amount,project_id,deposit_date,settlement_date,observations,expected_document_type)
      SELECT i,'BELOW SAC','Usuario '||CASE WHEN i=3 THEN 3 WHEN i=4 THEN 1 ELSE 2 END,CASE WHEN i=3 THEN 3 WHEN i=4 THEN 1 ELSE 2 END,'123','AHORRO','Titular','Banco','12345678','Beneficiario',CASE WHEN i=1 THEN 5000 ELSE 1000 END,1,CURRENT_DATE,CURRENT_DATE-1,'Evento','FACTURA' FROM generate_series(1,4) i;
    INSERT INTO expense_reports(id,project_id,concept_id,producer_id,document_type,issuer_ruc,series,document_number,issue_date,amount,file_name,file_mime,file_key,validation_status)
      SELECT i,CASE WHEN i=4 THEN 2 ELSE 1 END,(SELECT MIN(id) FROM event_concepts),CASE WHEN i=3 THEN 3 WHEN i=5 THEN 1 ELSE 2 END,'01','20987654321','F001',i::text,CURRENT_DATE,CASE WHEN i=1 THEN 4350 ELSE 200 END,'evidencia.pdf','application/pdf','evidencia-'||i,'VALIDADO' FROM generate_series(1,5) i;`);
});
async function get(path,user=1,status=200) {
  const res=await fetch(base+path,{headers:{'x-user':String(user)}});
  const body=await res.json();assert.equal(res.status,status,JSON.stringify(body));return body;
}
async function action(entity,id,action,user=1,extra={},status=200) {
  const bank=['DESEMBOLSAR','DEVOLUCION','REEMBOLSO'].includes(action);
  const payload=bank?bankForm({action,...extra}):JSON.stringify({action,...extra});
  const res=await fetch(`${base}/${entity}/${id}/action`,{method:'POST',headers:bank?{'x-user':String(user)}:{'content-type':'application/json','x-user':String(user)},body:payload});
  const body=await res.json();assert.equal(res.status,status,JSON.stringify(body));return body;
}
function bankForm(fields={},content='%PDF-1.4\nBank receipt for integration test',type='application/pdf') {
  const data=new FormData();
  for(const [key,value] of Object.entries(fields))data.append(key,String(value));
  data.append('document',new Blob([content],{type}),'constancia.pdf');return data;
}
async function approveExpense(id=1,user=2) {
  await action('expenses',id,'ENVIAR',user);
  await action('expenses',id,'APROBAR');
}
async function disburse(id=1) {
  await action('advances',id,'APROBAR');
  await action('advances',id,'DESEMBOLSAR',1,{comment:'Transferencia bancaria REF-001'});
}

test('importes monetarios rechazan negativos, NaN, exponentes y más de dos decimales',()=>{
  for(const value of ['0','-1','NaN','Infinity','1e3','0.001','10000000000','']) assert.throws(()=>moneyCents(value));
  assert.equal(moneyCents('4350.10'),435010);
  assert.equal(moneyCents('0.01'),1);
});
test('conciliación completa: 5000 desembolsados, 4350 aprobados, 300 devueltos, saldo 350',async()=>{
  let detail=await get('/advances/1');assert.equal(Number(detail.row.disbursed),0);
  await disburse();await approveExpense();
  await action('advances',1,'VINCULAR',1,{expense_id:1});
  await action('advances',1,'DEVOLUCION',1,{amount:'300.00',comment:'Depósito DEV-1'});
  detail=await get('/advances/1');assert.equal(Number(detail.row.balance),350);
  assert.equal(detail.linked.length,1);assert.equal(detail.movements.length,2);
  await action('advances',1,'LIQUIDAR',1,{},400);
  await action('advances',1,'DEVOLUCION',1,{amount:'350.01',comment:'Exceso'},400);
  await action('advances',1,'DEVOLUCION',1,{amount:'350',comment:'Devolución final'});
  await action('advances',1,'LIQUIDAR');
  detail=await get('/advances/1');assert.equal(detail.row.workflow_status,'LIQUIDADO');
  await action('advances',1,'DESVINCULAR',1,{expense_id:1,comment:'Intento posterior'},409);
  assert(detail.history.some(h=>h.action==='LIQUIDAR' && h.actor_name==='Usuario 1'));
});
test('observaciones, reenvío y aprobación excepcional conservan el historial',async()=>{
  await action('expenses',1,'APROBAR',1,{},409);
  await action('expenses',1,'ENVIAR',2);
  await action('expenses',1,'OBSERVAR',1,{},400);
  await action('expenses',1,'OBSERVAR',4,{comment:'Corregir importe'});
  await db.query('UPDATE expense_reports SET amount=4300 WHERE id=1');
  await action('expenses',1,'ENVIAR',2);
  await db.query("UPDATE expense_reports SET validation_status='ERROR' WHERE id=1");
  await action('expenses',1,'APROBAR',1,{},400);
  await action('expenses',1,'APROBAR',1,{comment:'Sustento revisado manualmente; consulta pendiente'});
  const detail=await get('/expenses/1');
  assert.equal(detail.row.approval_status,'APROBADO');assert.equal(detail.row.validation_status,'ERROR');
  assert.deepEqual(detail.history.map(h=>h.action),['ENVIADO','OBSERVADO','ENVIADO','APROBADO']);
});
test('permisos: cada productor ve solo lo suyo y nadie aprueba su propia solicitud',async()=>{
  const dashboard=await get('/dashboard',2);
  assert.deepEqual(dashboard.advances.map(r=>r.id),[1,2]);
  assert(dashboard.expenses.every(r=>r.producer_id===2));
  await get('/advances/3',2,403);await get('/expenses/3',2,403);
  await get('/dashboard',5,403);
  await action('advances',1,'APROBAR',2,{},403);
  await action('advances',4,'APROBAR',1,{},403);
  await action('expenses',5,'ENVIAR');await action('expenses',5,'APROBAR',1,{},403);
});
test('guardas de base de datos bloquean edición y eliminación incluso desde CRUD anterior',async()=>{
  await action('expenses',1,'ENVIAR',2);
  await assert.rejects(db.query('UPDATE expense_reports SET amount=1 WHERE id=1'),e=>e.code==='23514');
  await assert.rejects(db.query('DELETE FROM expense_reports WHERE id=1'),e=>e.code==='23514');
  await db.query("UPDATE expense_reports SET validation_status='VALIDADO' WHERE id=1");
  await disburse();
  await assert.rejects(db.query('UPDATE advance_requests SET amount=1 WHERE id=1'),e=>e.code==='23514');
  await assert.rejects(db.query('DELETE FROM advance_requests WHERE id=1'),e=>e.code==='23514');
});
test('vinculación exige aprobación, mismo proyecto y mismo solicitante; impide duplicar comprobantes',async()=>{
  await disburse();
  await action('advances',1,'VINCULAR',1,{expense_id:1},400);
  await approveExpense(3,3);await approveExpense(4,2);await approveExpense();
  await action('advances',1,'VINCULAR',1,{expense_id:3},400);
  await action('advances',1,'VINCULAR',1,{expense_id:4},400);
  await disburse(2);
  await action('advances',1,'VINCULAR',1,{expense_id:1});
  await action('advances',2,'VINCULAR',1,{expense_id:1},409);
  await action('advances',1,'DESVINCULAR',1,{expense_id:1},400);
  await action('advances',1,'DESVINCULAR',1,{expense_id:1,comment:'Anticipo incorrecto'});
  await action('advances',2,'VINCULAR',1,{expense_id:1});
});
test('gastos mayores al desembolso generan reembolso y solo se liquida tras pagarlo',async()=>{
  await disburse(2);await approveExpense();
  await action('advances',2,'VINCULAR',1,{expense_id:1});
  assert.equal(Number((await get('/advances/2')).row.balance),-3350);
  await action('advances',2,'DEVOLUCION',1,{amount:'1',comment:'Erróneo'},400);
  await action('advances',2,'REEMBOLSO',1,{amount:'3350.01',comment:'Exceso'},400);
  await action('advances',2,'REEMBOLSO',1,{amount:'3350',comment:'Transferencia reembolso'});
  await action('advances',2,'LIQUIDAR');
});
test('doble desembolso concurrente se procesa una sola vez y las solicitudes no aparecen vencidas',async()=>{
  assert((await get('/dashboard')).advances.every(a=>!a.overdue));
  await action('advances',1,'APROBAR');
  const results=await Promise.all([0,1].map(()=>fetch(base+'/advances/1/action',{method:'POST',body:bankForm({action:'DESEMBOLSAR',comment:'REF'})})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const detail=await get('/advances/1');assert.equal(detail.movements.length,1);assert.equal(detail.row.overdue,true);
});
test('migración repetible conserva saldos, estados y datos existentes',async()=>{
  await disburse();await approveExpense();await action('advances',1,'VINCULAR',1,{expense_id:1});
  const concept=(await finance('/projects/1')).concepts[0].concept_id;
  await budget([{concept_id:concept,amount:'4500'}]);
  await db.exec(await readFile('sql/schema.sql','utf8'));
  await db.exec(await readFile('sql/workflow.sql','utf8'));
  await db.exec(await readFile('sql/finance.sql','utf8'));
  const detail=await get('/advances/1');assert.equal(Number(detail.row.balance),650);assert.equal(detail.row.workflow_status,'DESEMBOLSADO');
  const report=await finance('/projects/1');assert.equal(report.totals.budget,4500);assert.equal(report.history.length,1);
  assert.equal(detail.movements[0].files.length,1);
});

async function finance(path='',user=1,status=200) {
  const res=await fetch(base.replace('/workflow','/finance')+path,{headers:{'x-user':String(user)}});
  const body=await res.json();assert.equal(res.status,status,JSON.stringify(body));return body;
}
async function budget(rows,revision=0,reason='Presupuesto autorizado',user=1,status=200) {
  const res=await fetch(base.replace('/workflow','/finance')+'/projects/1/budget',{method:'PUT',headers:{'x-user':String(user),'content-type':'application/json'},body:JSON.stringify({rows,revision,reason})});
  const body=await res.json();assert.equal(res.status,status,JSON.stringify(body));return body;
}
test('constancias obligatorias: rechaza archivo ausente, contenido falso y tamaño excesivo sin registrar pagos',async()=>{
  await action('advances',1,'APROBAR');
  const url=base+'/advances/1/action';
  const missing=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'DESEMBOLSAR',comment:'REF'})});
  assert.equal(missing.status,400);
  const fake=await fetch(url,{method:'POST',body:bankForm({action:'DESEMBOLSAR',comment:'REF'},'<html>Fake PDF</html>')});
  assert.equal(fake.status,400);
  const oversized=await fetch(url,{method:'POST',body:bankForm({action:'DESEMBOLSAR',comment:'REF'},Buffer.alloc(10*1024*1024+1))});
  assert.equal(oversized.status,400);
  assert.equal((await get('/advances/1')).movements.length,0);assert.equal(stored.size,0);
});
test('constancias permiten consulta al dueño, rechazan terceros y duplicados y conservan historial',async()=>{
  await disburse();const detail=await get('/advances/1');const movement=detail.movements[0];
  assert.equal(movement.files.length,1);
  const own=await fetch(base+'/movement-files/'+movement.files[0].id,{headers:{'x-user':'2'}});
  assert.equal(own.status,200);assert.match(await own.text(),/Bank receipt/);
  await get('/movement-files/'+movement.files[0].id,3,403);
  let res=await fetch(base+`/movements/${movement.id}/files`,{method:'POST',body:bankForm({comment:'Duplicado'})});assert.equal(res.status,409);
  res=await fetch(base+`/movements/${movement.id}/files`,{method:'POST',headers:{'x-user':'2'},body:bankForm({comment:'Carga productor'},'%PDF-1.4\nDifferent')});assert.equal(res.status,403);
  res=await fetch(base+`/movements/${movement.id}/files`,{method:'POST',body:bankForm({comment:'Respaldo adicional'},'%PDF-1.4\nAdditional proof')});assert.equal(res.status,201);
  const final=await get('/advances/1');assert.equal(final.movements[0].files.length,2);assert(final.history.some(h=>h.action==='CONSTANCIA_ADJUNTA'));
});
test('movimientos históricos necesitan constancia para liquidar y pueden recibirla sin cambiar el importe',async()=>{
  await db.exec(`UPDATE advance_requests SET workflow_status='DESEMBOLSADO' WHERE id=2;
    INSERT INTO advance_movements(advance_id,kind,amount,reference,actor_id) VALUES(2,'DESEMBOLSO',200,'Histórico',1);`);
  await approveExpense(2);await action('advances',2,'VINCULAR',1,{expense_id:2});
  await action('advances',2,'LIQUIDAR',1,{},400);
  const detail=await get('/advances/2');const movement=detail.movements[0];
  const res=await fetch(base+`/movements/${movement.id}/files`,{method:'POST',body:bankForm({comment:'Respaldo del pago anterior'})});assert.equal(res.status,201);
  await action('advances',2,'LIQUIDAR');assert.equal(Number((await get('/advances/2')).movements[0].amount),200);
});
test('error de almacenamiento revierte movimiento, estado e historial',async t=>{
  t.mock.method(console,'error',()=>{});
  await action('advances',1,'APROBAR');failStore=true;
  await action('advances',1,'DESEMBOLSAR',1,{comment:'Storage failure'},500);failStore=false;
  const detail=await get('/advances/1');assert.equal(detail.row.workflow_status,'APROBADO');assert.equal(detail.movements.length,0);
  assert(!detail.history.some(h=>h.action==='DESEMBOLSAR'));
});
test('si falla la auditoría se revierte el pago y se limpia la constancia recién cargada',async()=>{
  await action('advances',1,'APROBAR');
  await db.exec(`CREATE FUNCTION reject_test_history() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='DESEMBOLSAR' THEN RAISE EXCEPTION 'Auditoría no disponible (prueba)' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_test_history BEFORE INSERT ON workflow_history FOR EACH ROW EXECUTE FUNCTION reject_test_history();`);
  try {
    await action('advances',1,'DESEMBOLSAR',1,{comment:'Pago revertido'},400);
    const detail=await get('/advances/1');assert.equal(detail.row.workflow_status,'APROBADO');assert.equal(detail.movements.length,0);assert.equal(stored.size,0);
    assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM movement_files')).rows[0].count,0);
  } finally {await db.exec('DROP TRIGGER reject_test_history ON workflow_history; DROP FUNCTION reject_test_history();');}
});
test('presupuesto diferencia vacío y cero, conserva historial y detecta exceso sin sumar borradores',async()=>{
  let data=await finance('/projects/1');const id=data.concepts[0].concept_id;
  assert.equal(data.totals.budget,null);
  await budget([{concept_id:id,amount:'4000'}]);await approveExpense();
  data=await finance('/projects/1');assert.equal(data.totals.budget,4000);assert.equal(data.totals.approved,4350);
  assert.equal(data.totals.budget_remaining,-350);assert.equal(data.concepts[0].exceeded,true);
  assert.equal(data.history[0].reason,'Presupuesto autorizado');
  await budget([{concept_id:id,amount:'0'}],1,'Presupuesto reducido a cero');
  data=await finance('/projects/1');assert.equal(Number(data.concepts[0].budget),0);assert.equal(data.totals.unbudgeted_concepts,0);
  await budget([{concept_id:id,amount:null}],2,'Retirar presupuesto para revisión');
  data=await finance('/projects/1');assert.equal(data.concepts[0].budget,null);assert.equal(data.history.length,3);
});
test('presupuesto restringe permisos, valida conceptos y evita sobrescribir cambios concurrentes',async()=>{
  const id=(await finance('/projects/1')).concepts[0].concept_id;
  await finance('/projects',2,403);await finance('/projects/1',3,403);await finance('/projects/999',1,404);
  await budget([{concept_id:id,amount:'100'}],0,'Intento productor',2,403);
  await budget([{concept_id:id,amount:'100'}],0,'',1,400);
  await budget([{concept_id:id,amount:'-1'}],0,'Inválido',1,400);
  await budget([{concept_id:id,amount:'1.001'}],0,'Inválido',1,400);
  await budget([null],0,'Inválido',1,400);
  await budget([{concept_id:id,amount:'100'},{concept_id:999,amount:'50'}],0,'Concepto no asignado',1,400);
  assert.equal((await finance('/projects/1')).totals.budget,null);
  await budget([{concept_id:id,amount:'100'}]);
  await budget([{concept_id:id,amount:'200'}],0,'Versión obsoleta',4,409);
  assert.equal((await finance('/projects/1')).totals.budget,100);
});
test('liquidación consolida sin duplicar importes aunque un movimiento tenga varias constancias',async()=>{
  await disburse();await approveExpense();await action('advances',1,'VINCULAR',1,{expense_id:1});
  const movement=(await get('/advances/1')).movements[0];
  await fetch(base+`/movements/${movement.id}/files`,{method:'POST',body:bankForm({comment:'Adicional'},'%PDF-1.4\nExtra proof')});
  await action('advances',1,'DEVOLUCION',1,{amount:'300',comment:'DEV-300'});
  await approveExpense(2);
  const data=await finance('/projects/1');
  assert.equal(data.totals.disbursed,5000);assert.equal(data.totals.returned,300);assert.equal(data.totals.approved,4550);
  assert.equal(data.totals.linked,4350);assert.equal(data.totals.unlinked,200);assert.equal(data.totals.balance,350);
  assert.equal(data.totals.pending_return,350);assert.equal(data.totals.missing_evidence,0);assert.equal(data.status,'EN PROCESO');
});
test('descargas Excel y PDF incluyen cifras, no convierten referencias en fórmulas y respetan permisos',async()=>{
  await action('advances',1,'APROBAR');
  await action('advances',1,'DESEMBOLSAR',1,{comment:'=HYPERLINK("https://example.invalid")'});
  await approveExpense();await action('advances',1,'VINCULAR',1,{expense_id:1});
  const root=base.replace('/workflow','/finance')+'/projects/1';
  let res=await fetch(root+'/report.xlsx');assert.equal(res.status,200);
  const wb=XLSX.read(Buffer.from(await res.arrayBuffer()),{type:'buffer'});
  assert.equal(wb.SheetNames.length,7);assert.equal(wb.Sheets.Movimientos.F2.t,'s');assert.equal(wb.Sheets.Movimientos.F2.f,undefined);
  assert.equal(wb.Sheets.Movimientos.E2.v,5000);assert.equal(wb.Sheets.Rendiciones.I2.v,4350);
  res=await fetch(root+'/report.pdf');assert.equal(res.status,200);
  const pdf=Buffer.from(await res.arrayBuffer());assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
  // Legacy PDF.js requires an offset-zero typed array when reading pooled Buffers.
  const parsed=await parsePdf(Uint8Array.from(pdf));assert.match(parsed.text,/4350\.00/);assert.match(parsed.text,/5000\.00/);assert.match(parsed.text,/Presupuesto/);
  assert(parsed.numpages>=2);
  res=await fetch(root+'/report.xlsx',{headers:{'x-user':'2'}});assert.equal(res.status,403);
  res=await fetch(root+'/report.pdf',{headers:{'x-user':'3'}});assert.equal(res.status,403);
});
test('PDF extenso pagina tablas y conserva indicadores de continuación',async()=>{
  const data=await loadProjectFinance(db,1);
  data.expenses=Array.from({length:90},(_,i)=>({...data.expenses[0],id:i+1,producer_name:'Productor con nombre extenso para verificar el ajuste del texto',concept_name:'Concepto de evento con descripción extensa'}));
  const pages=[];
  const result=await parsePdf(Uint8Array.from(await financePdf(data)),{pagerender:async page=>{
    const content=await page.getTextContent();const text=content.items.map(item=>item.str).join(' ');pages.push(text);return text;
  }});
  assert(result.numpages>4);assert.match(result.text,/continuación/);
  assert.equal(pages.length,result.numpages);
  pages.forEach((text,i)=>{assert.match(text,/BELOW \| Liquidación de proyecto/);assert(text.length>300);assert(text.includes(`${i+1} / ${result.numpages}`));});
});
test('el panel conserva aprobadas sin vincular y pendientes SUNAT; evita duplicar referencias',async()=>{
  await approveExpense();
  assert((await get('/dashboard')).expenses.some(r=>r.id===1 && !r.advance_id));
  await disburse();await action('advances',1,'VINCULAR',1,{expense_id:1});
  assert(!(await get('/dashboard')).expenses.some(r=>r.id===1));
  await db.query("UPDATE expense_reports SET validation_status='ERROR' WHERE id=1");
  assert((await get('/dashboard')).expenses.some(r=>r.id===1));
  await action('advances',1,'DEVOLUCION',1,{amount:'100',comment:'REF-DEV-1'});
  await action('advances',1,'DEVOLUCION',1,{amount:'100',comment:'REF-DEV-1'},409);
  assert.equal(Number((await get('/advances/1')).row.returned),100);
});
