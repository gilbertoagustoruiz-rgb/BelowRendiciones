const API = "/api";

const modules = {
  projects: { title: "Proyectos", singular: "Proyecto" },
  expenses: { title: "Rendiciones", singular: "Rendición" },
  clients: { title: "Clientes", singular: "Cliente" },
  producers: { title: "Productores", singular: "Productor" },
  subproducers: { title: "Sub Productores", singular: "Sub Productor" },
  executives: { title: "Ejecutivos", singular: "Ejecutivo" },
  concepts: { title: "Conceptos de Eventos", singular: "Concepto" },
};

const fields = {
  clients: [["name","Nombre Cliente","text"],["ruc","RUC","text"],["responsible_person","Persona Responsable","text"]],
  producers: [["name","Nombre","text"],["dni","DNI","text"]],
  subproducers: [["name","Nombre","text"],["dni","DNI","text"]],
  executives: [["name","Nombre","text"],["dni","DNI","text"]],
  concepts: [["name","Nombre del Concepto","text"]],
};

let state = {
  module: "projects",
  rows: [],
  editing: null,
  catalogs: {},
  projects: [],
  sunatConfigured: false,
};

const $ = (s) => document.querySelector(s);
const nav = $("#nav");
const tbody = $("#tbody");
const thead = $("#thead");
const modal = $("#modal");
const form = $("#recordForm");

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[ch]));
}

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = isError ? "show error" : "show";
  setTimeout(() => (el.className = ""), 3200);
}

async function request(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "No se pudo completar la operación.");
  return body;
}

function renderNav() {
  nav.innerHTML = Object.entries(modules).map(([key, mod]) =>
    `<button class="nav-btn ${state.module === key ? "active" : ""}" data-module="${key}">${mod.title}</button>`
  ).join("");
  nav.querySelectorAll(".nav-btn").forEach((button) => {
    button.addEventListener("click", () => changeModule(button.dataset.module));
  });
}

async function changeModule(module) {
  state.module = module;
  state.editing = null;
  $("#pageTitle").textContent = modules[module].title;
  $("#search").value = "";
  renderNav();
  await loadCurrent();
}

async function loadCatalogs() {
  const keys = ["clients","producers","subproducers","executives","concepts"];
  const data = await Promise.all(keys.map((key) => request(API + "/" + key)));
  state.catalogs = Object.fromEntries(keys.map((key, i) => [key, data[i]]));
}

async function loadProjects() {
  state.projects = await request(API + "/projects");
}

async function loadCurrent() {
  try {
    if (state.module === "projects") await loadCatalogs();

    if (state.module === "expenses") {
      await Promise.all([loadCatalogs(), loadProjects()]);
      const result = await request(API + "/expenses");
      state.rows = result.rows;
      state.sunatConfigured = Boolean(result.sunatConfigured);
    } else {
      state.rows = await request(API + "/" + state.module);
    }
    render();
  } catch (error) {
    toast(error.message, true);
  }
}

function filteredRows() {
  const q = $("#search").value.toLowerCase().trim();
  if (!q) return state.rows;
  return state.rows.filter((row) => JSON.stringify(row).toLowerCase().includes(q));
}

function renderStats() {
  if (state.module === "projects") {
    const clients = new Set(state.rows.map((r) => r.client_id)).size;
    const concepts = state.rows.reduce((sum, r) => sum + (r.concepts?.length || 0), 0);
    $("#stats").innerHTML = `
      <div class="stat"><span>Proyectos registrados</span><strong>${state.rows.length}</strong></div>
      <div class="stat"><span>Clientes con proyectos</span><strong>${clients}</strong></div>
      <div class="stat"><span>Conceptos asignados</span><strong>${concepts}</strong></div>`;
    return;
  }

  if (state.module === "expenses") {
    const valid = state.rows.filter((r) => r.validation_status === "VALIDADO").length;
    const pending = state.rows.filter((r) => !["VALIDADO","ANULADO","NO_EXISTE"].includes(r.validation_status)).length;
    $("#stats").innerHTML = `
      <div class="stat"><span>Rendiciones registradas</span><strong>${state.rows.length}</strong></div>
      <div class="stat"><span>Validadas SUNAT</span><strong>${valid}</strong></div>
      <div class="stat"><span>Pendientes / revisar</span><strong>${pending}</strong></div>`;
    return;
  }

  $("#stats").innerHTML = `
    <div class="stat"><span>Total de registros</span><strong>${state.rows.length}</strong></div>
    <div class="stat"><span>Módulo</span><strong>${modules[state.module].title}</strong></div>
    <div class="stat"><span>Estado</span><strong>Activo</strong></div>`;
}

function emptyRow(cols) {
  return `<tr><td colspan="${cols}" class="empty">Todavía no existen registros.</td></tr>`;
}

function statusBadge(status) {
  const value = status || "PENDIENTE";
  return `<span class="status ${value.toLowerCase().replaceAll("_","-")}">${esc(value.replaceAll("_"," "))}</span>`;
}

function render() {
  renderStats();
  const rows = filteredRows();
  $("#countLabel").textContent = rows.length + " registro(s)";

  if (state.module === "projects") {
    thead.innerHTML = `<tr>
      <th>Código</th><th>Proyecto</th><th>Cliente</th><th>Servicio</th><th>Lugar</th>
      <th>Fechas</th><th>Comisión</th><th>Moneda</th><th>Tipo Cambio</th><th>Productor</th><th>Sub Productor</th>
      <th>Ejecutivo</th><th>Conceptos</th><th>Acciones</th>
    </tr>`;
    tbody.innerHTML = rows.length ? rows.map((r) => `<tr>
      <td><strong>${esc(r.project_code)}</strong></td>
      <td>${esc(r.project_name)}<br><small>Contacto: ${esc(r.contact_name)}</small></td>
      <td>${esc(r.client_name)}<br><small>${esc(r.client_ruc)}</small></td>
      <td>${esc(r.service_type)}</td><td>${esc(r.event_location)}</td><td>${r.number_of_dates}</td>
      <td>${Number(r.commission || 0).toFixed(2)}%</td>
      <td>${r.currency === "USD" ? "Dólares (USD)" : "Soles (PEN)"}</td>
      <td>${r.currency === "USD" ? Number(r.exchange_rate || 0).toFixed(4) : "—"}</td>
      <td>${esc(r.producer_name)}</td>
      <td>${esc(r.subproducer_name || "—")}</td><td>${esc(r.executive_name)}</td>
      <td>${(r.concepts || []).map((c) => `<span class="badge">${esc(c.name)}</span>`).join("") || "—"}</td>
      <td class="actions">
        <button class="action-btn" data-edit="${r.id}">Editar</button>
        <button class="action-btn delete" data-delete="${r.id}">Eliminar</button>
      </td>
    </tr>`).join("") : emptyRow(14);
  } else if (state.module === "expenses") {
    thead.innerHTML = `<tr>
      <th>Proyecto</th><th>Concepto</th><th>Productor</th><th>Comprobante</th>
      <th>Fecha</th><th>Importe</th><th>Archivo</th><th>SUNAT</th><th>Detalle SUNAT</th><th>Acciones</th>
    </tr>`;
    tbody.innerHTML = rows.length ? rows.map((r) => `<tr>
      <td><strong>${esc(r.project_code)}</strong><br>${esc(r.project_name)}<br><small>${esc(r.client_name)}</small></td>
      <td>${esc(r.concept_name)}</td>
      <td>${esc(r.producer_name)}</td>
      <td>${r.document_type === "01" ? "FACTURA" : "BOLETA"}<br>
        <strong>${esc(r.series)}-${esc(r.document_number)}</strong><br><small>RUC ${esc(r.issuer_ruc)}</small></td>
      <td>${esc(String(r.issue_date).slice(0,10))}</td>
      <td>S/ ${Number(r.amount).toFixed(2)}</td>
      <td><a class="file-link" target="_blank" href="${API}/expenses/${r.id}/file">Abrir documento</a></td>
      <td>${statusBadge(r.validation_status)}</td>
      <td><small>CP: ${esc(r.sunat_estado_cp ?? "—")} · RUC: ${esc(r.sunat_estado_ruc ?? "—")} · Domicilio: ${esc(r.sunat_cond_domi_ruc ?? "—")}<br>${esc(r.sunat_message || "")}</small></td>
      <td class="actions">
        <button class="action-btn" data-validate="${r.id}">Validar SUNAT</button>
        <button class="action-btn delete" data-delete="${r.id}">Eliminar</button>
      </td>
    </tr>`).join("") : emptyRow(10);
  } else {
    const defs = fields[state.module];
    thead.innerHTML = `<tr>${defs.map(([,label]) => "<th>"+label+"</th>").join("")}<th>Acciones</th></tr>`;
    tbody.innerHTML = rows.length ? rows.map((r) => `<tr>
      ${defs.map(([key]) => "<td>"+esc(r[key])+"</td>").join("")}
      <td class="actions">
        <button class="action-btn" data-edit="${r.id}">Editar</button>
        <button class="action-btn delete" data-delete="${r.id}">Eliminar</button>
      </td>
    </tr>`).join("") : emptyRow(defs.length + 1);
  }

  tbody.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => openForm(state.rows.find((r) => Number(r.id) === Number(button.dataset.edit))));
  });
  tbody.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteRow(button.dataset.delete));
  });
  tbody.querySelectorAll("[data-validate]").forEach((button) => {
    button.addEventListener("click", () => validateExpense(button.dataset.validate));
  });
}

function inputField(name,label,type,value="",extra="") {
  return `<div class="field"><label>${label}</label><input name="${name}" type="${type}" value="${esc(value ?? "")}" required ${extra}></div>`;
}

function selectHtml(name,label,options,selected,required=true,extra="") {
  return `<div class="field"><label>${label}</label><select name="${name}" ${required ? "required" : ""} ${extra}>
    <option value="">Seleccionar...</option>
    ${options.map((o) => `<option value="${o.value}" ${String(selected ?? "")===String(o.value) ? "selected" : ""}>${esc(o.label)}</option>`).join("")}
  </select></div>`;
}

function selectField(name,label,catalog,selected,required=true) {
  return selectHtml(name,label,(state.catalogs[catalog]||[]).map((r)=>({value:r.id,label:r.name})),selected,required);
}

function showHelp(text) {
  const help=$("#modalHelp");
  help.textContent=text;
  help.className=text ? "modal-help show" : "modal-help";
}

function refreshExpenseConcepts() {
  const projectSelect = form.querySelector('[name="project_id"]');
  const conceptSelect = form.querySelector('[name="concept_id"]');
  const producerSelect = form.querySelector('[name="producer_id"]');
  if (!projectSelect || !conceptSelect || !producerSelect) return;

  const project = state.projects.find((p)=>String(p.id)===String(projectSelect.value));
  conceptSelect.innerHTML = '<option value="">Seleccionar...</option>' +
    (project?.concepts || []).map((c)=>`<option value="${c.id}">${esc(c.name)}</option>`).join("");

  producerSelect.value = project ? String(project.producer_id) : "";
}

function openForm(row=null) {
  state.editing=row;
  $("#modalEyebrow").textContent=row ? "EDITAR" : "NUEVO";
  $("#modalTitle").textContent=modules[state.module].singular;
  showHelp("");

  if (state.module === "expenses") {
    $("#modalEyebrow").textContent="NUEVA";
    $("#formFields").innerHTML = [
      selectHtml("project_id","Proyecto",state.projects.map((p)=>({value:p.id,label:p.project_code+" · "+p.project_name})),null,true),
      '<div class="field"><label>Concepto del Evento</label><select name="concept_id" required><option value="">Primero selecciona un proyecto...</option></select></div>',
      selectField("producer_id","Productor","producers",null,true),
      selectHtml("document_type","Tipo de comprobante",[
        {value:"01",label:"Factura"},{value:"03",label:"Boleta de Venta"}
      ],"01",true),
      inputField("issuer_ruc","RUC del Emisor","text","",'inputmode="numeric" maxlength="11" pattern="\\d{11}"'),
      inputField("series","Serie","text","",'maxlength="4"'),
      inputField("document_number","Número","number","",'min="1" step="1"'),
      inputField("issue_date","Fecha de Emisión","date",""),
      inputField("amount","Importe Total (S/)","number","",'min="0.01" step="0.01"'),
      '<div class="field full"><label>PDF o foto del comprobante</label><input name="document" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required></div>'
    ].join("");

    showHelp(state.sunatConfigured
      ? "Al guardar, el documento se almacenará y la validación SUNAT se ejecutará automáticamente."
      : "El documento se guardará, pero falta configurar las credenciales SUNAT del servidor. La rendición quedará como PENDIENTE CONFIGURACIÓN."
    );

    form.querySelector('[name="project_id"]').addEventListener("change",refreshExpenseConcepts);
    modal.showModal();
    return;
  }

  if (state.module === "projects") {
    const conceptIds=new Set((row?.concepts||[]).map((c)=>Number(c.id)));
    $("#formFields").innerHTML=[
      selectField("client_id","Cliente","clients",row?.client_id),
      inputField("contact_name","Nombre Contacto","text",row?.contact_name),
      inputField("service_type","Tipo Servicio","text",row?.service_type),
      inputField("project_code","Código de Proyecto","text",row?.project_code),
      inputField("project_name","Nombre de Proyecto","text",row?.project_name),
      inputField("event_location","Lugar del evento","text",row?.event_location),
      inputField("number_of_dates","Número de Fechas","number",row?.number_of_dates||1,'min="1" step="1"'),
      inputField("commission","Comisión (%)","number",row?.commission||0,'min="0" max="100" step="0.01"'),
      selectHtml("currency","Tipo de Moneda",[
        {value:"PEN",label:"Soles (PEN)"},
        {value:"USD",label:"Dólares (USD)"}
      ],row?.currency || "PEN",true),
      '<div class="field" id="exchangeRateField"><label>Tipo de Cambio</label><input name="exchange_rate" type="number" min="0.0001" step="0.0001" value="'+esc(row?.exchange_rate ?? "")+'" placeholder="Ej. 3.7500"></div>',
      selectField("producer_id","Productor","producers",row?.producer_id),
      selectField("subproducer_id","Sub Productor","subproducers",row?.subproducer_id,false),
      selectField("executive_id","Ejecutivo","executives",row?.executive_id),
      `<div class="field full"><label>Conceptos del Evento</label><div class="checkbox-grid">
        ${(state.catalogs.concepts||[]).map((c)=>`<label class="check">
          <input type="checkbox" name="concept_ids" value="${c.id}" ${conceptIds.has(Number(c.id)) ? "checked" : ""}>
          <span>${esc(c.name)}</span>
        </label>`).join("")}
      </div></div>`
    ].join("");
  } else {
    $("#formFields").innerHTML=fields[state.module].map(([key,label,type])=>inputField(key,label,type,row?.[key]||"")).join("");
  }
  if (state.module === "projects") {
    const currencySelect = form.querySelector('[name="currency"]');
    const exchangeInput = form.querySelector('[name="exchange_rate"]');
    const exchangeField = $("#exchangeRateField");

    const syncCurrency = () => {
      const isUsd = currencySelect?.value === "USD";
      if (exchangeField) exchangeField.style.display = isUsd ? "" : "none";
      if (exchangeInput) {
        exchangeInput.required = isUsd;
        exchangeInput.disabled = !isUsd;
        if (!isUsd) exchangeInput.value = "";
      }
    };

    currencySelect?.addEventListener("change", syncCurrency);
    syncCurrency();
  }

  modal.showModal();
}

async function deleteRow(id) {
  if (!confirm("¿Seguro que deseas eliminar este registro?")) return;
  try {
    await request(API+"/"+state.module+"/"+id,{method:"DELETE"});
    toast("Registro eliminado correctamente.");
    await loadCurrent();
  } catch (error) { toast(error.message,true); }
}

async function validateExpense(id) {
  try {
    toast("Consultando SUNAT...");
    const result=await request(API+"/expenses/"+id+"/validate",{method:"POST",body:"{}"});
    if (result.validation.status==="VALIDADO") toast("Comprobante validado correctamente en SUNAT.");
    else toast("SUNAT respondió: "+result.validation.status, result.validation.status==="ERROR");
    await loadCurrent();
  } catch (error) { toast(error.message,true); }
}

form.addEventListener("submit",async(event)=>{
  event.preventDefault();

  try {
    if (state.module==="expenses") {
      const data=new FormData(form);
      const result=await request(API+"/expenses",{method:"POST",body:data});
      modal.close();
      const status=result.validation?.status || "PENDIENTE";
      toast(status==="VALIDADO" ? "Rendición guardada y comprobante VALIDADO en SUNAT." : "Rendición guardada. Estado SUNAT: "+status, status==="ERROR");
      await loadCurrent();
      return;
    }

    const data=Object.fromEntries(new FormData(form).entries());
    if (state.module==="projects") {
      data.concept_ids=[...form.querySelectorAll('input[name="concept_ids"]:checked')].map((input)=>Number(input.value));
    }
    const url=state.editing ? API+"/"+state.module+"/"+state.editing.id : API+"/"+state.module;
    await request(url,{method:state.editing ? "PUT" : "POST",body:JSON.stringify(data)});
    modal.close();
    toast(state.editing ? "Registro actualizado correctamente." : "Registro creado correctamente.");
    await loadCurrent();
  } catch(error) { toast(error.message,true); }
});

$("#newBtn").addEventListener("click",()=>openForm());
$("#closeModal").addEventListener("click",()=>modal.close());
$("#cancelBtn").addEventListener("click",()=>modal.close());
$("#search").addEventListener("input",render);

renderNav();
loadCurrent();
