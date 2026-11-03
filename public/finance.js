let api,notify,refresh,current;
const $=selector=>document.querySelector(selector);
const escape=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>value===null || value===undefined?'Sin definir':'S/ '+Number(value).toFixed(2);
const when=value=>new Date(value).toLocaleString('es-PE',{timeZone:'America/Lima'});
export function initializeFinance({request,toast,onUpdated}) {
  api=request;notify=toast;refresh=onUpdated;
  $('#closeFinance').addEventListener('click',()=>$('#financeModal').close());
  $('#reloadFinance').addEventListener('click',()=>openFinanceProject(current.project.id));
  $('#budgetForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const button=$('#budgetForm button[type="submit"]');button.disabled=true;
    $('#budgetError').textContent='';
    try {
      const rows=[...document.querySelectorAll('#budgetRows input')].map(input=>({concept_id:input.dataset.concept,amount:input.value===''?null:input.value}));
      await api(`/api/finance/projects/${current.project.id}/budget`,{method:'PUT',body:JSON.stringify({rows,revision:current.project.budget_revision,reason:$('#budgetReason').value})});
      await refresh();await openFinanceProject(current.project.id);notify('Presupuesto guardado con su historial.');
    } catch(error) {$('#budgetError').textContent=error.message;}
    finally {button.disabled=false;}
  });
}
export async function openFinanceProject(id) {
  try {
    current=await api(`/api/finance/projects/${id}`);
    const d=current,t=d.totals;
    $('#financeTitle').textContent='Presupuesto y liquidación · '+d.project.project_code;
    $('#financeProject').textContent=d.project.project_name+' · '+d.project.client_name+' · '+d.status;
    $('#financePdf').href=`/api/finance/projects/${id}/report.pdf`;
    $('#financeExcel').href=`/api/finance/projects/${id}/report.xlsx`;
    $('#financeSummary').innerHTML=[['Presupuesto',t.budget],['Gasto aprobado',t.approved],['Desembolsado',t.disbursed],['Devuelto',t.returned],['Reembolsado',t.reimbursed],['Saldo neto de anticipos',t.balance],['Por sustentar / devolver',t.pending_return],['Reembolso pendiente',t.pending_reimbursement],['Aprobado sin vincular',t.unlinked]].map(([label,value])=>`<p>${label}<strong>${money(value)}</strong></p>`).join('');
    $('#financeAlerts').textContent=`${t.exceeded_concepts} conceptos excedidos · ${t.unbudgeted_concepts} sin presupuesto · ${t.pending_expenses} rendiciones sin aprobar · ${t.missing_evidence} movimientos sin constancia · ${t.open_advances} anticipos sin liquidar.`;
    $('#budgetRows').innerHTML=d.concepts.map(c=>`<tr class="${c.exceeded?'finance-exceeded':''}"><td>${escape(c.name)}</td>
      <td><input data-concept="${c.concept_id}" aria-label="Presupuesto ${escape(c.name)} en soles" type="number" min="0" max="9999999999.99" step="0.01" value="${c.budget===null?'':escape(c.budget)}" placeholder="Sin definir"></td>
      <td>${money(c.approved)}</td><td>${money(c.pending)}</td><td>${money(c.remaining)}</td><td>${c.budget===null?'SIN PRESUPUESTO':c.exceeded?'EXCEDIDO':'DENTRO DEL PRESUPUESTO'}</td></tr>`).join('') || '<tr><td colspan="6">Asigna conceptos al proyecto para registrar un presupuesto.</td></tr>';
    $('#budgetReason').value='';$('#budgetError').textContent='';
    $('#budgetForm button[type="submit"]').disabled=!d.concepts.length;
    $('#financeAdvances').innerHTML=d.advances.map(a=>`<tr><td>#${a.id} · ${escape(a.applicant_name)}</td><td>${escape(a.workflow_status)}</td><td>${money(a.disbursed)}</td><td>${money(a.approved)}</td><td>${money(a.returned)}</td><td>${money(a.reimbursed)}</td><td>${money(a.balance)}</td></tr>`).join('') || '<tr><td colspan="7">Sin anticipos.</td></tr>';
    $('#financeExpenses').innerHTML=d.expenses.map(e=>`<tr><td>#${e.id} · ${escape(e.series)}-${escape(e.document_number)}</td><td>${escape(e.producer_name)}</td><td>${escape(e.concept_name)}</td><td>${money(e.amount)}</td><td>${escape(e.approval_status)}<br>SUNAT: ${escape(e.validation_status)}</td><td>${e.advance_id?'#'+e.advance_id:'Sin vincular'}</td><td><a target="_blank" rel="noopener" href="/api/expenses/${e.id}/file">Comprobante</a></td></tr>`).join('') || '<tr><td colspan="7">Sin rendiciones.</td></tr>';
    $('#financeMovements').innerHTML=d.movements.map(m=>`<tr><td>#${m.id} / anticipo #${m.advance_id}</td><td>${escape(m.kind)}</td><td>${money(m.amount)}</td><td>${escape(m.reference)}</td><td>${m.files.map(f=>`<a target="_blank" rel="noopener" href="/api/workflow/movement-files/${f.id}">${escape(f.file_name)}</a>`).join('<br>') || 'PENDIENTE'}</td></tr>`).join('') || '<tr><td colspan="5">Sin movimientos.</td></tr>';
    $('#budgetHistory').innerHTML=d.history.map(h=>`<div class="history-entry"><strong>${escape(h.concept_name)}</strong> · ${money(h.old_amount)} → ${money(h.new_amount)}<br>${escape(h.actor_name)} · ${escape(when(h.created_at))}<br>${escape(h.reason)}</div>`).join('') || '<p>Sin modificaciones de presupuesto.</p>';
    if(!$('#financeModal').open) $('#financeModal').showModal();
  } catch(error) {notify(error.message,true);}
}
