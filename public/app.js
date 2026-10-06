const API = "/api";

const modules = {
  projects: { title: "Proyectos", singular: "Proyecto" },
  clients: { title: "Clientes", singular: "Cliente" },
  producers: { title: "Productores", singular: "Productor" },
  subproducers: { title: "Sub Productores", singular: "Sub Productor" },
  executives: { title: "Ejecutivos", singular: "Ejecutivo" },
  concepts: { title: "Conceptos de Eventos", singular: "Concepto" },
};

const fields = {
  clients: [
    ["name", "Nombre Cliente", "text"],
    ["ruc", "RUC", "text"],
    ["responsible_person", "Persona Responsable", "text"],
  ],
  producers: [["name", "Nombre", "text"], ["dni", "DNI", "text"]],
  subproducers: [["name", "Nombre", "text"], ["dni", "DNI", "text"]],
  executives: [["name", "Nombre", "text"], ["dni", "DNI", "text"]],
  concepts: [["name", "Nombre del Concepto", "text"]],
};

let state = { module: "projects", rows: [], editing: null, catalogs: {} };

const $ = (s) => document.querySelector(s);
const nav = $("#nav");
const tbody = $("#tbody");
const thead = $("#thead");
const modal = $("#modal");
const form = $("#recordForm");

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[ch]));
}

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = isError ? "show error" : "show";
  setTimeout(() => (el.className = ""), 2800);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
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
  const keys = ["clients", "producers", "subproducers", "executives", "concepts"];
  const data = await Promise.all(keys.map((key) => request(API + "/" + key)));
  state.catalogs = Object.fromEntries(keys.map((key, i) => [key, data[i]]));
}

async function loadCurrent() {
  try {
    if (state.module === "projects") await loadCatalogs();
    state.rows = await request(API + "/" + state.module);
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
  } else {
    $("#stats").innerHTML = `
      <div class="stat"><span>Total de registros</span><strong>${state.rows.length}</strong></div>
      <div class="stat"><span>Módulo</span><strong>${modules[state.module].title}</strong></div>
      <div class="stat"><span>Estado</span><strong>Activo</strong></div>`;
  }
}

function emptyRow(cols) {
  return `<tr><td colspan="${cols}" class="empty">Todavía no existen registros.</td></tr>`;
}

function render() {
  renderStats();
  const rows = filteredRows();
  $("#countLabel").textContent = rows.length + " registro(s)";

  if (state.module === "projects") {
    thead.innerHTML = `<tr>
      <th>Código</th><th>Proyecto</th><th>Cliente</th><th>Servicio</th><th>Lugar</th>
      <th>Fechas</th><th>Comisión</th><th>Productor</th><th>Sub Productor</th>
      <th>Ejecutivo</th><th>Conceptos</th><th>Acciones</th>
    </tr>`;

    tbody.innerHTML = rows.length ? rows.map((r) => `<tr>
      <td><strong>${esc(r.project_code)}</strong></td>
      <td>${esc(r.project_name)}<br><small>Contacto: ${esc(r.contact_name)}</small></td>
      <td>${esc(r.client_name)}<br><small>${esc(r.client_ruc)}</small></td>
      <td>${esc(r.service_type)}</td>
      <td>${esc(r.event_location)}</td>
      <td>${r.number_of_dates}</td>
      <td>S/ ${Number(r.commission || 0).toFixed(2)}</td>
      <td>${esc(r.producer_name)}</td>
      <td>${esc(r.subproducer_name || "—")}</td>
      <td>${esc(r.executive_name)}</td>
      <td>${(r.concepts || []).map((c) => `<span class="badge">${esc(c.name)}</span>`).join("") || "—"}</td>
      <td class="actions">
        <button class="action-btn" data-edit="${r.id}">Editar</button>
        <button class="action-btn delete" data-delete="${r.id}">Eliminar</button>
      </td>
    </tr>`).join("") : emptyRow(12);
  } else {
    const defs = fields[state.module];
    thead.innerHTML = `<tr>${defs.map(([, label]) => "<th>" + label + "</th>").join("")}<th>Acciones</th></tr>`;
    tbody.innerHTML = rows.length ? rows.map((r) => `<tr>
      ${defs.map(([key]) => "<td>" + esc(r[key]) + "</td>").join("")}
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
}

function inputField(name, label, type, value = "", extra = "") {
  return `<div class="field"><label>${label}</label><input name="${name}" type="${type}" value="${esc(value ?? "")}" required ${extra}></div>`;
}

function selectField(name, label, catalog, selected, required = true) {
  const options = (state.catalogs[catalog] || []).map((row) =>
    `<option value="${row.id}" ${String(selected ?? "") === String(row.id) ? "selected" : ""}>${esc(row.name)}</option>`
  ).join("");

  return `<div class="field"><label>${label}</label>
    <select name="${name}" ${required ? "required" : ""}>
      <option value="">Seleccionar...</option>${options}
    </select>
  </div>`;
}

function openForm(row = null) {
  state.editing = row;
  $("#modalEyebrow").textContent = row ? "EDITAR" : "NUEVO";
  $("#modalTitle").textContent = modules[state.module].singular;

  if (state.module === "projects") {
    const conceptIds = new Set((row?.concepts || []).map((c) => Number(c.id)));
    $("#formFields").innerHTML = [
      selectField("client_id", "Cliente", "clients", row?.client_id),
      inputField("contact_name", "Nombre Contacto", "text", row?.contact_name),
      inputField("service_type", "Tipo Servicio", "text", row?.service_type),
      inputField("project_code", "Código de Proyecto", "text", row?.project_code),
      inputField("project_name", "Nombre de Proyecto", "text", row?.project_name),
      inputField("event_location", "Lugar del evento", "text", row?.event_location),
      inputField("number_of_dates", "Número de Fechas", "number", row?.number_of_dates || 1, 'min="1" step="1"'),
      inputField("commission", "Comisión (S/)", "number", row?.commission || 0, 'min="0" step="0.01"'),
      selectField("producer_id", "Productor", "producers", row?.producer_id),
      selectField("subproducer_id", "Sub Productor", "subproducers", row?.subproducer_id, false),
      selectField("executive_id", "Ejecutivo", "executives", row?.executive_id),
      `<div class="field full"><label>Conceptos del Evento</label><div class="checkbox-grid">
        ${(state.catalogs.concepts || []).map((c) => `<label class="check">
          <input type="checkbox" name="concept_ids" value="${c.id}" ${conceptIds.has(Number(c.id)) ? "checked" : ""}>
          <span>${esc(c.name)}</span>
        </label>`).join("")}
      </div></div>`
    ].join("");
  } else {
    $("#formFields").innerHTML = fields[state.module].map(([key, label, type]) =>
      inputField(key, label, type, row?.[key] || "")
    ).join("");
  }

  modal.showModal();
}

async function deleteRow(id) {
  if (!confirm("¿Seguro que deseas eliminar este registro?")) return;

  try {
    await request(API + "/" + state.module + "/" + id, { method: "DELETE" });
    toast("Registro eliminado correctamente.");
    await loadCurrent();
  } catch (error) {
    toast(error.message, true);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());

  if (state.module === "projects") {
    data.concept_ids = [...form.querySelectorAll('input[name="concept_ids"]:checked')]
      .map((input) => Number(input.value));
  }

  try {
    const url = state.editing
      ? API + "/" + state.module + "/" + state.editing.id
      : API + "/" + state.module;

    await request(url, {
      method: state.editing ? "PUT" : "POST",
      body: JSON.stringify(data),
    });

    modal.close();
    toast(state.editing ? "Registro actualizado correctamente." : "Registro creado correctamente.");
    await loadCurrent();
  } catch (error) {
    toast(error.message, true);
  }
});

$("#newBtn").addEventListener("click", () => openForm());
$("#closeModal").addEventListener("click", () => modal.close());
$("#cancelBtn").addEventListener("click", () => modal.close());
$("#search").addEventListener("input", render);

renderNav();
loadCurrent();
