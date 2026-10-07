import express from "express";
import cors from "cors";
import multer from "multer";
import "dotenv/config";
import PDFDocument from "pdfkit";
import bcrypt from "bcryptjs";
import { ensureSchema } from "./schema-init.js";
import { query, pool } from "./db.js";
import { isSunatConfigured, mapSunatStatus, validateCpe } from "./sunat.js";
import { saveEvidence, sendEvidence } from "./storage.js";
import { readReceiptDocument } from "./document-reader.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Solo se permiten PDF, JPG, PNG o WEBP."));
    }
    cb(null, true);
  },
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const catalogs = {
  clients: { table: "clients", fields: ["name", "ruc", "responsible_person"], required: ["name", "ruc", "responsible_person"] },
  concepts: { table: "event_concepts", fields: ["name"], required: ["name"] },
};

function requiredError(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || String(body[field]).trim() === "") {
      return "El campo " + field + " es obligatorio.";
    }
  }
  return null;
}

function identityError(type, body) {
  if (type === "clients" && body.ruc && !/^\d{11}$/.test(String(body.ruc).trim())) {
    return "El RUC debe contener exactamente 11 dígitos.";
  }
  return null;
}

function dbError(res, error) {
  if (error.code === "23505") return res.status(409).json({ error: "El registro ya existe. Revisa RUC, DNI, código o comprobante." });
  if (error.code === "23503") return res.status(409).json({ error: "El registro está relacionado con otro módulo y no puede eliminarse." });
  if (error.code === "23514") return res.status(400).json({ error: "Uno de los valores no cumple las reglas requeridas." });
  console.error(error);
  return res.status(500).json({ error: error.message || "Error interno del servidor." });
}

app.get("/api/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true, database: "connected", sunatConfigured: isSunatConfigured() });
  } catch (error) {
    res.status(503).json({ ok: false, database: "disconnected", error: error.message });
  }
});

app.get("/api/:type", async (req, res, next) => {
  const config = catalogs[req.params.type];
  if (!config) return next();
  try {
    const result = await query("SELECT * FROM " + config.table + " ORDER BY id DESC");
    res.json(result.rows);
  } catch (error) { dbError(res, error); }
});

app.post("/api/:type", async (req, res, next) => {
  const type = req.params.type;
  const config = catalogs[type];
  if (!config) return next();

  const validation = requiredError(req.body, config.required) || identityError(type, req.body);
  if (validation) return res.status(400).json({ error: validation });

  try {
    const values = config.fields.map((field) => String(req.body[field]).trim());
    const placeholders = config.fields.map((_, i) => "$" + (i + 1)).join(", ");
    const result = await query(
      "INSERT INTO " + config.table + " (" + config.fields.join(", ") + ") VALUES (" + placeholders + ") RETURNING *",
      values
    );
    res.status(201).json(result.rows[0]);
  } catch (error) { dbError(res, error); }
});

app.put("/api/:type/:id", async (req, res, next) => {
  const type = req.params.type;
  const config = catalogs[type];
  if (!config) return next();

  const validation = requiredError(req.body, config.required) || identityError(type, req.body);
  if (validation) return res.status(400).json({ error: validation });

  try {
    const values = config.fields.map((field) => String(req.body[field]).trim());
    const setSql = config.fields.map((field, i) => field + "=$" + (i + 1)).join(", ");
    values.push(req.params.id);
    const result = await query(
      "UPDATE " + config.table + " SET " + setSql + " WHERE id=$" + values.length + " RETURNING *",
      values
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Registro no encontrado." });
    res.json(result.rows[0]);
  } catch (error) { dbError(res, error); }
});

app.delete("/api/:type/:id", async (req, res, next) => {
  const config = catalogs[req.params.type];
  if (!config) return next();
  try {
    const result = await query("DELETE FROM " + config.table + " WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Registro no encontrado." });
    res.json({ ok: true });
  } catch (error) { dbError(res, error); }
});

app.get("/api/personnel", async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, full_name, document_number, profile, status,
              (password_hash IS NOT NULL) AS password_configured,
              created_at, updated_at
       FROM personnel
       ORDER BY full_name ASC, profile ASC`
    );
    res.json(result.rows);
  } catch (error) {
    dbError(res, error);
  }
});

function validatePersonnel(body, editing=false) {
  const required = ["full_name","document_number","profile","status"];
  const missing = requiredError(body, required);
  if (missing) return missing;

  if (!["PRODUCTOR","SUB PRODUCTOR","EJECUTIVO"].includes(String(body.profile))) {
    return "Perfil inválido.";
  }
  if (!["ACTIVO","INACTIVO"].includes(String(body.status))) {
    return "Estado inválido.";
  }
  if (!/^[A-Za-z0-9-]{6,20}$/.test(String(body.document_number).trim())) {
    return "DNI / Pasaporte debe tener entre 6 y 20 caracteres alfanuméricos.";
  }
  if (!editing && (!body.password || String(body.password).length < 6)) {
    return "La contraseña debe tener al menos 6 caracteres.";
  }
  if (body.password && String(body.password).length < 6) {
    return "La nueva contraseña debe tener al menos 6 caracteres.";
  }
  return null;
}

app.post("/api/personnel", async (req, res) => {
  const validation = validatePersonnel(req.body, false);
  if (validation) return res.status(400).json({ error: validation });

  try {
    const passwordHash = await bcrypt.hash(String(req.body.password), 12);
    const result = await query(
      `INSERT INTO personnel
       (full_name, document_number, profile, password_hash, status)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, full_name, document_number, profile, status,
                 true AS password_configured, created_at, updated_at`,
      [
        String(req.body.full_name).trim(),
        String(req.body.document_number).trim().toUpperCase(),
        String(req.body.profile),
        passwordHash,
        String(req.body.status),
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    dbError(res, error);
  }
});

app.put("/api/personnel/:id", async (req, res) => {
  const validation = validatePersonnel(req.body, true);
  if (validation) return res.status(400).json({ error: validation });

  try {
    const current = await query("SELECT id FROM personnel WHERE id=$1", [req.params.id]);
    if (!current.rows[0]) return res.status(404).json({ error: "Personal no encontrado." });

    let passwordHash = null;
    if (req.body.password) {
      passwordHash = await bcrypt.hash(String(req.body.password), 12);
    }

    const result = await query(
      `UPDATE personnel SET
        full_name=$1,
        document_number=$2,
        profile=$3,
        status=$4,
        password_hash=COALESCE($5,password_hash),
        updated_at=NOW()
       WHERE id=$6
       RETURNING id, full_name, document_number, profile, status,
                 (password_hash IS NOT NULL) AS password_configured,
                 created_at, updated_at`,
      [
        String(req.body.full_name).trim(),
        String(req.body.document_number).trim().toUpperCase(),
        String(req.body.profile),
        String(req.body.status),
        passwordHash,
        req.params.id,
      ]
    );
    res.json(result.rows[0]);
  } catch (error) {
    dbError(res, error);
  }
});

app.delete("/api/personnel/:id", async (req, res) => {
  try {
    const result = await query("DELETE FROM personnel WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Personal no encontrado." });
    res.json({ ok: true });
  } catch (error) {
    dbError(res, error);
  }
});

const projectSelect = `
SELECT
  p.*,
  c.name AS client_name,
  c.ruc AS client_ruc,
  pr.full_name AS producer_name,
  sp.full_name AS subproducer_name,
  e.full_name AS executive_name,
  COALESCE(
    json_agg(json_build_object('id', ec.id, 'name', ec.name) ORDER BY ec.name)
      FILTER (WHERE ec.id IS NOT NULL),
    '[]'
  ) AS concepts
FROM projects p
JOIN clients c ON c.id = p.client_id
JOIN personnel pr ON pr.id = p.producer_id
LEFT JOIN personnel sp ON sp.id = p.subproducer_id
JOIN personnel e ON e.id = p.executive_id
LEFT JOIN project_event_concepts pec ON pec.project_id = p.id
LEFT JOIN event_concepts ec ON ec.id = pec.concept_id
`;

app.get("/api/projects", async (_req, res) => {
  try {
    const result = await query(projectSelect + " GROUP BY p.id, c.name, c.ruc, pr.full_name, sp.full_name, e.full_name ORDER BY p.id DESC");
    res.json(result.rows);
  } catch (error) { dbError(res, error); }
});

function validateProject(body) {
  const fields = ["client_id","contact_name","service_type","project_code","project_name","event_location","number_of_dates","producer_id","executive_id"];
  const missing = requiredError(body, fields);
  if (missing) return missing;
  if (!Number.isInteger(Number(body.number_of_dates)) || Number(body.number_of_dates) < 1) return "Número de fechas debe ser un entero mayor o igual a 1.";
  const commission = Number(body.commission || 0);
  if (commission < 0 || commission > 100) return "La comisión debe estar entre 0% y 100%.";
  if (!["PEN","USD"].includes(String(body.currency || "PEN"))) return "Tipo de moneda inválido.";
  if (String(body.currency || "PEN") === "USD" && Number(body.exchange_rate) <= 0) {
    return "Debes ingresar un tipo de cambio mayor a 0 cuando la moneda es Dólares.";
  }
  return null;
}

async function replaceConcepts(client, projectId, conceptIds = []) {
  await client.query("DELETE FROM project_event_concepts WHERE project_id=$1", [projectId]);
  const ids = [...new Set((conceptIds || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
  for (const id of ids) {
    await client.query("INSERT INTO project_event_concepts (project_id, concept_id) VALUES ($1,$2)", [projectId, id]);
  }
}

function projectValues(body) {
  return [
    Number(body.client_id), String(body.contact_name).trim(), String(body.service_type).trim(),
    String(body.project_code).trim(), String(body.project_name).trim(), String(body.event_location).trim(),
    Number(body.number_of_dates),
    Number(body.commission || 0),
    String(body.currency || "PEN"),
    String(body.currency || "PEN") === "USD" ? Number(body.exchange_rate) : null,
    Number(body.producer_id),
    body.subproducer_id ? Number(body.subproducer_id) : null,
    Number(body.executive_id),
  ];
}

app.post("/api/projects", async (req, res) => {
  const validation = validateProject(req.body);
  if (validation) return res.status(400).json({ error: validation });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO projects
       (client_id, contact_name, service_type, project_code, project_name, event_location,
        number_of_dates, commission, currency, exchange_rate, producer_id, subproducer_id, executive_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      projectValues(req.body)
    );
    await replaceConcepts(client, result.rows[0].id, req.body.concept_ids);
    await client.query("COMMIT");
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK"); dbError(res, error);
  } finally { client.release(); }
});

app.put("/api/projects/:id", async (req, res) => {
  const validation = validateProject(req.body);
  if (validation) return res.status(400).json({ error: validation });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const values = [...projectValues(req.body), req.params.id];
    const result = await client.query(
      `UPDATE projects SET
       client_id=$1, contact_name=$2, service_type=$3, project_code=$4, project_name=$5,
       event_location=$6, number_of_dates=$7, commission=$8, currency=$9, exchange_rate=$10,
       producer_id=$11, subproducer_id=$12, executive_id=$13, updated_at=NOW()
       WHERE id=$14 RETURNING *`, values
    );
    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Proyecto no encontrado." });
    }
    await replaceConcepts(client, req.params.id, req.body.concept_ids);
    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK"); dbError(res, error);
  } finally { client.release(); }
});

app.delete("/api/projects/:id", async (req, res) => {
  try {
    const result = await query("DELETE FROM projects WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Proyecto no encontrado." });
    res.json({ ok: true });
  } catch (error) { dbError(res, error); }
});

const expenseSelect = `
SELECT
  er.*,
  p.project_code,
  p.project_name,
  c.name AS client_name,
  ec.name AS concept_name,
  pr.full_name AS producer_name
FROM expense_reports er
JOIN projects p ON p.id=er.project_id
JOIN clients c ON c.id=p.client_id
JOIN event_concepts ec ON ec.id=er.concept_id
JOIN personnel pr ON pr.id=er.producer_id
`;

app.get("/api/expenses", async (_req, res) => {
  try {
    const result = await query(expenseSelect + " ORDER BY er.id DESC");
    res.json({ rows: result.rows, sunatConfigured: isSunatConfigured() });
  } catch (error) { dbError(res, error); }
});

app.get("/api/expenses/:id/file", async (req, res) => {
  try {
    const result = await query("SELECT * FROM expense_reports WHERE id=$1", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Archivo no encontrado." });
    await sendEvidence(res, result.rows[0]);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ error: "No se pudo abrir el archivo." });
  }
});

function validateExpenseInput(body) {
  const required = ["project_id","concept_id","producer_id","document_type","issuer_ruc","series","document_number","issue_date","amount"];
  const missing = requiredError(body, required);
  if (missing) return missing;
  if (!["01","03"].includes(String(body.document_type))) return "Tipo de comprobante inválido.";
  if (!/^\d{11}$/.test(String(body.issuer_ruc))) return "El RUC emisor debe tener 11 dígitos.";
  if (!/^[A-Za-z0-9]{1,4}$/.test(String(body.series))) return "La serie debe tener hasta 4 caracteres.";
  if (!/^\d{1,20}$/.test(String(body.document_number || "").trim())) return "Número de comprobante inválido.";
  if (Number(body.amount) <= 0) return "El importe debe ser mayor a 0.";
  return null;
}

async function runSunatValidation(expenseId) {
  const result = await query("SELECT * FROM expense_reports WHERE id=$1", [expenseId]);
  const expense = result.rows[0];
  if (!expense) throw new Error("Rendición no encontrada.");

  if (!isSunatConfigured()) {
    await query(
      `UPDATE expense_reports
       SET validation_status='PENDIENTE_CONFIGURACION',
           sunat_message='Faltan credenciales SUNAT en el servidor.'
       WHERE id=$1`, [expenseId]
    );
    return { configured: false, status: "PENDIENTE_CONFIGURACION" };
  }

  try {
    const data = await validateCpe(expense);
    const status = mapSunatStatus(data);
    await query(
      `UPDATE expense_reports SET
       validation_status=$1,
       sunat_estado_cp=$2,
       sunat_estado_ruc=$3,
       sunat_cond_domi_ruc=$4,
       sunat_message=$5,
       sunat_observations=$6::jsonb,
       sunat_response=$7::jsonb,
       validated_at=NOW()
       WHERE id=$8`,
      [
        status,
        data?.data?.estadoCp == null ? null : String(data.data.estadoCp),
        data?.data?.estadoRuc == null ? null : String(data.data.estadoRuc),
        data?.data?.condDomiRuc == null ? null : String(data.data.condDomiRuc),
        data?.message || null,
        JSON.stringify(data?.data?.Observaciones || []),
        JSON.stringify(data),
        expenseId,
      ]
    );
    return { configured: true, status, data };
  } catch (error) {
    const payload = error.sunatPayload || { error: error.message };
    await query(
      `UPDATE expense_reports SET
       validation_status='ERROR',
       sunat_message=$1,
       sunat_response=$2::jsonb,
       validated_at=NOW()
       WHERE id=$3`,
      [error.message, JSON.stringify(payload), expenseId]
    );
    return { configured: true, status: "ERROR", error: error.message, data: payload };
  }
}

app.post("/api/expenses/scan", upload.single("document"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Debes adjuntar un PDF o foto del comprobante." });

  try {
    const result = await readReceiptDocument(req.file);
    res.json(result);
  } catch (error) {
    console.error("Error leyendo comprobante:", error);
    res.status(500).json({ error: "No se pudo leer automáticamente el documento. Puedes completar los campos manualmente." });
  }
});

app.post("/api/expenses", upload.single("document"), async (req, res) => {
  const validation = validateExpenseInput(req.body);
  if (validation) return res.status(400).json({ error: validation });
  if (!req.file) return res.status(400).json({ error: "Debes adjuntar el PDF o foto del comprobante." });

  try {
    const projectCheck = await query(
      "SELECT id, producer_id FROM projects WHERE id=$1",
      [req.body.project_id]
    );
    if (!projectCheck.rows[0]) return res.status(404).json({ error: "Proyecto no encontrado." });
    if (Number(projectCheck.rows[0].producer_id) !== Number(req.body.producer_id)) {
      return res.status(400).json({ error: "El productor seleccionado no corresponde al proyecto." });
    }

    const linkCheck = await query(
      "SELECT 1 FROM project_event_concepts WHERE project_id=$1 AND concept_id=$2",
      [req.body.project_id, req.body.concept_id]
    );
    if (!linkCheck.rows[0]) {
      return res.status(400).json({ error: "El concepto seleccionado no está asignado a este proyecto." });
    }

    const stored = await saveEvidence(req.file);
    const inserted = await query(
      `INSERT INTO expense_reports
       (project_id, concept_id, producer_id, document_type, issuer_ruc, series,
        document_number, issue_date, amount, file_name, file_mime, file_storage, file_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        Number(req.body.project_id), Number(req.body.concept_id), Number(req.body.producer_id),
        String(req.body.document_type), String(req.body.issuer_ruc).trim(),
        String(req.body.series).trim().toUpperCase(), String(req.body.document_number).trim(),
        req.body.issue_date, Number(req.body.amount), req.file.originalname, req.file.mimetype,
        stored.storage, stored.key,
      ]
    );

    const validationResult = await runSunatValidation(inserted.rows[0].id);
    const finalRow = await query(expenseSelect + " WHERE er.id=$1", [inserted.rows[0].id]);
    res.status(201).json({ row: finalRow.rows[0], validation: validationResult });
  } catch (error) { dbError(res, error); }
});

app.put("/api/expenses/:id", upload.single("document"), async (req, res) => {
  const validation = validateExpenseInput(req.body);
  if (validation) return res.status(400).json({ error: validation });

  try {
    const current = await query("SELECT * FROM expense_reports WHERE id=$1", [req.params.id]);
    if (!current.rows[0]) return res.status(404).json({ error: "Rendición no encontrada." });

    const projectCheck = await query(
      "SELECT id, producer_id FROM projects WHERE id=$1",
      [req.body.project_id]
    );
    if (!projectCheck.rows[0]) return res.status(404).json({ error: "Proyecto no encontrado." });
    if (Number(projectCheck.rows[0].producer_id) !== Number(req.body.producer_id)) {
      return res.status(400).json({ error: "El productor seleccionado no corresponde al proyecto." });
    }

    const linkCheck = await query(
      "SELECT 1 FROM project_event_concepts WHERE project_id=$1 AND concept_id=$2",
      [req.body.project_id, req.body.concept_id]
    );
    if (!linkCheck.rows[0]) {
      return res.status(400).json({ error: "El concepto seleccionado no está asignado a este proyecto." });
    }

    let fileName = current.rows[0].file_name;
    let fileMime = current.rows[0].file_mime;
    let fileStorage = current.rows[0].file_storage;
    let fileKey = current.rows[0].file_key;

    if (req.file) {
      const stored = await saveEvidence(req.file);
      fileName = req.file.originalname;
      fileMime = req.file.mimetype;
      fileStorage = stored.storage;
      fileKey = stored.key;
    }

    await query(
      `UPDATE expense_reports SET
        project_id=$1,
        concept_id=$2,
        producer_id=$3,
        document_type=$4,
        issuer_ruc=$5,
        series=$6,
        document_number=$7,
        issue_date=$8,
        amount=$9,
        file_name=$10,
        file_mime=$11,
        file_storage=$12,
        file_key=$13,
        validation_status='PENDIENTE',
        sunat_estado_cp=NULL,
        sunat_estado_ruc=NULL,
        sunat_cond_domi_ruc=NULL,
        sunat_message=NULL,
        sunat_observations='[]'::jsonb,
        sunat_response=NULL,
        validated_at=NULL
       WHERE id=$14`,
      [
        Number(req.body.project_id),
        Number(req.body.concept_id),
        Number(req.body.producer_id),
        String(req.body.document_type),
        String(req.body.issuer_ruc).trim(),
        String(req.body.series).trim().toUpperCase(),
        String(req.body.document_number).trim(),
        req.body.issue_date,
        Number(req.body.amount),
        fileName,
        fileMime,
        fileStorage,
        fileKey,
        req.params.id,
      ]
    );

    const validationResult = await runSunatValidation(req.params.id);
    const finalRow = await query(expenseSelect + " WHERE er.id=$1", [req.params.id]);
    res.json({ row: finalRow.rows[0], validation: validationResult });
  } catch (error) {
    dbError(res, error);
  }
});

app.post("/api/expenses/:id/validate", async (req, res) => {
  try {
    const result = await runSunatValidation(req.params.id);
    const row = await query(expenseSelect + " WHERE er.id=$1", [req.params.id]);
    if (!row.rows[0]) return res.status(404).json({ error: "Rendición no encontrada." });
    res.json({ row: row.rows[0], validation: result });
  } catch (error) { dbError(res, error); }
});

app.delete("/api/expenses/:id", async (req, res) => {
  try {
    const result = await query("DELETE FROM expense_reports WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Rendición no encontrada." });
    res.json({ ok: true });
  } catch (error) { dbError(res, error); }
});


const advanceRequestSelect = `
SELECT
  ar.*,
  p.project_code,
  p.project_name,
  c.name AS client_name
FROM advance_requests ar
JOIN projects p ON p.id=ar.project_id
JOIN clients c ON c.id=p.client_id
`;

function validateAdvanceRequest(body) {
  const required = [
    "company","request_date","applicant_name","account_number","account_type",
    "account_holder","bank","beneficiary_document","beneficiary_name","amount",
    "project_id","deposit_date","settlement_date","observations","expected_document_type"
  ];

  const missing = requiredError(body, required);
  if (missing) return missing;

  if (!["BELOW SAC","BELOW TRADE SAC"].includes(String(body.company))) {
    return "Empresa inválida.";
  }
  if (!["AHORRO","CTE"].includes(String(body.account_type))) {
    return "Tipo de cuenta inválido.";
  }
  if (!["RH","FACTURA","BOLETA","OTRO"].includes(String(body.expected_document_type))) {
    return "Tipo de comprobante inválido.";
  }
  if (Number(body.amount) <= 0) return "El monto a depositar debe ser mayor a 0.";

  return null;
}

function advanceRequestValues(body) {
  return [
    String(body.company).trim(),
    body.request_date,
    String(body.applicant_name).trim(),
    String(body.account_number).trim(),
    String(body.account_type).trim(),
    String(body.account_holder).trim(),
    String(body.bank).trim(),
    String(body.cci || "").trim() || null,
    String(body.beneficiary_document).trim(),
    String(body.beneficiary_name).trim(),
    Number(body.amount),
    Number(body.project_id),
    body.deposit_date,
    body.settlement_date,
    String(body.observations).trim(),
    String(body.expected_document_type).trim(),
  ];
}

app.get("/api/advances", async (_req, res) => {
  try {
    const result = await query(advanceRequestSelect + " ORDER BY ar.id DESC");
    res.json({ rows: result.rows });
  } catch (error) {
    dbError(res, error);
  }
});

app.post("/api/advances", async (req, res) => {
  const validation = validateAdvanceRequest(req.body);
  if (validation) return res.status(400).json({ error: validation });

  try {
    const project = await query("SELECT id FROM projects WHERE id=$1", [req.body.project_id]);
    if (!project.rows[0]) return res.status(404).json({ error: "Proyecto no encontrado." });

    const result = await query(
      `INSERT INTO advance_requests (
        company, request_date, applicant_name, account_number, account_type,
        account_holder, bank, cci, beneficiary_document, beneficiary_name,
        amount, project_id, deposit_date, settlement_date, observations,
        expected_document_type
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
      ) RETURNING *`,
      advanceRequestValues(req.body)
    );

    const row = await query(advanceRequestSelect + " WHERE ar.id=$1", [result.rows[0].id]);
    res.status(201).json(row.rows[0]);
  } catch (error) {
    dbError(res, error);
  }
});

app.put("/api/advances/:id", async (req, res) => {
  const validation = validateAdvanceRequest(req.body);
  if (validation) return res.status(400).json({ error: validation });

  try {
    const values = [...advanceRequestValues(req.body), req.params.id];
    const result = await query(
      `UPDATE advance_requests SET
        company=$1,
        request_date=$2,
        applicant_name=$3,
        account_number=$4,
        account_type=$5,
        account_holder=$6,
        bank=$7,
        cci=$8,
        beneficiary_document=$9,
        beneficiary_name=$10,
        amount=$11,
        project_id=$12,
        deposit_date=$13,
        settlement_date=$14,
        observations=$15,
        expected_document_type=$16,
        updated_at=NOW()
       WHERE id=$17
       RETURNING id`,
      values
    );

    if (!result.rows[0]) return res.status(404).json({ error: "Anticipo no encontrado." });

    const row = await query(advanceRequestSelect + " WHERE ar.id=$1", [req.params.id]);
    res.json(row.rows[0]);
  } catch (error) {
    dbError(res, error);
  }
});

app.delete("/api/advances/:id", async (req, res) => {
  try {
    const result = await query("DELETE FROM advance_requests WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Anticipo no encontrado." });
    res.json({ ok: true });
  } catch (error) {
    dbError(res, error);
  }
});

function pdfDate(value) {
  const raw = String(value || "").slice(0,10);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[3]+"/"+m[2]+"/"+m[1] : raw;
}

function drawPdfField(doc, label, value, y, options={}) {
  const xLabel = 50;
  const xValue = 210;
  doc.font("Helvetica-Bold").fontSize(9).text(label, xLabel, y, { width: 150 });
  doc.font("Helvetica").fontSize(9).text(String(value ?? ""), xValue, y, { width: options.width || 330 });
  doc.moveTo(xValue, y+13).lineTo(545, y+13).strokeColor("#B8B8B8").lineWidth(0.5).stroke();
}

app.get("/api/advances/:id/pdf", async (req, res) => {
  try {
    const result = await query(advanceRequestSelect + " WHERE ar.id=$1", [req.params.id]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "Anticipo no encontrado." });

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const filename = "anticipo-" + String(row.project_code || row.id).replace(/[^A-Za-z0-9_-]/g, "_") + ".pdf";

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      (req.query.download === "1" ? "attachment" : "inline") + '; filename="' + filename + '"'
    );

    doc.pipe(res);

    doc.rect(40,40,515,70).strokeColor("#000000").lineWidth(1).stroke();
    doc.font("Helvetica-Bold").fontSize(26).text("b",55,55,{width:35});
    doc.fontSize(13).text("below",88,58);
    doc.fontSize(8).text("GROUP",88,76);

    doc.font("Helvetica-Bold").fontSize(11)
      .text("FORMATO - REQUERIMIENTO DE ANTICIPOS\nY OTROS GASTOS",185,58,{width:235,align:"center"});

    doc.fontSize(8).text("Código",430,47);
    doc.font("Helvetica").text("BL-F-RA-01",485,47);
    doc.font("Helvetica-Bold").text("Versión",430,65);
    doc.font("Helvetica").text("0",485,65);
    doc.font("Helvetica-Bold").text("Fecha",430,83);
    doc.font("Helvetica").text(pdfDate(row.request_date),485,83);

    let y=130;
    drawPdfField(doc,"Empresa :",row.company,y); y+=28;
    drawPdfField(doc,"Fecha de solicitud :",pdfDate(row.request_date),y); y+=34;
    drawPdfField(doc,"Datos de solicitante :",row.applicant_name,y); y+=34;
    drawPdfField(doc,"Número de cuenta :",row.account_number,y); y+=26;
    drawPdfField(doc,"Tipo de cuenta :",row.account_type === "AHORRO" ? "AHORRO" : "CTE",y); y+=26;
    drawPdfField(doc,"Titular de la Cta. :",row.account_holder,y); y+=26;
    drawPdfField(doc,"Banco :",row.bank,y); y+=26;
    drawPdfField(doc,"CCI :",row.cci || "",y); y+=26;
    drawPdfField(doc,"RUC / DNI :",row.beneficiary_document,y); y+=34;

    doc.font("Helvetica-Bold").fontSize(9).text("Razón Social / Nombre (beneficiario):",50,y,{width:155});
    doc.rect(210,y-8,335,44).strokeColor("#B8B8B8").stroke();
    doc.font("Helvetica").fontSize(12).text(row.beneficiary_name,225,y+6,{width:305,align:"center"});
    y+=58;

    drawPdfField(doc,"Monto a depositar :","S/ " + Number(row.amount).toFixed(2),y); y+=24;
    drawPdfField(doc,"Código de Proyecto :",row.project_code,y); y+=24;
    drawPdfField(doc,"Nombre de proyecto :",row.project_name,y); y+=24;
    drawPdfField(doc,"Cliente :",row.client_name,y); y+=24;
    drawPdfField(doc,"Fecha de abono :",pdfDate(row.deposit_date),y); y+=24;
    drawPdfField(doc,"Fecha de rendición :",pdfDate(row.settlement_date),y); y+=34;

    doc.font("Helvetica-Bold").fontSize(9).text("Motivo u Observaciones :",50,y,{width:150});
    doc.rect(210,y-8,335,48).strokeColor("#B8B8B8").stroke();
    doc.font("Helvetica").fontSize(9).text(row.observations,220,y,{width:315,height:35});
    y+=62;

    drawPdfField(
      doc,
      "Tipo de comprobante a entregar :",
      row.expected_document_type === "RH" ? "RH" : row.expected_document_type,
      y
    );

    doc.end();
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ error: "No se pudo generar el PDF del anticipo." });
  }
});

app.use((error, _req, res, next) => {
  if (!error) return next();
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "El archivo supera 10 MB." : error.message });
  }
  if (error.message?.includes("Solo se permiten")) return res.status(400).json({ error: error.message });
  next(error);
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Ruta no encontrada." }));
app.get("*", (_req, res) => res.sendFile("index.html", { root: "public" }));

async function start() {
  try {
    await ensureSchema();
    app.listen(PORT, () => console.log("Below Rendiciones activo en puerto " + PORT));
  } catch (error) {
    console.error("No se pudo inicializar la base de datos:");
    console.error(error);
    process.exit(1);
  }
}

start();
