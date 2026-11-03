import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { createWorkflowRouter, moneyCents } from '../src/workflow.js';

let db, server, base;
const users={1:{id:1,profile:'ADMIN'},2:{id:2,profile:'PRODUCTOR'},3:{id:3,profile:'SUB PRODUCTOR'},4:{id:4,profile:'COORDINADOR'},5:{id:5,profile:'EJECUTIVO'}};
before(async()=>{
  db=new PGlite();
  await db.exec(await readFile('sql/schema.sql','utf8'));
  await db.exec(await readFile('sql/workflow.sql','utf8'));
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
  app.use('/api/workflow',createWorkflowRouter(pool));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  base=`http://127.0.0.1:${server.address().port}/api/workflow`;
});
after(async()=>{if(server) await new Promise(resolve=>server.close(resolve));if(db) await db.close();});
beforeEach(async()=>{
  await db.exec(`TRUNCATE workflow_history,advance_movements,advance_expenses,expense_reports,advance_requests RESTART IDENTITY CASCADE;
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
  const res=await fetch(`${base}/${entity}/${id}/action`,{method:'POST',headers:{'content-type':'application/json','x-user':String(user)},body:JSON.stringify({action,...extra})});
  const body=await res.json();assert.equal(res.status,status,JSON.stringify(body));return body;
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
  const results=await Promise.all([0,1].map(()=>fetch(base+'/advances/1/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'DESEMBOLSAR',comment:'REF'})})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const detail=await get('/advances/1');assert.equal(detail.movements.length,1);assert.equal(detail.row.overdue,true);
});
test('migración repetible conserva saldos, estados y datos existentes',async()=>{
  await disburse();await approveExpense();await action('advances',1,'VINCULAR',1,{expense_id:1});
  await db.exec(await readFile('sql/schema.sql','utf8'));
  await db.exec(await readFile('sql/workflow.sql','utf8'));
  const detail=await get('/advances/1');assert.equal(Number(detail.row.balance),650);assert.equal(detail.row.workflow_status,'DESEMBOLSADO');
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
