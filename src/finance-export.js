import PDFDocument from 'pdfkit';
import * as XLSX from 'xlsx';

const amount=value=>value===null || value===undefined ? null : Number(value);
const money=value=>value===null || value===undefined ? 'Sin definir' : 'S/ '+Number(value).toFixed(2);
const date=value=>{
  if(!value) return '';
  const d=String(value).slice(0,10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return d?`${d[3]}/${d[2]}/${d[1]}`:String(value);
};
const stamp=value=>new Date(value).toLocaleString('es-PE',{timeZone:'America/Lima'});
export const summaryLabels={
  requested:'Anticipos solicitados',authorized:'Anticipos autorizados',disbursed:'Desembolsado',
  reimbursed:'Reembolsado',returned:'Devuelto',approved:'Gastos aprobados (total)',linked:'Gastos aprobados vinculados',
  unlinked:'Gastos aprobados sin vincular',balance:'Saldo neto de anticipos',pending_return:'Por sustentar / devolver',
  pending_reimbursement:'Reembolsos pendientes',budget:'Presupuesto definido',budget_remaining:'Presupuesto menos gastos aprobados',
};

export function financeWorkbook(data) {
  const wb=XLSX.utils.book_new();
  const add=(name,rows,widths)=>{
    const sheet=XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols']=widths.map(wch=>({wch}));
    for(const key of Object.keys(sheet)) if(!key.startsWith('!') && sheet[key].t==='n') sheet[key].z='#,##0.00';
    if(rows.length>1) sheet['!autofilter']={ref:XLSX.utils.encode_range({s:{r:0,c:0},e:{r:rows.length-1,c:rows[0].length-1}})};
    XLSX.utils.book_append_sheet(wb,sheet,name);
  };
  add('Resumen',[
    ['Liquidación de proyecto','Importe / valor'],['Código',data.project.project_code],['Proyecto',data.project.project_name],
    ['Cliente',data.project.client_name],['RUC',data.project.client_ruc],['Moneda de conciliación','PEN'],
    ['Moneda del proyecto',data.project.currency],['Estado de conciliación',data.status],['Fecha de corte (Lima)',stamp(data.generated_at)],
    ...Object.entries(summaryLabels).map(([key,label])=>[label,amount(data.totals[key])]),
    ['Conceptos sin presupuesto',String(data.totals.unbudgeted_concepts)],['Conceptos excedidos',String(data.totals.exceeded_concepts)],
    ['Rendiciones pendientes de aprobar',String(data.totals.pending_expenses)],['Movimientos sin constancia',String(data.totals.missing_evidence)],
    ['Anticipos sin liquidar',String(data.totals.open_advances)],
    ['Criterio de saldo','Desembolsado + reembolsado - devuelto - gastos aprobados vinculados.'],
    ['Importante','Saldo neto no compensa ni cierra saldos individuales. Solo se incluyen pagos registrados; la app no ejecuta transferencias.'],
    ['Presupuesto','Importes en PEN. Vacío = sin presupuesto definido; cero = presupuesto de S/ 0.00. No hay conversión automática de USD.'],
  ],[48,110]);
  add('Presupuesto',[
    ['Concepto','Presupuesto PEN','Aprobado PEN','Por aprobar PEN','Disponible PEN','Alerta'],
    ...data.concepts.map(c=>[c.name,amount(c.budget),amount(c.approved),amount(c.pending),amount(c.remaining),c.budget===null?'SIN PRESUPUESTO':c.exceeded?'EXCEDIDO':'DENTRO DEL PRESUPUESTO']),
  ],[42,22,22,22,22,30]);
  add('Anticipos',[
    ['ID','Solicitante','Estado','Solicitado PEN','Desembolsado PEN','Rendido PEN','Devuelto PEN','Reembolsado PEN','Saldo PEN','Vencimiento','Banco','Beneficiario'],
    ...data.advances.map(a=>[String(a.id),a.applicant_name,a.workflow_status,amount(a.amount),amount(a.disbursed),amount(a.approved),amount(a.returned),amount(a.reimbursed),amount(a.balance),date(a.settlement_date),a.bank,a.beneficiary_name]),
  ],[12,32,20,20,22,20,20,22,20,18,24,35]);
  add('Rendiciones',[
    ['ID','Fecha','Productor','Concepto','Tipo','RUC emisor','Serie','Número','Importe PEN','Aprobación','SUNAT','Anticipo ID','Archivo'],
    ...data.expenses.map(e=>[String(e.id),date(e.issue_date),e.producer_name,e.concept_name,e.document_type==='01'?'FACTURA':'BOLETA',e.issuer_ruc,e.series,e.document_number,amount(e.amount),e.approval_status,e.validation_status,e.advance_id?String(e.advance_id):'',e.file_name]),
  ],[12,16,32,35,15,18,12,20,20,20,28,16,45]);
  add('Movimientos',[
    ['ID','Anticipo ID','Solicitante','Tipo','Importe PEN','Referencia','Registrado por','Fecha (Lima)','Constancias'],
    ...data.movements.map(m=>[String(m.id),String(m.advance_id),m.applicant_name,m.kind,amount(m.amount),m.reference,m.actor_name,stamp(m.created_at),m.files.map(f=>'#'+f.id+' '+f.file_name).join('; ') || 'PENDIENTE']),
  ],[12,15,32,20,20,60,32,24,70]);
  add('Constancias',[
    ['ID','Movimiento ID','Nombre','SHA256','Tamaño bytes','Fecha (Lima)'],
    ...data.movements.flatMap(m=>m.files.map(f=>[String(f.id),String(m.id),f.file_name,f.sha256,String(f.file_size),stamp(f.created_at)])),
  ],[12,18,50,70,20,24]);
  add('Historial presupuesto',[
    ['Fecha (Lima)','Concepto','Anterior PEN','Nuevo PEN','Motivo','Responsable'],
    ...data.history.map(h=>[stamp(h.created_at),h.concept_name,amount(h.old_amount),amount(h.new_amount),h.reason,h.actor_name]),
  ],[24,40,22,22,80,32]);
  return XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
}

export function financePdf(data) {
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:'A4',layout:'landscape',margin:36,bufferPages:true,info:{Title:'Liquidación - '+data.project.project_code,Author:'Below Rendiciones'}});
    const chunks=[];doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
    const width=doc.page.width-72,bottom=doc.page.height-45;
    let y=0;
    function header() {
      doc.rect(0,0,doc.page.width,54).fill('#0a1f3f');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(17).text('BELOW | Liquidación de proyecto',36,17,{width:width-180,lineBreak:false});
      doc.font('Helvetica').fontSize(9).text(String(data.project.project_code).slice(0,30),doc.page.width-210,23,{width:174,align:'right',lineBreak:false});
      y=70;doc.fillColor('#172033');
    }
    function newPage(){doc.addPage();}
    // Reserve the header on every page, including pages created by PDFKit's
    // text flow. Paint headers only after all tables have finished rendering.
    doc.on('pageAdded',()=>{y=70;doc.y=70;});
    function paragraph(text,size=9) {
      doc.font('Helvetica').fontSize(size).fillColor('#334155');
      const height=doc.heightOfString(text,{width});
      if(y+height>bottom)newPage();
      doc.fontSize(size).text(text,36,y,{width});y+=height+10;
    }
    function table(title,columns,rows) {
      const widths=columns.map(c=>width*c[1]);
      if(y+75>bottom)newPage();
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#0a1f3f').text(title,36,y,{width});y+=22;
      function tableHeader(){
        let x=36;doc.rect(36,y,width,24).fill('#e7edf5');
        columns.forEach((c,i)=>{doc.fillColor('#0a1f3f').font('Helvetica-Bold').fontSize(8).text(c[0],x+5,y+6,{width:widths[i]-10,height:18});x+=widths[i];});y+=24;
      }
      tableHeader();
      if(!rows.length) {paragraph('Sin registros.');return;}
      rows.forEach((row,index)=>{
        const values=row.map(v=>String(v ?? '').replace(/[\u2010-\u2015]/g,'-')).map(v=>v.length>200?v.slice(0,197)+'...':v);
        doc.font('Helvetica').fontSize(8);
        const height=Math.max(26,...values.map((v,i)=>doc.heightOfString(v,{width:widths[i]-10})+12));
        if(y+height>bottom){newPage();doc.font('Helvetica-Bold').fontSize(11).text(title+' (continuación)',36,y,{width});y+=22;tableHeader();}
        if(index%2===0)doc.rect(36,y,width,height).fill('#f5f7fa');
        let x=36;
        values.forEach((v,i)=>{doc.font('Helvetica').fontSize(8).fillColor('#172033').text(v,x+5,y+6,{width:widths[i]-10,height:height-10});x+=widths[i];});
        y+=height;
      });
      y+=18;
    }
    y=70;doc.y=70;
    doc.font('Helvetica-Bold').fontSize(14).text(data.project.project_name,36,y,{width});y=doc.y+9;
    paragraph(`${data.project.client_name} | RUC ${data.project.client_ruc} | Corte: ${stamp(data.generated_at)} (Lima)`);
    paragraph(`Estado: ${data.status}. Moneda de conciliación: PEN. Moneda del proyecto: ${data.project.currency}. Sin conversión automática de USD.`);
    table('Resumen financiero',[['Concepto',.35],['Importe PEN',.15],['Concepto',.35],['Importe PEN',.15]],
      Object.entries(summaryLabels).filter((_,i)=>i%2===0).map(([key,label],i)=>{
        const other=Object.entries(summaryLabels)[i*2+1];return [label,money(data.totals[key]),other?.[1] || '',other?money(data.totals[other[0]]):''];
      }));
    paragraph(`Pendientes: ${data.totals.open_advances} anticipos sin liquidar; ${data.totals.pending_expenses} rendiciones sin aprobar; ${data.totals.missing_evidence} movimientos sin constancia; ${data.totals.unbudgeted_concepts} conceptos sin presupuesto; ${data.totals.exceeded_concepts} conceptos excedidos.`);
    table('Presupuesto y gasto por concepto',[['Concepto',.32],['Presupuesto',.17],['Aprobado',.17],['Disponible',.17],['Alerta',.17]],
      data.concepts.map(c=>[c.name,money(c.budget),money(c.approved),money(c.remaining),c.budget===null?'SIN PRESUPUESTO':c.exceeded?'EXCEDIDO':'DENTRO DEL PRESUPUESTO']));
    table('Anticipos y saldos individuales',[['ID / solicitante',.22],['Estado',.14],['Desembolsado',.13],['Rendido',.13],['Devuelto',.12],['Reembolsado',.13],['Saldo',.13]],
      data.advances.map(a=>['#'+a.id+' '+a.applicant_name,a.workflow_status,money(a.disbursed),money(a.approved),money(a.returned),money(a.reimbursed),money(a.balance)]));
    table('Rendiciones',[['ID / comprobante',.17],['Concepto',.18],['Productor',.17],['Importe',.12],['Aprobación',.13],['SUNAT',.13],['Anticipo',.10]],
      data.expenses.map(e=>['#'+e.id+' '+e.series+'-'+e.document_number,e.concept_name,e.producer_name,money(e.amount),e.approval_status,e.validation_status,e.advance_id?'#'+e.advance_id:'Sin vincular']));
    table('Movimientos y constancias',[['ID / anticipo',.13],['Tipo',.14],['Importe',.12],['Referencia',.29],['Constancias',.18],['Responsable',.14]],
      data.movements.map(m=>['#'+m.id+' / #'+m.advance_id,m.kind,money(m.amount),m.reference,m.files.map(f=>'#'+f.id+' '+f.file_name).join('; ') || 'PENDIENTE',m.actor_name]));
    table('Historial del presupuesto',[['Fecha (Lima)',.16],['Concepto',.21],['Anterior',.12],['Nuevo',.12],['Motivo',.25],['Responsable',.14]],
      data.history.map(h=>[stamp(h.created_at),h.concept_name,money(h.old_amount),money(h.new_amount),h.reason,h.actor_name]));
    paragraph('Saldo = desembolsado + reembolsado - devuelto - gastos aprobados vinculados. El saldo neto del proyecto no cierra saldos individuales. Los gastos aprobados sin vincular se muestran por separado. Este reporte refleja registros al corte y no ejecuta transferencias.');
    paragraph('Las referencias extensas se abrevian en PDF; Excel conserva el detalle completo. Las constancias se consultan desde la aplicación mediante su identificador.');
    const pages=doc.bufferedPageRange();
    for(let i=0;i<pages.count;i++){
      doc.switchToPage(i);
      const originalBottom=doc.page.margins.bottom;
      doc.page.margins.bottom=0;
      header();
      doc.font('Helvetica').fontSize(8).fillColor('#64748b');
      doc.text('Below Rendiciones | Importes en PEN',36,doc.page.height-26,{lineBreak:false});
      doc.text(`${i+1} / ${pages.count}`,doc.page.width-100,doc.page.height-26,{width:64,align:'right',lineBreak:false});
      doc.page.margins.bottom=originalBottom;
    }
    doc.end();
  });
}
