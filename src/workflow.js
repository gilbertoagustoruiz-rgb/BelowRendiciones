import { Router } from 'express';
import * as evidenceStorage from './storage.js';
import { evidenceUpload, checkBankEvidence, attachBankEvidence } from './bank-evidence.js';

const reviewers = new Set(['ADMIN', 'COORDINADOR']);
const participants = new Set(['ADMIN', 'COORDINADOR', 'PRODUCTOR', 'SUB PRODUCTOR']);
const fail = (message, status=400) => { throw Object.assign(new Error(message), { status }); };
export function moneyCents(value) {
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(String(value))) fail('Ingresa un importe positivo con máximo dos decimales.');
  const [whole, decimals=''] = String(value).split('.');
  const amount = Number(whole)*100 + Number(decimals.padEnd(2,'0'));
  if (amount <= 0) fail('El importe debe ser mayor a cero.');
  return amount;
}
const cents = value => Math.round(Number(value || 0)*100);
const owns = (user, entity, row) => String(entity==='expenses' ? row.producer_id : row.applicant_personnel_id) === String(user.id);
const canRead = (user, entity, row) => reviewers.has(user.profile) || owns(user, entity, row);

export const balanceSelect = `SELECT a.*, p.project_code, p.project_name,
  COALESCE(m.disbursed,0)::numeric(12,2) AS disbursed,
  COALESCE(m.returned,0)::numeric(12,2) AS returned,
  COALESCE(m.reimbursed,0)::numeric(12,2) AS reimbursed,
  COALESCE(e.approved,0)::numeric(12,2) AS approved,
  (COALESCE(m.disbursed,0)+COALESCE(m.reimbursed,0)-COALESCE(m.returned,0)-COALESCE(e.approved,0))::numeric(12,2) AS balance,
  (a.workflow_status='DESEMBOLSADO' AND a.settlement_date < (NOW() AT TIME ZONE 'America/Lima')::date) AS overdue
  FROM advance_requests a JOIN projects p ON p.id=a.project_id
  LEFT JOIN LATERAL (SELECT
    SUM(amount) FILTER (WHERE kind='DESEMBOLSO') AS disbursed,
    SUM(amount) FILTER (WHERE kind='DEVOLUCION') AS returned,
    SUM(amount) FILTER (WHERE kind='REEMBOLSO') AS reimbursed
    FROM advance_movements WHERE advance_id=a.id) m ON true
  LEFT JOIN LATERAL (SELECT SUM(er.amount) AS approved FROM advance_expenses ae
    JOIN expense_reports er ON er.id=ae.expense_id
    WHERE ae.advance_id=a.id AND er.approval_status='APROBADO') e ON true`;

export function createWorkflowRouter(pool, storage=evidenceStorage) {
  const router = Router();
  router.use((req,res,next) => participants.has(req.user?.profile) ? next() : res.status(403).json({error:'No tienes acceso a este módulo.'}));
  const route = handler => async (req,res) => {
    try { await handler(req,res); }
    catch (error) {
      if(res.headersSent) return res.destroy(error);
      if (!error.status && !['23505','23503','23514'].includes(error.code)) console.error(error);
      res.status(error.status || (error.code==='23505' ? 409 : ['23503','23514'].includes(error.code) ? 400 : 500))
        .json({error: error.status || error.code==='23514' ? error.message : error.code==='23505' ? 'El movimiento o comprobante ya está registrado.' : error.code==='23503' ? 'El registro tiene relaciones que impiden la operación.' : 'No se pudo completar la operación.'});
    }
  };
  async function transaction(fn) {
    const db = await pool.connect();
    const savedFiles=[];
    try { await db.query('BEGIN'); const result=await fn(db,savedFiles); await db.query('COMMIT'); return result; }
    catch(error) {
      await db.query('ROLLBACK');
      const cleanup=await Promise.allSettled(savedFiles.map(file=>storage.removeEvidence(file)));
      cleanup.forEach(result=>{if(result.status==='rejected') console.error('No se pudo limpiar una carga sin registrar:',result.reason);});
      throw error;
    }
    finally { db.release(); }
  }
  async function record(db,req,entity,id,action,comment='') {
    await db.query('INSERT INTO workflow_history(entity,entity_id,action,comment,actor_id) VALUES($1,$2,$3,$4,$5)',[entity,id,action,comment,req.user.id]);
  }
  async function lock(db,entity,id,user) {
    if (!/^\d+$/.test(String(id))) fail('Identificador inválido.');
    const table=entity==='expenses' ? 'expense_reports' : 'advance_requests';
    const row=(await db.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`,[id])).rows[0];
    if (!row) fail('Registro no encontrado.',404);
    if (!canRead(user,entity,row)) fail('No tienes acceso a este registro.',403);
    return row;
  }
  function reviewer(req,row,entity) {
    if (!reviewers.has(req.user.profile)) fail('Solo ADMIN o COORDINADOR pueden revisar.',403);
    if (owns(req.user,entity,row)) fail('No puedes aprobar ni observar tu propia solicitud o rendición.',403);
  }
  const note = req => String(req.body.comment || '').trim().slice(0,2000);

  router.get('/movement-files/:id',route(async(req,res)=>{
    if(!/^\d+$/.test(req.params.id)) fail('Identificador inválido.');
    const result=await pool.query(`SELECT mf.*,a.applicant_personnel_id FROM movement_files mf
      JOIN advance_movements m ON m.id=mf.movement_id JOIN advance_requests a ON a.id=m.advance_id WHERE mf.id=$1`,[req.params.id]);
    const file=result.rows[0];
    if(!file) fail('Constancia no encontrada.',404);
    if(!canRead(req.user,'advances',file)) fail('No tienes acceso a esta constancia.',403);
    await storage.sendEvidence(res,file);
  }));

  router.post('/movements/:id/files',evidenceUpload,route(async(req,res)=>{
    if(!reviewers.has(req.user.profile)) fail('Solo ADMIN o COORDINADOR pueden adjuntar constancias.',403);
    if(!/^\d+$/.test(req.params.id)) fail('Identificador inválido.');
    if(!note(req)) fail('Indica el motivo o referencia de la constancia.');
    checkBankEvidence(req.file);
    await transaction(async(db,savedFiles)=>{
      const movement=(await db.query('SELECT * FROM advance_movements WHERE id=$1',[req.params.id])).rows[0];
      if(!movement) fail('Movimiento no encontrado.',404);
      await lock(db,'advances',movement.advance_id,req.user);
      await attachBankEvidence(db,storage,movement.id,req.file,req.user.id,savedFiles);
      await record(db,req,'advances',movement.advance_id,'CONSTANCIA_ADJUNTA','Movimiento #'+movement.id+' · '+note(req));
    });
    res.status(201).json({ok:true});
  }));

  router.get('/dashboard',route(async(req,res)=>{
    const all=reviewers.has(req.user.profile);
    const advances=(await pool.query(balanceSelect+(all ? '' : ' WHERE a.applicant_personnel_id=$1')+' ORDER BY a.settlement_date,a.id',all?[]:[req.user.id])).rows;
    const expenses=(await pool.query(`SELECT er.*,p.project_code,p.project_name,per.full_name AS producer_name,ae.advance_id
      FROM expense_reports er JOIN projects p ON p.id=er.project_id JOIN personnel per ON per.id=er.producer_id
      LEFT JOIN advance_expenses ae ON ae.expense_id=er.id
      WHERE (er.approval_status <> 'APROBADO' OR ae.expense_id IS NULL OR er.validation_status NOT IN ('VALIDADO','ANULADO','NO_EXISTE')) ${all?'':'AND er.producer_id=$1'} ORDER BY er.created_at`,all?[]:[req.user.id])).rows;
    res.json({advances,expenses});
  }));

  router.get('/:entity/:id',route(async(req,res)=>{
    const {entity,id}=req.params;
    if (!['expenses','advances'].includes(entity)) fail('Módulo inválido.');
    const result=await transaction(async db=>{
      let row=await lock(db,entity,id,req.user);
      let linked=[],movements=[],candidates=[];
      if(entity==='advances') {
        row=(await db.query(balanceSelect+' WHERE a.id=$1',[id])).rows[0];
        linked=(await db.query(`SELECT er.* FROM advance_expenses ae JOIN expense_reports er ON er.id=ae.expense_id WHERE ae.advance_id=$1 ORDER BY er.id`,[id])).rows;
        movements=(await db.query('SELECT * FROM advance_movements WHERE advance_id=$1 ORDER BY id',[id])).rows;
        const files=(await db.query(`SELECT mf.id,mf.movement_id,mf.file_name,mf.created_at FROM movement_files mf
          JOIN advance_movements m ON m.id=mf.movement_id WHERE m.advance_id=$1 ORDER BY mf.id`,[id])).rows;
        movements=movements.map(m=>({...m,files:files.filter(f=>String(f.movement_id)===String(m.id))}));
        candidates=(await db.query(`SELECT er.id,er.series,er.document_number,er.amount FROM expense_reports er
          WHERE er.project_id=$1 AND er.producer_id=$2 AND er.approval_status='APROBADO'
          AND NOT EXISTS(SELECT 1 FROM advance_expenses ae WHERE ae.expense_id=er.id) ORDER BY er.id`,[row.project_id,row.applicant_personnel_id])).rows;
      }
      const history=(await db.query(`SELECT h.*,per.full_name AS actor_name FROM workflow_history h JOIN personnel per ON per.id=h.actor_id WHERE entity=$1 AND entity_id=$2 ORDER BY h.id`,[entity,id])).rows;
      return {row,linked,movements,candidates,history};
    });
    res.json(result);
  }));

  router.post('/expenses/:id/action',route(async(req,res)=>{
    await transaction(async db=>{
      const row=await lock(db,'expenses',req.params.id,req.user);
      const action=req.body.action, comment=note(req);
      let next;
      if(action==='ENVIAR') {
        if (!['BORRADOR','OBSERVADO'].includes(row.approval_status)) fail('La rendición ya fue enviada.',409);
        if (!owns(req.user,'expenses',row) && !reviewers.has(req.user.profile)) fail('No puedes enviar esta rendición.',403);
        next='ENVIADO';
      } else if(['APROBAR','OBSERVAR'].includes(action)) {
        reviewer(req,row,'expenses');
        if(row.approval_status!=='ENVIADO') fail('Solo se revisan rendiciones enviadas.',409);
        if(action==='OBSERVAR' && !comment) fail('Indica qué debe corregirse.');
        // SUNAT and internal approval are independent; exceptions need an explicit rationale.
        if(action==='APROBAR' && row.validation_status!=='VALIDADO' && !comment) fail('SUNAT no está validado. Registra el motivo de la aprobación excepcional.');
        next=action==='APROBAR'?'APROBADO':'OBSERVADO';
      } else fail('Acción inválida.');
      await db.query('UPDATE expense_reports SET approval_status=$1 WHERE id=$2',[next,row.id]);
      await record(db,req,'expenses',row.id,next,comment);
    });
    res.json({ok:true});
  }));

  router.post('/advances/:id/action',evidenceUpload,route(async(req,res)=>{
    await transaction(async(db,savedFiles)=>{
      const row=await lock(db,'advances',req.params.id,req.user);
      const action=req.body.action,comment=note(req);
      if(!reviewers.has(req.user.profile)) fail('Solo ADMIN o COORDINADOR pueden gestionar desembolsos y conciliaciones.',403);
      const financial=['DESEMBOLSAR','DEVOLUCION','REEMBOLSO'].includes(action);
      if(financial) checkBankEvidence(req.file);
      else if(req.file) fail('Adjunta la constancia mediante un movimiento bancario.');
      let movementId;
      if(action==='APROBAR') {
        reviewer(req,row,'advances');
        if(row.workflow_status!=='SOLICITADO') fail('El anticipo ya fue aprobado.',409);
        if(!row.applicant_personnel_id) fail('Asigna un solicitante del personal antes de aprobar.');
        await db.query("UPDATE advance_requests SET workflow_status='APROBADO' WHERE id=$1",[row.id]);
      } else if(action==='DESEMBOLSAR') {
        if(row.workflow_status!=='APROBADO') fail('Primero aprueba el anticipo.',409);
        if(!comment) fail('Indica la referencia del desembolso.');
        movementId=(await db.query("INSERT INTO advance_movements(advance_id,kind,amount,reference,actor_id) VALUES($1,'DESEMBOLSO',$2,$3,$4) RETURNING id",[row.id,row.amount,comment,req.user.id])).rows[0].id;
        await db.query("UPDATE advance_requests SET workflow_status='DESEMBOLSADO' WHERE id=$1",[row.id]);
      } else {
        if(row.workflow_status!=='DESEMBOLSADO') fail('El anticipo debe estar desembolsado y abierto.',409);
        if(action==='VINCULAR') {
          const expense=await lock(db,'expenses',req.body.expense_id,req.user);
          if(expense.approval_status!=='APROBADO' || String(expense.project_id)!==String(row.project_id) || String(expense.producer_id)!==String(row.applicant_personnel_id)) fail('La rendición debe estar aprobada y corresponder al mismo proyecto y solicitante.');
          await db.query('INSERT INTO advance_expenses(expense_id,advance_id) VALUES($1,$2)',[expense.id,row.id]);
          await record(db,req,'expenses',expense.id,'VINCULADO','Anticipo #'+row.id);
        } else if(action==='DESVINCULAR') {
          if(!comment) fail('Indica el motivo de la desvinculación.');
          const removed=await db.query('DELETE FROM advance_expenses WHERE advance_id=$1 AND expense_id=$2 RETURNING expense_id',[row.id,req.body.expense_id]);
          if(!removed.rows.length) fail('La rendición no está vinculada a este anticipo.');
          await record(db,req,'expenses',req.body.expense_id,'DESVINCULADO','Anticipo #'+row.id+': '+comment);
        } else {
          const balance=cents((await db.query(balanceSelect+' WHERE a.id=$1',[row.id])).rows[0].balance);
          if(action==='LIQUIDAR') {
            if(balance!==0) fail('El saldo debe ser cero para liquidar. Registra la devolución o el reembolso pendiente.');
            const missing=await db.query(`SELECT m.id FROM advance_movements m WHERE m.advance_id=$1
              AND NOT EXISTS(SELECT 1 FROM movement_files mf WHERE mf.movement_id=m.id)`,[row.id]);
            if(missing.rows.length) fail('Adjunta las constancias de todos los movimientos antes de liquidar.');
            await db.query("UPDATE advance_requests SET workflow_status='LIQUIDADO' WHERE id=$1",[row.id]);
          } else if(['DEVOLUCION','REEMBOLSO'].includes(action)) {
            const amount=moneyCents(req.body.amount);
            if(!comment) fail('Indica la referencia del movimiento.');
            if(action==='DEVOLUCION' ? balance<=0 || amount>balance : balance>=0 || amount>-balance) fail('El importe supera el saldo pendiente o no corresponde al movimiento.');
            movementId=(await db.query('INSERT INTO advance_movements(advance_id,kind,amount,reference,actor_id) VALUES($1,$2,$3,$4,$5) RETURNING id',[row.id,action,(amount/100).toFixed(2),comment,req.user.id])).rows[0].id;
          } else fail('Acción inválida.');
        }
      }
      if(movementId) await attachBankEvidence(db,storage,movementId,req.file,req.user.id,savedFiles);
      await record(db,req,'advances',row.id,action,[comment,req.body.expense_id ? 'Rendición #'+req.body.expense_id : '',req.body.amount ? 'S/ '+req.body.amount : ''].filter(Boolean).join(' · '));
    });
    res.json({ok:true});
  }));
  return router;
}
