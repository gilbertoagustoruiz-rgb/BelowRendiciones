import express from "express";
import cors from "cors";
import "dotenv/config";
import { query, pool } from "./db.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const catalogs = {
  clients: {
    table: "clients",
    fields: ["name", "ruc", "responsible_person"],
    required: ["name", "ruc", "responsible_person"],
  },
  producers: {
    table: "producers",
    fields: ["name", "dni"],
    required: ["name", "dni"],
  },
  subproducers: {
    table: "subproducers",
    fields: ["name", "dni"],
    required: ["name", "dni"],
  },
  executives: {
    table: "executives",
    fields: ["name", "dni"],
    required: ["name", "dni"],
  },
  concepts: {
    table: "event_concepts",
    fields: ["name"],
    required: ["name"],
  },
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
  if (["producers", "subproducers", "executives"].includes(type) && body.dni && !/^\d{8}$/.test(String(body.dni).trim())) {
    return "El DNI debe contener exactamente 8 dígitos.";
  }
  return null;
}

function dbError(res, error) {
  if (error.code === "23505") {
    return res.status(409).json({ error: "Ya existe un registro con ese RUC, DNI, código o nombre único." });
  }
  if (error.code === "23503") {
    return res.status(409).json({ error: "El registro está relacionado con otro módulo y no puede eliminarse." });
  }
  if (error.code === "23514") {
    return res.status(400).json({ error: "Uno de los valores no cumple las reglas requeridas." });
  }
  console.error(error);
  return res.status(500).json({ error: "Error interno del servidor." });
}

app.get("/api/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true, database: "connected" });
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
  } catch (error) {
    dbError(res, error);
  }
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
  } catch (error) {
    dbError(res, error);
  }
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
  } catch (error) {
    dbError(res, error);
  }
});

app.delete("/api/:type/:id", async (req, res, next) => {
  const config = catalogs[req.params.type];
  if (!config) return next();

  try {
    const result = await query("DELETE FROM " + config.table + " WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Registro no encontrado." });
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
  pr.name AS producer_name,
  sp.name AS subproducer_name,
  e.name AS executive_name,
  COALESCE(
    json_agg(json_build_object('id', ec.id, 'name', ec.name) ORDER BY ec.name)
      FILTER (WHERE ec.id IS NOT NULL),
    '[]'
  ) AS concepts
FROM projects p
JOIN clients c ON c.id = p.client_id
JOIN producers pr ON pr.id = p.producer_id
LEFT JOIN subproducers sp ON sp.id = p.subproducer_id
JOIN executives e ON e.id = p.executive_id
LEFT JOIN project_event_concepts pec ON pec.project_id = p.id
LEFT JOIN event_concepts ec ON ec.id = pec.concept_id
`;

app.get("/api/projects", async (_req, res) => {
  try {
    const result = await query(
      projectSelect +
      " GROUP BY p.id, c.name, c.ruc, pr.name, sp.name, e.name ORDER BY p.id DESC"
    );
    res.json(result.rows);
  } catch (error) {
    dbError(res, error);
  }
});

function validateProject(body) {
  const fields = [
    "client_id", "contact_name", "service_type", "project_code", "project_name",
    "event_location", "number_of_dates", "producer_id", "executive_id"
  ];
  const missing = requiredError(body, fields);
  if (missing) return missing;
  if (!Number.isInteger(Number(body.number_of_dates)) || Number(body.number_of_dates) < 1) {
    return "Número de fechas debe ser un entero mayor o igual a 1.";
  }
  if (Number(body.commission || 0) < 0) return "La comisión no puede ser negativa.";
  return null;
}

async function replaceConcepts(client, projectId, conceptIds = []) {
  await client.query("DELETE FROM project_event_concepts WHERE project_id=$1", [projectId]);
  const ids = [...new Set((conceptIds || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
  for (const id of ids) {
    await client.query(
      "INSERT INTO project_event_concepts (project_id, concept_id) VALUES ($1,$2)",
      [projectId, id]
    );
  }
}

function projectValues(body) {
  return [
    Number(body.client_id),
    String(body.contact_name).trim(),
    String(body.service_type).trim(),
    String(body.project_code).trim(),
    String(body.project_name).trim(),
    String(body.event_location).trim(),
    Number(body.number_of_dates),
    Number(body.commission || 0),
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
        number_of_dates, commission, producer_id, subproducer_id, executive_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      projectValues(req.body)
    );
    await replaceConcepts(client, result.rows[0].id, req.body.concept_ids);
    await client.query("COMMIT");
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    dbError(res, error);
  } finally {
    client.release();
  }
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
       event_location=$6, number_of_dates=$7, commission=$8, producer_id=$9,
       subproducer_id=$10, executive_id=$11, updated_at=NOW()
       WHERE id=$12 RETURNING *`,
      values
    );
    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Proyecto no encontrado." });
    }
    await replaceConcepts(client, req.params.id, req.body.concept_ids);
    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    dbError(res, error);
  } finally {
    client.release();
  }
});

app.delete("/api/projects/:id", async (req, res) => {
  try {
    const result = await query("DELETE FROM projects WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Proyecto no encontrado." });
    res.json({ ok: true });
  } catch (error) {
    dbError(res, error);
  }
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Ruta no encontrada." }));
app.get("*", (_req, res) => res.sendFile("index.html", { root: "public" }));

app.listen(PORT, () => {
  console.log("Below Rendiciones activo en puerto " + PORT);
});
