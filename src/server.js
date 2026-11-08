import express from "express";
import helmet from "helmet";
import multer from "multer";
import "dotenv/config";
import PDFDocument from "pdfkit";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { ensureSchema } from "./schema-init.js";
import { query, pool } from "./db.js";
import { isSunatConfigured, mapSunatStatus, testSunatConnection, validateCpe } from "./sunat.js";
import { saveEvidence, sendEvidence, removeEvidence } from "./storage.js";
import { readReceiptDocument, closeDocumentReader } from "./document-reader.js";
import { createWorkflowRouter } from './workflow.js';
import { createFinanceRouter } from './finance.js';
import { createLoginLimiter, sameOriginGuard, detectEvidenceType, passwordError, contentDisposition } from "./security.js";
import { readSpreadsheetRows, ImportFormatError } from "./spreadsheet-import.js";

export const app = express();
const PORT = Number(process.env.PORT || 3000);
const PRODUCTION = process.env.NODE_ENV === "production";
const SESSION_DAYS = 7;
export const loginLimiter = createLoginLimiter();
// Compared when the document does not exist, so response time does not reveal valid users.
const DUMMY_HASH = bcrypt.hashSync("below-rendiciones-dummy", 10);

const EVIDENCE_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 30 },
  fileFilter: (_req, file, cb) => {
    if (!EVIDENCE_TYPES.includes(file.mimetype)) {
      return cb(new Error("Solo se permiten PDF, JPG, PNG o WEBP."));
    }
    cb(null, true);
  },
});

const dataUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 },
});

/** Confirms the uploaded file really is a PDF/JPG/PNG/WEBP and records its true type. */
function checkEvidenceFile(file) {
  const detected = detectEvidenceType(file?.buffer);
  if (!detected) throw Object.assign(new Error("El archivo no es un PDF, JPG, PNG o WEBP válido."), { status: 400 });
  file.mimetype = detected;
  file.originalname = String(file.originalname || "comprobante").slice(0, 200);
  return file;
}

function parseTrustProxy(value) {
  if (value === undefined || value === "") return 1; // DigitalOcean / most PaaS: one proxy in front
  if (value === "true") return true;
  if (value === "false") return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

app.disable("x-powered-by");
app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: PRODUCTION ? [] : null,
    },
  },
  strictTransportSecurity: PRODUCTION ? { maxAge: 31536000 } : false,
  crossOriginEmbedderPolicy: false,
}));
app.use("/api", sameOriginGuard(String(process.env.ALLOWED_ORIGINS || "").split(",")));
app.use(express.json({ limit: "1mb" }));
app.use('/api',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
app.use(express.static("public",{setHeaders(res,filePath){
  if(filePath.endsWith('sw.js') || filePath.endsWith('index.html'))res.setHeader('Cache-Control','no-cache');
}}));

const catalogs = {
  clients: { table: "clients", fields: ["name", "ruc", "responsible_person"], required: ["name", "ruc", "responsible_person"] },
  clientprojects: { table: "client_projects_master", fields: ["ruc", "client_name", "project_name", "project_code"], required: ["ruc", "client_name", "project_name", "project_code"] },
  profiles: { table: "profiles", fields: ["name"], required: ["name"] },
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
  if (["clients","clientprojects"].includes(type) && body.ruc && !/^\d{11}$/.test(String(body.ruc).trim())) {
    return "El RUC debe contener exactamente 11 dígitos.";
  }
  return null;
}

function dbError(res, error) {
  if (res.headersSent) { console.error(error); return; }
  if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message });
  if (error.code === "23505") return res.status(409).json({ error: "El registro ya existe. Revisa RUC, DNI, código o comprobante." });
  if (error.code === "23503") return res.status(409).json({ error: "El registro está relacionado con otro módulo y no puede eliminarse." });
  // Workflow triggers raise 23514 without a constraint name and a message written for users.
  if (error.code === "23514" && !error.constraint && error.where) return res.status(409).json({ error: error.message });
  if (error.code === "23514") return res.status(400).json({ error: "Uno de los valores no cumple las reglas requeridas." });
  if (error.code === "22P02" || error.code === "22007" || error.code === "22008" || error.code === "22003") {
    return res.status(400).json({ error: "Uno de los valores tiene un formato inválido." });
  }
  // Internal details stay in the server log; the user gets a reference to report.
  const ref = crypto.randomBytes(4).toString("hex");
  console.error("[error " + ref + "]", error);
  return res.status(500).json({ error: "Error interno del servidor (ref. " + ref + "). Inténtalo de nuevo o informa al administrador." });
}

app.get("/api/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true, database: "connected", sunatConfigured: isSunatConfigured() });
  } catch (error) {
    console.error("[health]", error.message);
    res.status(503).json({ ok: false, database: "disconnected" });
  }
});


function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header.split(";").map((part)=>part.trim()).filter(Boolean).map((part)=>{
      const index=part.indexOf("=");
      if (index < 0) return [part,""];
      return [part.slice(0,index), decodeURIComponent(part.slice(index+1))];
    })
  );
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function setSessionCookie(req, res, token, maxAgeSeconds=60*60*24*SESSION_DAYS) {
  const secure = PRODUCTION || req.secure;
  const attrs = [
    "below_session="+encodeURIComponent(token),
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age="+maxAgeSeconds,
  ];
  if (secure) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearSessionCookie(req, res) {
  const secure = PRODUCTION || req.secure;
  const attrs = [
    "below_session=",
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ];
  if (secure) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

async function getCurrentUser(req) {
  const token=parseCookies(req).below_session;
  if (!token) return null;

  const result=await query(
    `SELECT per.id, per.full_name, per.document_number, per.status,
            pr.id AS profile_id, pr.name AS profile
     FROM auth_sessions s
     JOIN personnel per ON per.id=s.personnel_id
     JOIN profiles pr ON pr.id=per.profile_id
     WHERE s.token_hash=$1
       AND s.expires_at > NOW()
       AND per.status='ACTIVO'`,
    [hashSessionToken(token)]
  );
  return result.rows[0] || null;
}

const ROLE_MODULES = {
  ADMIN: ["dashboard","finance","projects","expenses","advances","clients","clientprojects","profiles","personnel","concepts"],
  COORDINADOR: ["dashboard","finance","projects","expenses","advances","clients","clientprojects","personnel"],
  PRODUCTOR: ["dashboard","expenses","advances"],
  "SUB PRODUCTOR": ["dashboard","expenses","advances"],
  EJECUTIVO: [],
};

/**
 * The initial-admin form is offered only while nobody at all can sign in. Counting just
 * ADMIN holders would reopen it to anyone on the internet if that profile were emptied.
 */
async function systemInitialised(db) {
  const result=await db.query("SELECT EXISTS(SELECT 1 FROM personnel WHERE password_hash IS NOT NULL) AS ready");
  return Boolean(result.rows[0].ready);
}

app.get("/api/auth/status", async (_req,res)=>{
  try {
    res.json({ bootstrapRequired: !(await systemInitialised(pool)) });
  } catch(error) {
    dbError(res,error);
  }
});

async function createSession(db, personnelId) {
  const token=crypto.randomBytes(32).toString("hex");
  await db.query(
    "INSERT INTO auth_sessions (personnel_id,token_hash,expires_at) VALUES ($1,$2,NOW()+make_interval(days => $3))",
    [personnelId,hashSessionToken(token),SESSION_DAYS]
  );
  return token;
}

export async function purgeExpiredSessions(db=pool) {
  const result=await db.query("DELETE FROM auth_sessions WHERE expires_at <= NOW()");
  return result.rowCount || 0;
}

app.post("/api/auth/bootstrap", async (req,res)=>{
  const missing=requiredError(req.body,["full_name","document_number","password"]);
  if (missing) return res.status(400).json({ error:missing });
  if (!/^[A-Za-z0-9-]{6,20}$/.test(String(req.body.document_number).trim())) {
    return res.status(400).json({ error:"DNI / Pasaporte inválido." });
  }
  const weak=passwordError(req.body.password);
  if (weak) return res.status(400).json({ error:weak });

  const db=await pool.connect();
  try {
    await db.query("BEGIN");
    // Serialises simultaneous bootstrap attempts so only one initial ADMIN can exist.
    await db.query("SELECT pg_advisory_xact_lock(724190312)");
    if (await systemInitialised(db)) {
      await db.query("ROLLBACK");
      return res.status(409).json({ error:"El administrador inicial ya fue creado." });
    }
    const profile=await db.query("SELECT id FROM profiles WHERE name='ADMIN'");
    if (!profile.rows[0]) throw new Error("Perfil ADMIN no disponible.");

    const hash=await bcrypt.hash(String(req.body.password),12);
    const created=await db.query(
      `INSERT INTO personnel (full_name,document_number,profile_id,password_hash,status)
       VALUES ($1,$2,$3,$4,'ACTIVO')
       RETURNING id`,
      [
        String(req.body.full_name).trim().slice(0,180),
        String(req.body.document_number).trim().toUpperCase(),
        profile.rows[0].id,
        hash,
      ]
    );
    const token=await createSession(db,created.rows[0].id);
    await db.query("COMMIT");
    setSessionCookie(req,res,token);
    res.status(201).json({ ok:true });
  } catch(error) {
    await db.query("ROLLBACK").catch(()=>{});
    dbError(res,error);
  } finally {
    db.release();
  }
});

app.post("/api/auth/login", async (req,res)=>{
  try {
    const missing=requiredError(req.body,["document_number","password"]);
    if (missing) return res.status(400).json({ error:missing });

    const documentNumber=String(req.body.document_number).trim().slice(0,20);
    const password=String(req.body.password).slice(0,200);
    const wait=loginLimiter.blockedFor(req.ip,documentNumber);
    if (wait) {
      res.set("Retry-After",String(wait));
      return res.status(429).json({ error:"Demasiados intentos fallidos. Espera "+Math.ceil(wait/60)+" minuto(s) e inténtalo de nuevo." });
    }

    const result=await query(
      `SELECT per.id, per.full_name, per.document_number, per.password_hash, per.status,
              p.id AS profile_id, p.name AS profile
       FROM personnel per
       JOIN profiles p ON p.id=per.profile_id
       WHERE UPPER(per.document_number)=UPPER($1)
         AND per.status='ACTIVO'
         AND per.password_hash IS NOT NULL
       ORDER BY p.name, per.id`,
      [documentNumber]
    );

    // The same document may be registered with several profiles: check them all and
    // never pick one at random.
    const matches=[];
    for (const candidate of result.rows) {
      if (await bcrypt.compare(password,candidate.password_hash)) matches.push(candidate);
    }
    if (!result.rows.length) await bcrypt.compare(password,DUMMY_HASH);
    if (!matches.length) {
      loginLimiter.fail(req.ip,documentNumber);
      return res.status(401).json({ error:"Documento o contraseña incorrectos." });
    }

    let user=matches[0];
    if (matches.length > 1) {
      user=matches.find((m)=>String(m.profile_id)===String(req.body.profile_id || ""));
      if (!user) {
        return res.status(409).json({
          error:"Tu documento tiene más de un perfil. Elige con cuál deseas ingresar.",
          code:"PROFILE_REQUIRED",
          profiles:matches.map((m)=>({ id:m.profile_id, name:m.profile })),
        });
      }
    }
    loginLimiter.succeed(req.ip,documentNumber);

    const token=await createSession(pool,user.id);
    // Occasional housekeeping so the sessions table does not grow forever.
    if (Math.random() < 0.05) purgeExpiredSessions().catch((error)=>console.error("[sesiones]",error.message));
    setSessionCookie(req,res,token);
    res.json({
      id:user.id,
      full_name:user.full_name,
      document_number:user.document_number,
      profile:user.profile,
      modules:ROLE_MODULES[user.profile] || [],
    });
  } catch(error) {
    dbError(res,error);
  }
});

app.post("/api/auth/logout", async (req,res)=>{
  try {
    const token=parseCookies(req).below_session;
    if (token) await query("DELETE FROM auth_sessions WHERE token_hash=$1",[hashSessionToken(token)]);
    clearSessionCookie(req,res);
    res.json({ ok:true });
  } catch(error) {
    dbError(res,error);
  }
});

app.get("/api/auth/me", async (req,res)=>{
  try {
    const user=await getCurrentUser(req);
    if (!user) return res.status(401).json({ error:"No autenticado." });
    res.json({ ...user, modules:ROLE_MODULES[user.profile] || [] });
  } catch(error) {
    dbError(res,error);
  }
});

async function requireAuth(req,res,next) {
  try {
    const user=await getCurrentUser(req);
    if (!user) return res.status(401).json({ error:"Sesión no válida o expirada." });
    req.user=user;
    next();
  } catch(error) {
    dbError(res,error);
  }
}

function canManageModule(user,module,method) {
  if (user.profile === "ADMIN") return true;

  if (user.profile === "COORDINADOR") {
    if (["expenses","advances","clients","clientprojects","projects","personnel"].includes(module)) return true;
    if (["profiles","concepts"].includes(module)) return method === "GET";
    return false;
  }

  if (["PRODUCTOR","SUB PRODUCTOR"].includes(user.profile)) {
    if (["expenses","advances"].includes(module)) return true;
    if (["projects","clients","personnel","profiles","concepts"].includes(module)) return method === "GET";
    return false;
  }

  return false;
}

function moduleFromApiPath(path) {
  const first=String(path || "").split("/").filter(Boolean)[0] || "";
  if (first === "projects") return "projects";
  if (first === "expenses") return "expenses";
  if (first === "advances") return "advances";
  if (first === "clients") return "clients";
  if (first === "clientprojects") return "clientprojects";
  if (first === "profiles") return "profiles";
  if (first === "personnel") return "personnel";
  if (first === "concepts") return "concepts";
  return null;
}

app.use("/api", requireAuth, (req,res,next)=>{
  const module=moduleFromApiPath(req.path);
  if (!module) return next();
  if (!canManageModule(req.user,module,req.method)) {
    return res.status(403).json({ error:"No tienes permiso para realizar esta acción." });
  }
  next();
});

// Built on first use so the app always works with the current pool (tests inject one).
let routers = null;
const lazyRouters = () => routers ||= { workflow: createWorkflowRouter(pool), finance: createFinanceRouter(pool) };
app.use('/api/workflow', (req,res,next) => lazyRouters().workflow(req,res,next));
app.use('/api/finance', (req,res,next) => lazyRouters().finance(req,res,next));

// Reject edits before accepting an uploaded replacement. Database triggers provide
// the final protection if a concurrent review changes the state afterwards.
app.use('/api', async (req,res,next)=>{
  const match=req.path.match(/^\/(expenses|advances)\/(\d+)$/);
  if (!match || !['PUT','DELETE'].includes(req.method)) return next();
  try {
    const expense=match[1]==='expenses';
    const result=await query(expense ? 'SELECT approval_status AS status FROM expense_reports WHERE id=$1' : 'SELECT workflow_status AS status FROM advance_requests WHERE id=$1',[match[2]]);
    if(result.rows[0] && !(expense ? ['BORRADOR','OBSERVADO'] : ['SOLICITADO']).includes(result.rows[0].status)) {
      return res.status(409).json({error:expense ? 'La rendición está en revisión o aprobada. Solicita que sea observada antes de editar.' : 'El anticipo aprobado no puede editarse ni eliminarse.'});
    }
    next();
  } catch(error) { dbError(res,error); }
});

async function syncClientsFromMaster(db) {
  await db.query(`INSERT INTO clients(name,ruc,responsible_person)
    SELECT DISTINCT ON (TRIM(cp.ruc)) TRIM(cp.client_name), TRIM(cp.ruc), ''
    FROM client_projects_master cp
    WHERE cp.ruc ~ '^[0-9]{11}$' AND TRIM(cp.client_name)<>''
    ORDER BY TRIM(cp.ruc), cp.updated_at DESC NULLS LAST, cp.id DESC
    ON CONFLICT(ruc) DO UPDATE SET name=EXCLUDED.name
    WHERE clients.name IS DISTINCT FROM EXCLUDED.name`);
}

app.post("/api/clients/import", dataUpload.single("file"), async (req,res) => {
  if (!req.file) return res.status(400).json({error:"Selecciona un Excel o CSV."});
  try {
    const rows=await readSpreadsheetRows(req.file);
    const normalize=value=>String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim().toUpperCase().replace(/\s+/g," ");
    const pick=(row,aliases)=>Object.entries(row).find(([key])=>aliases.includes(normalize(key)))?.[1]?.toString().trim()||"";
    const valid=new Map(),errors=[];
    rows.forEach((row,i)=>{
      const ruc=pick(row,["RUC"]);
      const name=pick(row,["NOMBRE CLIENTE","NOMBRE DE CLIENTE","CLIENTE","RAZON SOCIAL"]);
      const responsible=pick(row,["PERSONA RESPONSABLE","RESPONSABLE","PERSONA DE CONTACTO","CONTACTO"]);
      if(!/^\d{11}$/.test(ruc)||!name) {errors.push("Fila "+(i+2)+": RUC inválido o cliente vacío.");return;}
      if(valid.has(ruc)) errors.push("Fila "+(i+2)+": RUC repetido, se usa la última fila válida.");
      valid.set(ruc,{ruc,name,responsible});
    });
    const db=await pool.connect();
    let inserted=0,updated=0;
    try {
      await db.query("BEGIN");
      for(const record of valid.values()){
        const existing=await db.query("SELECT id FROM clients WHERE ruc=$1 FOR UPDATE",[record.ruc]);
        if(existing.rows.length){
          await db.query("UPDATE clients SET name=$1,responsible_person=CASE WHEN $2<>'' THEN $2 ELSE responsible_person END WHERE id=$3",[record.name,record.responsible,existing.rows[0].id]);
          updated++;
        }else{
          await db.query("INSERT INTO clients(name,ruc,responsible_person) VALUES($1,$2,$3)",[record.name,record.ruc,record.responsible]);
          inserted++;
        }
      }
      await db.query("COMMIT");
    }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
    res.json({ok:true,total:rows.length,inserted,updated,skipped:rows.length-valid.size,errors:errors.slice(0,100)});
  }catch(error){
    if(error instanceof ImportFormatError) return res.status(400).json({error:error.message});
    console.error(error);res.status(400).json({error:"No se pudo importar el archivo. Revisa el formato y los datos."});
  }
});

app.post("/api/clientprojects/import", dataUpload.single("file"), async (req,res) => {
  if (!req.file) return res.status(400).json({error:"Selecciona un archivo Excel o CSV."});
  try {
    const rows=await readSpreadsheetRows(req.file);
    const normalize=s=>String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim().toUpperCase().replace(/\s+/g," ");
    const pick=(row,aliases)=>Object.entries(row).find(([key])=>aliases.includes(normalize(key)))?.[1]?.toString().trim()||"";
    const records=rows.map((row,index)=>({
      line:index+2,
      ruc:pick(row,["RUC"]),
      client_name:pick(row,["CLIENTE"]),
      project_name:pick(row,["NOMBRE DEL PROYECTO","NOMBRE PROYECTO","PROYECTO"]),
      project_code:pick(row,["CODIGO DEL PROYECTO","CODIGO PROYECTO","CODIGO"]).toUpperCase()
    }));
    const errors=[];
    const valid=new Map();
    for(const record of records) {
      if(!record.project_code || !record.client_name || !record.project_name || !/^\d{11}$/.test(record.ruc)) {
        errors.push("Fila "+record.line+": RUC inválido o campos obligatorios incompletos.");
        continue;
      }
      if(valid.has(record.project_code)) {
        errors.push("Fila "+record.line+": código repetido; se utilizará la última fila válida para "+record.project_code+".");
      }
      valid.set(record.project_code,record);
    }
    let inserted=0,updated=0;
    const client=await pool.connect();
    try {
      await client.query("BEGIN");
      for(const record of valid.values()) {
        const existing=await client.query("SELECT id FROM client_projects_master WHERE UPPER(project_code)=UPPER($1) FOR UPDATE",[record.project_code]);
        if(existing.rows[0]) {
          await client.query(
            "UPDATE client_projects_master SET ruc=$1,client_name=$2,project_name=$3,updated_at=NOW() WHERE id=$4",
            [record.ruc,record.client_name,record.project_name,existing.rows[0].id]
          );
          updated++;
        } else {
          await client.query(
            "INSERT INTO client_projects_master(ruc,client_name,project_name,project_code) VALUES($1,$2,$3,$4)",
            [record.ruc,record.client_name,record.project_name,record.project_code]
          );
          inserted++;
        }
      }
      await client.query("COMMIT");
    } catch(error) { await client.query("ROLLBACK");throw error; }
    finally { client.release(); }
    res.json({ok:true,total:records.length,inserted,updated,skipped:records.length-valid.size,errors:errors.slice(0,100)});
  } catch(error) {
    if(error instanceof ImportFormatError) return res.status(400).json({error:error.message});
    console.error(error);res.status(400).json({error:"Error al importar. Verifica columnas RUC, CLIENTE, NOMBRE DEL PROYECTO y CODIGO DEL PROYECTO."});
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
    const values = config.fields.map((field) => {
      const value = String(req.body[field]).trim();
      if (type === "profiles" && field === "name") return value.toUpperCase();
      if (type === "clientprojects" && field === "project_code") return value.toUpperCase();
      return value;
    });
    const placeholders = config.fields.map((_, i) => "$" + (i + 1)).join(", ");
    const result = await query(
      "INSERT INTO " + config.table + " (" + config.fields.join(", ") + ") VALUES (" + placeholders + ") RETURNING *",
      values
    );
    if (type === "clientprojects") await syncClientsFromMaster(pool);
    res.status(201).json(result.rows[0]);
  } catch (error) { dbError(res, error); }
});

// Permissions are tied to these names: renaming or deleting one would lock everyone out.
const SYSTEM_PROFILES = new Set(["ADMIN","COORDINADOR","PRODUCTOR","SUB PRODUCTOR","EJECUTIVO"]);
async function systemProfileGuard(type, id) {
  if (type !== "profiles") return null;
  const current = await query("SELECT name FROM profiles WHERE id=$1", [id]);
  return current.rows[0] && SYSTEM_PROFILES.has(current.rows[0].name)
    ? "Los perfiles del sistema (ADMIN, COORDINADOR, PRODUCTOR, SUB PRODUCTOR, EJECUTIVO) no se pueden renombrar ni eliminar."
    : null;
}

app.put("/api/:type/:id", async (req, res, next) => {
  const type = req.params.type;
  const config = catalogs[type];
  if (!config) return next();
  try {
    const locked = await systemProfileGuard(type, req.params.id);
    if (locked) return res.status(409).json({ error: locked });
  } catch (error) { return dbError(res, error); }

  const validation = requiredError(req.body, config.required) || identityError(type, req.body);
  if (validation) return res.status(400).json({ error: validation });

  try {
    const values = config.fields.map((field) => {
      const value = String(req.body[field]).trim();
      if (type === "profiles" && field === "name") return value.toUpperCase();
      if (type === "clientprojects" && field === "project_code") return value.toUpperCase();
      return value;
    });
    const setSql = config.fields.map((field, i) => field + "=$" + (i + 1)).join(", ");
    values.push(req.params.id);
    const result = await query(
      "UPDATE " + config.table + " SET " + setSql + " WHERE id=$" + values.length + " RETURNING *",
      values
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Registro no encontrado." });
    if (type === "clientprojects") await syncClientsFromMaster(pool);
    res.json(result.rows[0]);
  } catch (error) { dbError(res, error); }
});

app.delete("/api/:type/:id", async (req, res, next) => {
  const config = catalogs[req.params.type];
  if (!config) return next();
  try {
    const locked = await systemProfileGuard(req.params.type, req.params.id);
    if (locked) return res.status(409).json({ error: locked });
    const result = await query("DELETE FROM " + config.table + " WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Registro no encontrado." });
    res.json({ ok: true });
  } catch (error) { dbError(res, error); }
});

app.get("/api/personnel", async (req, res) => {
  try {
    // Productores only need their own record (for their forms); never the whole staff list.
    if (["PRODUCTOR","SUB PRODUCTOR"].includes(req.user.profile)) {
      const own = await query(
        `SELECT per.id, per.full_name, per.document_number, per.profile_id, p.name AS profile, per.status
         FROM personnel per JOIN profiles p ON p.id=per.profile_id WHERE per.id=$1`,
        [req.user.id]
      );
      return res.json(own.rows);
    }
    const result = await query(
      `SELECT per.id, per.full_name, per.document_number, per.profile_id,
              p.name AS profile, per.status,
              (per.password_hash IS NOT NULL) AS password_configured,
              per.created_at, per.updated_at
       FROM personnel per
       JOIN profiles p ON p.id=per.profile_id
       ORDER BY per.full_name ASC, p.name ASC`
    );
    res.json(result.rows);
  } catch (error) {
    dbError(res, error);
  }
});

function validatePersonnel(body, editing=false) {
  const required = ["full_name","document_number","profile_id","status"];
  const missing = requiredError(body, required);
  if (missing) return missing;

  if (!["ACTIVO","INACTIVO"].includes(String(body.status))) {
    return "Estado inválido.";
  }
  if (!/^[A-Za-z0-9-]{6,20}$/.test(String(body.document_number).trim())) {
    return "DNI / Pasaporte debe tener entre 6 y 20 caracteres alfanuméricos.";
  }
  if (String(body.full_name).trim().length > 180) return "El nombre no puede superar 180 caracteres.";
  if (!editing || body.password) return passwordError(body.password);
  return null;
}

app.post("/api/personnel", async (req, res) => {
  const validation = validatePersonnel(req.body, false);
  if (validation) return res.status(400).json({ error: validation });

  try {
    const profile = await query("SELECT id, name FROM profiles WHERE id=$1", [req.body.profile_id]);
    if (!profile.rows[0]) return res.status(400).json({ error: "El perfil seleccionado no existe." });
    if (req.user.profile === "COORDINADOR" && ["ADMIN","COORDINADOR"].includes(profile.rows[0].name)) {
      return res.status(403).json({ error: "El Coordinador no puede asignar perfiles ADMIN o COORDINADOR." });
    }

    const passwordHash = await bcrypt.hash(String(req.body.password), 12);
    const result = await query(
      `INSERT INTO personnel
       (full_name, document_number, profile_id, password_hash, status)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, full_name, document_number, profile_id, status,
                 true AS password_configured, created_at, updated_at`,
      [
        String(req.body.full_name).trim(),
        String(req.body.document_number).trim().toUpperCase(),
        Number(req.body.profile_id),
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
    const profile = await query("SELECT id, name FROM profiles WHERE id=$1", [req.body.profile_id]);
    if (!profile.rows[0]) return res.status(400).json({ error: "El perfil seleccionado no existe." });
    if (req.user.profile === "COORDINADOR" && ["ADMIN","COORDINADOR"].includes(profile.rows[0].name)) {
      return res.status(403).json({ error: "El Coordinador no puede asignar perfiles ADMIN o COORDINADOR." });
    }

    const current = await query(
      `SELECT per.id, p.name AS current_profile
       FROM personnel per JOIN profiles p ON p.id=per.profile_id
       WHERE per.id=$1`,
      [req.params.id]
    );
    if (!current.rows[0]) return res.status(404).json({ error: "Personal no encontrado." });
    if (req.user.profile === "COORDINADOR" && ["ADMIN","COORDINADOR"].includes(current.rows[0].current_profile)) {
      return res.status(403).json({ error: "El Coordinador no puede modificar usuarios ADMIN o COORDINADOR." });
    }
    const losesAdmin = current.rows[0].current_profile === "ADMIN" &&
      (profile.rows[0].name !== "ADMIN" || String(req.body.status) !== "ACTIVO");
    if (losesAdmin && await activeAdminCount(req.params.id) === 0) {
      return res.status(409).json({ error: "Debe quedar al menos un ADMIN activo." });
    }

    let passwordHash = null;
    if (req.body.password) {
      passwordHash = await bcrypt.hash(String(req.body.password), 12);
    }

    const result = await query(
      `UPDATE personnel SET
        full_name=$1,
        document_number=$2,
        profile_id=$3,
        status=$4,
        password_hash=COALESCE($5,password_hash),
        updated_at=NOW()
       WHERE id=$6
       RETURNING id, full_name, document_number, profile_id, status,
                 (password_hash IS NOT NULL) AS password_configured,
                 created_at, updated_at`,
      [
        String(req.body.full_name).trim(),
        String(req.body.document_number).trim().toUpperCase(),
        Number(req.body.profile_id),
        String(req.body.status),
        passwordHash,
        req.params.id,
      ]
    );
    // A new password, a different profile or deactivation closes that person's other sessions.
    const credentialsChanged = Boolean(passwordHash) || String(req.body.status) !== "ACTIVO" ||
      String(profile.rows[0].name) !== String(current.rows[0].current_profile);
    if (credentialsChanged) {
      const currentToken = parseCookies(req).below_session || "";
      await query("DELETE FROM auth_sessions WHERE personnel_id=$1 AND token_hash<>$2", [req.params.id, hashSessionToken(currentToken)]);
    }
    res.json(result.rows[0]);
  } catch (error) {
    dbError(res, error);
  }
});

async function activeAdminCount(excludingId) {
  const result = await query(
    `SELECT COUNT(*)::int AS total FROM personnel per JOIN profiles p ON p.id=per.profile_id
     WHERE p.name='ADMIN' AND per.status='ACTIVO' AND per.password_hash IS NOT NULL AND per.id<>$1`,
    [excludingId]
  );
  return Number(result.rows[0].total);
}

app.delete("/api/personnel/:id", async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user.id)) {
      return res.status(409).json({ error: "No puedes eliminar tu propio usuario." });
    }
    const target = await query(
      `SELECT p.name AS profile FROM personnel per JOIN profiles p ON p.id=per.profile_id WHERE per.id=$1`,
      [req.params.id]
    );
    if (target.rows[0]?.profile === "ADMIN" && await activeAdminCount(req.params.id) === 0) {
      return res.status(409).json({ error: "Debe quedar al menos un ADMIN activo." });
    }
    if (req.user.profile === "COORDINADOR") {
      const target=await query(
        `SELECT p.name AS profile
         FROM personnel per JOIN profiles p ON p.id=per.profile_id
         WHERE per.id=$1`,
        [req.params.id]
      );
      if (target.rows[0] && ["ADMIN","COORDINADOR"].includes(target.rows[0].profile)) {
        return res.status(403).json({ error:"El Coordinador no puede eliminar usuarios ADMIN o COORDINADOR." });
      }
    }
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

app.get("/api/projects", async (req, res) => {
  try {
    const restricted = ["PRODUCTOR","SUB PRODUCTOR"].includes(req.user.profile);
    const where = restricted ? " WHERE p.producer_id=$1 OR p.subproducer_id=$1 " : " ";
    const params = restricted ? [req.user.id] : [];
    const result = await query(
      projectSelect + where + " GROUP BY p.id, c.name, c.ruc, pr.full_name, sp.full_name, e.full_name ORDER BY p.id DESC",
      params
    );
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
  const ids = [...new Set((conceptIds || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
  await client.query('DELETE FROM project_event_concepts WHERE project_id=$1 AND NOT (concept_id=ANY($2::bigint[]))',[projectId,ids]);
  for (const id of ids) {
    await client.query("INSERT INTO project_event_concepts (project_id, concept_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [projectId, id]);
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

async function syncProjectToMaster(db, project) {
  const clientResult = await db.query("SELECT ruc,name FROM clients WHERE id=$1", [project.client_id]);
  const customer = clientResult.rows[0];
  if (!customer || !/^\d{11}$/.test(String(customer.ruc || ""))) {
    throw new Error("El cliente debe tener un RUC válido para sincronizar el proyecto.");
  }
  const code = String(project.project_code).trim().toUpperCase();
  await db.query(
    `INSERT INTO client_projects_master(ruc,client_name,project_name,project_code)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(project_code) DO UPDATE SET
       ruc=EXCLUDED.ruc,client_name=EXCLUDED.client_name,
       project_name=EXCLUDED.project_name,updated_at=NOW()`,
    [customer.ruc,customer.name,project.project_name,code]
  );
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
    await syncProjectToMaster(client, result.rows[0]);
    await client.query("UPDATE clients SET responsible_person=$1 WHERE id=$2", [String(req.body.contact_name).trim(),req.body.client_id]);
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
    await syncProjectToMaster(client, result.rows[0]);
    await client.query("UPDATE clients SET responsible_person=$1 WHERE id=$2", [String(req.body.contact_name).trim(),req.body.client_id]);
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

app.get("/api/expenses", async (req, res) => {
  try {
    const restricted = ["PRODUCTOR","SUB PRODUCTOR"].includes(req.user.profile);
    const result = restricted
      ? await query(expenseSelect + " WHERE er.producer_id=$1 ORDER BY er.id DESC", [req.user.id])
      : await query(expenseSelect + " ORDER BY er.id DESC");
    res.json({ rows: result.rows, sunatConfigured: isSunatConfigured() });
  } catch (error) { dbError(res, error); }
});

app.get("/api/expenses/:id/file", async (req, res) => {
  try {
    const result = await query("SELECT * FROM expense_reports WHERE id=$1", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Archivo no encontrado." });
    if (["PRODUCTOR","SUB PRODUCTOR"].includes(req.user.profile) && Number(result.rows[0].producer_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "No tienes permiso para ver este archivo." });
    }
    await sendEvidence(res, result.rows[0]);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ error: "No se pudo abrir el archivo." });
  }
});

function isIsoDate(value) {
  const m = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 2000;
}

/** YYYY-MM-DD in Peru, optionally shifted by whole days. */
function limaDate(offsetDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() + offsetDays * 86400000));
}

function validateExpenseInput(body) {
  const required = ["project_id","concept_id","producer_id","document_type","issuer_ruc","series","document_number","issue_date","amount"];
  const missing = requiredError(body, required);
  if (missing) return missing;
  if (!["01","03"].includes(String(body.document_type))) return "Tipo de comprobante inválido.";
  if (!/^\d{11}$/.test(String(body.issuer_ruc))) return "El RUC emisor debe tener 11 dígitos.";
  if (!/^[A-Za-z0-9]{1,4}$/.test(String(body.series))) return "La serie debe tener hasta 4 caracteres.";
  if (!/^\d{1,20}$/.test(String(body.document_number || "").trim())) return "Número de comprobante inválido.";
  if (!(Number(body.amount) > 0)) return "El importe debe ser mayor a 0.";
  if (!isIsoDate(body.issue_date)) return "La fecha de emisión no es válida.";
  if (String(body.issue_date) > limaDate(1)) return "La fecha de emisión no puede ser futura.";
  return null;
}

/** Same receipt even when typed with other leading zeros or lowercase series. */
async function duplicateExpense(body, excludeId = null) {
  const result = await query(
    `SELECT id FROM expense_reports
     WHERE issuer_ruc=$1 AND document_type=$2 AND UPPER(series)=UPPER($3)
       AND COALESCE(NULLIF(LTRIM(document_number,'0'),''),'0')=COALESCE(NULLIF(LTRIM($4,'0'),''),'0')
       AND ($5::bigint IS NULL OR id<>$5::bigint)
     LIMIT 1`,
    [String(body.issuer_ruc).trim(), String(body.document_type), String(body.series).trim(), String(body.document_number).trim(), excludeId]
  );
  return result.rows[0]?.id || null;
}

/** Removes a file uploaded during a request whose database change failed. */
async function discardEvidence(saved) {
  try { await removeEvidence(saved); }
  catch (error) { console.error("[archivos] No se pudo limpiar " + saved.key + ":", error.message); }
}

app.get("/api/sunat/status", async (req, res) => {
  if (!["ADMIN","COORDINADOR"].includes(req.user.profile)) {
    return res.status(403).json({ error: "No tienes permiso para revisar la configuración SUNAT." });
  }

  try {
    const status = await testSunatConnection();
    res.status(status.connected ? 200 : 503).json(status);
  } catch (error) {
    dbError(res, error);
  }
});

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
        status === "VALIDADO"
          ? "Consulta procesada por SUNAT: comprobante ACEPTADO."
          : status === "NO_EXISTE"
            ? "Consulta procesada por SUNAT: comprobante NO INFORMADO / NO EXISTE con los datos enviados."
            : (data?.message || null),
        JSON.stringify(data?.data?.Observaciones || data?.data?.observaciones || []),
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
    checkEvidenceFile(req.file);
  } catch (error) { return res.status(400).json({ error: error.message }); }

  try {
    const result = await readReceiptDocument(req.file);
    res.json(result);
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error("Error leyendo comprobante:", error);
    res.status(500).json({ error: "No se pudo leer automáticamente el documento. Puedes completar los campos manualmente." });
  }
});

app.post("/api/expenses", upload.single("document"), async (req, res) => {
  const validation = validateExpenseInput(req.body);
  if (validation) return res.status(400).json({ error: validation });
  if (!req.file) return res.status(400).json({ error: "Debes adjuntar el PDF o foto del comprobante." });

  let stored = null;
  try {
    checkEvidenceFile(req.file);
    const projectCheck = await query(
      "SELECT id, producer_id, subproducer_id FROM projects WHERE id=$1",
      [req.body.project_id]
    );
    if (!projectCheck.rows[0]) return res.status(404).json({ error: "Proyecto no encontrado." });

    if (["PRODUCTOR","SUB PRODUCTOR"].includes(req.user.profile)) {
      const assigned = [projectCheck.rows[0].producer_id, projectCheck.rows[0].subproducer_id]
        .filter(Boolean).map(Number);
      if (!assigned.includes(Number(req.user.id))) {
        return res.status(403).json({ error: "Este proyecto no está asignado a tu usuario." });
      }
      req.body.producer_id = String(req.user.id);
    }

    const linkCheck = await query(
      "SELECT 1 FROM project_event_concepts WHERE project_id=$1 AND concept_id=$2",
      [req.body.project_id, req.body.concept_id]
    );
    if (!linkCheck.rows[0]) {
      return res.status(400).json({ error: "El concepto seleccionado no está asignado a este proyecto." });
    }
    const duplicate = await duplicateExpense(req.body, null);
    if (duplicate) {
      return res.status(409).json({ error: "Este comprobante ya fue registrado (rendición #" + duplicate + "). Revisa serie y número." });
    }

    stored = await saveEvidence(req.file);
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

    stored = null; // now referenced by the database row
    const validationResult = await runSunatValidation(inserted.rows[0].id);
    const finalRow = await query(expenseSelect + " WHERE er.id=$1", [inserted.rows[0].id]);
    res.status(201).json({ row: finalRow.rows[0], validation: validationResult });
  } catch (error) {
    if (stored) await discardEvidence(stored);
    dbError(res, error);
  }
});

app.put("/api/expenses/:id", upload.single("document"), async (req, res) => {
  const validation = validateExpenseInput(req.body);
  if (validation) return res.status(400).json({ error: validation });

  let stored = null;
  try {
    if (req.file) checkEvidenceFile(req.file);
    const current = await query("SELECT * FROM expense_reports WHERE id=$1", [req.params.id]);
    if (!current.rows[0]) return res.status(404).json({ error: "Rendición no encontrada." });
    if (["PRODUCTOR","SUB PRODUCTOR"].includes(req.user.profile) && Number(current.rows[0].producer_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "No puedes editar esta rendición." });
    }

    const projectCheck = await query(
      "SELECT id, producer_id, subproducer_id FROM projects WHERE id=$1",
      [req.body.project_id]
    );
    if (!projectCheck.rows[0]) return res.status(404).json({ error: "Proyecto no encontrado." });

    if (["PRODUCTOR","SUB PRODUCTOR"].includes(req.user.profile)) {
      const assigned = [projectCheck.rows[0].producer_id, projectCheck.rows[0].subproducer_id]
        .filter(Boolean).map(Number);
      if (!assigned.includes(Number(req.user.id))) {
        return res.status(403).json({ error: "Este proyecto no está asignado a tu usuario." });
      }
      req.body.producer_id = String(req.user.id);
    }

    const linkCheck = await query(
      "SELECT 1 FROM project_event_concepts WHERE project_id=$1 AND concept_id=$2",
      [req.body.project_id, req.body.concept_id]
    );
    if (!linkCheck.rows[0]) {
      return res.status(400).json({ error: "El concepto seleccionado no está asignado a este proyecto." });
    }
    const duplicate = await duplicateExpense(req.body, req.params.id);
    if (duplicate) {
      return res.status(409).json({ error: "Este comprobante ya fue registrado (rendición #" + duplicate + "). Revisa serie y número." });
    }

    let fileName = current.rows[0].file_name;
    let fileMime = current.rows[0].file_mime;
    let fileStorage = current.rows[0].file_storage;
    let fileKey = current.rows[0].file_key;

    if (req.file) {
      stored = await saveEvidence(req.file);
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

    // A draft's replaced receipt was never reviewed: remove it. An observed report keeps its
    // previous file in storage, since the reviewer's observation referred to it.
    const previous = current.rows[0];
    if (stored && previous.approval_status === "BORRADOR" && previous.file_key && previous.file_key !== stored.key) {
      await discardEvidence({ storage: previous.file_storage, key: previous.file_key });
    }
    stored = null;
    const validationResult = await runSunatValidation(req.params.id);
    const finalRow = await query(expenseSelect + " WHERE er.id=$1", [req.params.id]);
    res.json({ row: finalRow.rows[0], validation: validationResult });
  } catch (error) {
    if (stored) await discardEvidence(stored);
    dbError(res, error);
  }
});

app.post("/api/expenses/:id/validate", async (req, res) => {
  try {
    if (["PRODUCTOR","SUB PRODUCTOR"].includes(req.user.profile)) {
      const own=await query("SELECT producer_id FROM expense_reports WHERE id=$1",[req.params.id]);
      if (!own.rows[0] || Number(own.rows[0].producer_id)!==Number(req.user.id)) {
        return res.status(403).json({ error:"No puedes validar esta rendición." });
      }
    }
    const result = await runSunatValidation(req.params.id);
    const row = await query(expenseSelect + " WHERE er.id=$1", [req.params.id]);
    if (!row.rows[0]) return res.status(404).json({ error: "Rendición no encontrada." });
    res.json({ row: row.rows[0], validation: result });
  } catch (error) { dbError(res, error); }
});

app.delete("/api/expenses/:id", async (req, res) => {
  try {
    if (["PRODUCTOR","SUB PRODUCTOR"].includes(req.user.profile)) {
      const own=await query("SELECT producer_id FROM expense_reports WHERE id=$1",[req.params.id]);
      if (!own.rows[0] || Number(own.rows[0].producer_id)!==Number(req.user.id)) {
        return res.status(403).json({ error:"No puedes eliminar esta rendición." });
      }
    }
    const result = await query("DELETE FROM expense_reports WHERE id=$1 RETURNING id, file_storage AS storage, file_key AS key", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Rendición no encontrada." });
    // Only drafts/observed reports reach this point; their receipt is not part of any approval.
    if (result.rows[0].key) await discardEvidence(result.rows[0]);
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
  if (!(Number(body.amount) > 0)) return "El monto a depositar debe ser mayor a 0.";
  for (const [field,label] of [["request_date","solicitud"],["deposit_date","abono"],["settlement_date","rendición"]]) {
    if (!isIsoDate(body[field])) return "La fecha de "+label+" no es válida.";
  }
  if (String(body.settlement_date) < String(body.deposit_date)) return "La fecha de rendición no puede ser anterior a la fecha de abono.";

  return null;
}

function advanceRequestValues(body) {
  return [
    String(body.company).trim(),
    body.request_date,
    String(body.applicant_name).trim(),
    body.applicant_personnel_id ? Number(body.applicant_personnel_id) : null,
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

app.get("/api/advances", async (req, res) => {
  try {
    const restricted = ["PRODUCTOR","SUB PRODUCTOR"].includes(req.user.profile);
    const result = restricted
      ? await query(
          advanceRequestSelect + " WHERE ar.applicant_personnel_id=$1 ORDER BY ar.id DESC",
          [req.user.id]
        )
      : await query(advanceRequestSelect + " ORDER BY ar.id DESC");
    res.json({ rows: result.rows });
  } catch (error) {
    dbError(res, error);
  }
});

app.post("/api/advances", async (req, res) => {
  if (["PRODUCTOR","SUB PRODUCTOR"].includes(req.user.profile)) {
    req.body.applicant_name=req.user.full_name;
    req.body.applicant_personnel_id=String(req.user.id);
  }

  const validation = validateAdvanceRequest(req.body);
  if (validation) return res.status(400).json({ error: validation });

  try {
    const project = await query("SELECT id, producer_id, subproducer_id FROM projects WHERE id=$1", [req.body.project_id]);
    if (!project.rows[0]) return res.status(404).json({ error: "Proyecto no encontrado." });
    if (["PRODUCTOR","SUB PRODUCTOR"].includes(req.user.profile)) {
      const assigned=[project.rows[0].producer_id,project.rows[0].subproducer_id].filter(Boolean).map(Number);
      if (!assigned.includes(Number(req.user.id))) {
        return res.status(403).json({ error:"Este proyecto no está asignado a tu usuario." });
      }
    }

    const result = await query(
      `INSERT INTO advance_requests (
        company, request_date, applicant_name, applicant_personnel_id, account_number, account_type,
        account_holder, bank, cci, beneficiary_document, beneficiary_name,
        amount, project_id, deposit_date, settlement_date, observations,
        expected_document_type
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
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
  try {
    const current=await query("SELECT * FROM advance_requests WHERE id=$1",[req.params.id]);
    if (!current.rows[0]) return res.status(404).json({ error:"Anticipo no encontrado." });
    if (["PRODUCTOR","SUB PRODUCTOR"].includes(req.user.profile)) {
      if (Number(current.rows[0].applicant_personnel_id)!==Number(req.user.id)) {
        return res.status(403).json({ error:"No puedes editar este anticipo." });
      }
      req.body.applicant_name=req.user.full_name;
      req.body.applicant_personnel_id=String(req.user.id);
    }

    const validation = validateAdvanceRequest(req.body);
    if (validation) return res.status(400).json({ error: validation });

    const project = await query("SELECT producer_id, subproducer_id FROM projects WHERE id=$1", [req.body.project_id]);
    if (!project.rows[0]) return res.status(404).json({ error: "Proyecto no encontrado." });
    if (["PRODUCTOR","SUB PRODUCTOR"].includes(req.user.profile)) {
      const assigned=[project.rows[0].producer_id,project.rows[0].subproducer_id].filter(Boolean).map(Number);
      if (!assigned.includes(Number(req.user.id))) {
        return res.status(403).json({ error:"Este proyecto no está asignado a tu usuario." });
      }
    }

    const values = [...advanceRequestValues(req.body), req.params.id];
    const result = await query(
      `UPDATE advance_requests SET
        company=$1,
        request_date=$2,
        applicant_name=$3,
        applicant_personnel_id=$4,
        account_number=$5,
        account_type=$6,
        account_holder=$7,
        bank=$8,
        cci=$9,
        beneficiary_document=$10,
        beneficiary_name=$11,
        amount=$12,
        project_id=$13,
        deposit_date=$14,
        settlement_date=$15,
        observations=$16,
        expected_document_type=$17,
        updated_at=NOW()
       WHERE id=$18
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
    if (["PRODUCTOR","SUB PRODUCTOR"].includes(req.user.profile)) {
      const current=await query("SELECT applicant_personnel_id, applicant_name FROM advance_requests WHERE id=$1",[req.params.id]);
      if (!current.rows[0]) return res.status(404).json({ error:"Anticipo no encontrado." });
      if (Number(current.rows[0].applicant_personnel_id)!==Number(req.user.id)) {
        return res.status(403).json({ error:"No puedes eliminar este anticipo." });
      }
    }
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
    // The PDF holds bank details: only reviewers and the applicant may open it.
    if (!["ADMIN","COORDINADOR"].includes(req.user.profile) && Number(row.applicant_personnel_id)!==Number(req.user.id)) {
      return res.status(404).json({ error: "Anticipo no encontrado." });
    }

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const filename = "anticipo-" + String(row.project_code || row.id).replace(/[^A-Za-z0-9_-]/g, "_") + ".pdf";

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", contentDisposition(req.query.download === "1" ? "attachment" : "inline", filename));

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
    const messages = {
      LIMIT_FILE_SIZE: "El archivo supera el tamaño máximo permitido.",
      LIMIT_FILE_COUNT: "Adjunta un solo archivo.",
      LIMIT_UNEXPECTED_FILE: "Adjunta un solo archivo en el campo indicado.",
    };
    return res.status(400).json({ error: messages[error.code] || "No se pudo recibir el archivo." });
  }
  if (error.message?.includes("Solo se permiten")) return res.status(400).json({ error: error.message });
  if (error.type === "entity.parse.failed") return res.status(400).json({ error: "Los datos enviados no tienen un formato válido." });
  if (error.type === "entity.too.large") return res.status(413).json({ error: "Los datos enviados son demasiado grandes." });
  return dbError(res, error);
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Ruta no encontrada." }));
app.get("*", (_req, res) => res.sendFile("index.html", { root: "public" }));

/** Lists existing duplicate receipts that prevent the normalized unique index. */
async function warnDuplicateReceipts() {
  const index = await query("SELECT 1 FROM pg_indexes WHERE indexname='uq_expense_document_normalized'");
  if (index.rows.length) return;
  const dup = await query(`SELECT issuer_ruc, document_type, UPPER(series) AS series,
      COALESCE(NULLIF(LTRIM(document_number,'0'),''),'0') AS number, ARRAY_AGG(id ORDER BY id) AS ids
    FROM expense_reports GROUP BY 1,2,3,4 HAVING COUNT(*)>1 LIMIT 20`);
  for (const d of dup.rows) {
    console.warn("[duplicados] Comprobante " + d.issuer_ruc + " " + d.series + "-" + d.number + " registrado en rendiciones " + d.ids.join(", ") + ". Revísalas y elimina la repetida.");
  }
}

export async function start() {
  try {
    await ensureSchema();
  } catch (error) {
    console.error("No se pudo inicializar la base de datos:");
    console.error(error);
    process.exit(1);
  }

  warnDuplicateReceipts().catch((error) => console.error("[duplicados]", error.message));
  const server = app.listen(PORT, () => console.log("Below Rendiciones activo en puerto " + PORT));
  server.headersTimeout = 65_000;
  server.requestTimeout = 120_000;

  const cleanup = setInterval(() => {
    purgeExpiredSessions()
      .then((count) => { if (count) console.log("[sesiones] Eliminadas " + count + " sesiones vencidas."); })
      .catch((error) => console.error("[sesiones]", error.message));
  }, 6 * 60 * 60 * 1000);
  cleanup.unref();
  purgeExpiredSessions().catch(() => {});

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(signal + " recibido: cerrando sin cortar solicitudes en curso…");
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    server.close(async () => {
      await Promise.allSettled([pool.end(), closeDocumentReader()]);
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  return server;
}

process.on("unhandledRejection", (error) => console.error("[unhandledRejection]", error));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
