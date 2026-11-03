import { Router } from 'express';
import { balanceSelect, moneyCents } from './workflow.js';
import { financePdf, financeWorkbook } from './finance-export.js';

const managers=new Set(['ADMIN','COORDINADOR']);
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const cents=value=>Math.round(Number(value || 0)*100);
const sum=(rows,key)=>rows.reduce((total,row)=>total+cents(row[key]),0)/100;
const idValid=id=>/^[1-9]\d{0,17}$/.test(String(id));

export async function loadProjectFinance(db,id) {
  const project=(await db.query(`SELECT p.*,c.name AS client_name,c.ruc AS client_ruc FROM projects p
    JOIN clients c ON c.id=p.client_id WHERE p.id=$1`,[id])).rows[0];
  if(!project) fail('Proyecto no encontrado.',404);
  const concepts=(await db.query(`SELECT ec.id AS concept_id,ec.name,b.amount AS budget,
    COALESCE(e.approved,0)::numeric(12,2) AS approved,COALESCE(e.pending,0)::numeric(12,2) AS pending
    FROM project_event_concepts pc JOIN event_concepts ec ON ec.id=pc.concept_id
    LEFT JOIN project_budgets b ON b.project_id=pc.project_id AND b.concept_id=pc.concept_id
    LEFT JOIN LATERAL (SELECT SUM(amount) FILTER(WHERE approval_status='APROBADO') AS approved,
      SUM(amount) FILTER(WHERE approval_status<>'APROBADO') AS pending
      FROM expense_reports WHERE project_id=pc.project_id AND concept_id=pc.concept_id) e ON true
    WHERE pc.project_id=$1 ORDER BY ec.name,ec.id`,[id])).rows.map(r=>({...r,
      remaining:r.budget===null?null:(cents(r.budget)-cents(r.approved))/100,
      exceeded:r.budget!==null && cents(r.approved)>cents(r.budget)}));
  const advances=(await db.query(balanceSelect+' WHERE a.project_id=$1 ORDER BY a.id',[id])).rows;
  const expenses=(await db.query(`SELECT er.id,er.issue_date,er.producer_id,per.full_name AS producer_name,
    ec.name AS concept_name,er.issuer_ruc,er.series,er.document_number,er.document_type,er.amount,
    er.approval_status,er.validation_status,er.file_name,ae.advance_id
    FROM expense_reports er JOIN personnel per ON per.id=er.producer_id JOIN event_concepts ec ON ec.id=er.concept_id
    LEFT JOIN advance_expenses ae ON ae.expense_id=er.id WHERE er.project_id=$1 ORDER BY er.id`,[id])).rows;
  const movements=(await db.query(`SELECT m.*,a.applicant_name,per.full_name AS actor_name FROM advance_movements m
    JOIN advance_requests a ON a.id=m.advance_id JOIN personnel per ON per.id=m.actor_id WHERE a.project_id=$1 ORDER BY m.id`,[id])).rows;
  const files=(await db.query(`SELECT mf.id,mf.movement_id,mf.file_name,mf.file_size,mf.sha256,mf.created_at FROM movement_files mf
    JOIN advance_movements m ON m.id=mf.movement_id JOIN advance_requests a ON a.id=m.advance_id WHERE a.project_id=$1 ORDER BY mf.id`,[id])).rows;
  for(const m of movements) m.files=files.filter(f=>String(f.movement_id)===String(m.id));
  const history=(await db.query(`SELECT h.*,ec.name AS concept_name,per.full_name AS actor_name FROM budget_history h
    JOIN event_concepts ec ON ec.id=h.concept_id JOIN personnel per ON per.id=h.actor_id WHERE project_id=$1 ORDER BY h.id DESC`,[id])).rows;
  const approved=expenses.filter(e=>e.approval_status==='APROBADO');
  const totals={
    requested:sum(advances,'amount'),authorized:sum(advances.filter(a=>a.workflow_status!=='SOLICITADO'),'amount'),
    disbursed:sum(advances,'disbursed'),returned:sum(advances,'returned'),reimbursed:sum(advances,'reimbursed'),
    approved:sum(approved,'amount'),linked:sum(advances,'approved'),
    unlinked:sum(approved.filter(e=>!e.advance_id),'amount'),
    balance:sum(advances,'balance'),
    pending_return:sum(advances.filter(a=>cents(a.balance)>0),'balance'),
    pending_reimbursement:-sum(advances.filter(a=>cents(a.balance)<0),'balance'),
    budget:concepts.some(c=>c.budget!==null)?sum(concepts,'budget'):null,
    exceeded_concepts:concepts.filter(c=>c.exceeded).length,
    unbudgeted_concepts:concepts.filter(c=>c.budget===null).length,
    pending_expenses:expenses.length-approved.length,
    missing_evidence:movements.filter(m=>!m.files.length).length,
    open_advances:advances.filter(a=>a.workflow_status!=='LIQUIDADO').length,
  };
  totals.budget_remaining=totals.budget===null?null:(cents(totals.budget)-cents(totals.approved))/100;
  const status=!advances.length&&!expenses.length?'SIN MOVIMIENTOS':
    totals.open_advances || totals.pending_expenses || approved.some(e=>!e.advance_id) || totals.missing_evidence ? 'EN PROCESO' : 'CONCILIADO';
  return {project,concepts,advances,expenses,movements,history,totals,status,currency:'PEN',generated_at:new Date().toISOString()};
}

export function createFinanceRouter(pool) {
  const router=Router();
  router.use((req,res,next)=>managers.has(req.user?.profile)?next():res.status(403).json({error:'Solo ADMIN o COORDINADOR pueden consultar presupuestos y liquidaciones de proyectos.'}));
  const route=fn=>async(req,res)=>{
    try {await fn(req,res);}
    catch(error) {
      if(res.headersSent) return res.destroy(error);
      if(!error.status && !['23503','23514'].includes(error.code)) console.error(error);
      res.status(error.status || (['23503','23514'].includes(error.code)?400:500)).json({error:error.status?error.message:'No se pudo completar la operación financiera.'});
    }
  };
  async function snapshot(id) {
    if(!idValid(id)) fail('Identificador inválido.');
    const db=await pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const data=await loadProjectFinance(db,id);
      await db.query('COMMIT');return data;
    } catch(error) {await db.query('ROLLBACK');throw error;}
    finally {db.release();}
  }
  router.get('/projects',route(async(req,res)=>{
    const rows=(await pool.query(`SELECT p.id,p.project_code,p.project_name,c.name AS client_name,p.budget_revision,
      (SELECT SUM(amount) FROM project_budgets WHERE project_id=p.id) AS budget,
      COALESCE((SELECT SUM(amount) FROM expense_reports WHERE project_id=p.id AND approval_status='APROBADO'),0) AS approved
      FROM projects p JOIN clients c ON c.id=p.client_id ORDER BY p.id DESC`)).rows;
    res.json(rows);
  }));
  router.get('/projects/:id',route(async(req,res)=>res.json(await snapshot(req.params.id))));
  router.put('/projects/:id/budget',route(async(req,res)=>{
    if(!idValid(req.params.id)) fail('Identificador inválido.');
    const {rows,revision}=req.body;
    const reason=String(req.body.reason || '').trim();
    if(!reason || reason.length>2000) fail('Indica un motivo de hasta 2000 caracteres para el presupuesto.');
    if(!Array.isArray(rows) || !rows.length || rows.length>2000) fail('Ingresa los conceptos del presupuesto.');
    if(!Number.isInteger(revision) || revision<0) fail('La versión del presupuesto es inválida.');
    const seen=new Set();
    const values=rows.map(row=>{
      if(!row || typeof row!=='object' || Array.isArray(row)) fail('Cada fila debe indicar un concepto y su presupuesto.');
      if(!idValid(row.concept_id) || seen.has(String(row.concept_id))) fail('Hay conceptos inválidos o repetidos.');
      seen.add(String(row.concept_id));
      const amount=row.amount===null?null:String(row.amount);
      if(amount!==null && !/^0(?:\.0{1,2})?$/.test(amount)) moneyCents(amount);
      return {id:row.concept_id,amount:amount===null?null:(cents(amount)/100).toFixed(2)};
    });
    const db=await pool.connect();
    try {
      await db.query('BEGIN');
      const p=(await db.query('SELECT budget_revision FROM projects WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
      if(!p) fail('Proyecto no encontrado.',404);
      if(p.budget_revision!==revision) fail('El presupuesto fue modificado por otra persona. Recarga el proyecto antes de guardar.',409);
      const assigned=(await db.query('SELECT concept_id FROM project_event_concepts WHERE project_id=$1',[req.params.id])).rows;
      const valid=new Set(assigned.map(r=>String(r.concept_id)));
      for(const row of values) {
        if(!valid.has(String(row.id))) fail('El concepto no está asignado al proyecto.');
        const old=(await db.query('SELECT amount FROM project_budgets WHERE project_id=$1 AND concept_id=$2',[req.params.id,row.id])).rows[0]?.amount ?? null;
        if(old===null && row.amount===null || old!==null && row.amount!==null && cents(old)===cents(row.amount)) continue;
        if(row.amount===null) await db.query('DELETE FROM project_budgets WHERE project_id=$1 AND concept_id=$2',[req.params.id,row.id]);
        else await db.query(`INSERT INTO project_budgets(project_id,concept_id,amount) VALUES($1,$2,$3)
          ON CONFLICT(project_id,concept_id) DO UPDATE SET amount=EXCLUDED.amount,updated_at=NOW()`,[req.params.id,row.id,row.amount]);
        await db.query(`INSERT INTO budget_history(project_id,concept_id,old_amount,new_amount,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)`,[req.params.id,row.id,old,row.amount,reason,req.user.id]);
      }
      await db.query('UPDATE projects SET budget_revision=budget_revision+1 WHERE id=$1',[req.params.id]);
      await db.query('COMMIT');res.json({ok:true});
    } catch(error) {await db.query('ROLLBACK');throw error;}
    finally {db.release();}
  }));
  router.get('/projects/:id/report.pdf',route(async(req,res)=>{
    const data=await snapshot(req.params.id);
    const pdf=await financePdf(data);
    res.type('pdf').set('Content-Disposition',`attachment; filename="liquidacion-proyecto-${data.project.id}.pdf"`).send(pdf);
  }));
  router.get('/projects/:id/report.xlsx',route(async(req,res)=>{
    const data=await snapshot(req.params.id);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set('Content-Disposition',`attachment; filename="liquidacion-proyecto-${data.project.id}.xlsx"`).send(financeWorkbook(data));
  }));
  return router;
}
