import crypto from "node:crypto";

export const MIN_PASSWORD_LENGTH = 8;

/** Validates a new password. Existing shorter passwords keep working until changed. */
export function passwordError(password) {
  const value = String(password ?? "");
  if (value.length < MIN_PASSWORD_LENGTH) return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (value.length > 72) return "La contraseña no puede superar 72 caracteres.";
  if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(value) || !/\d/.test(value)) return "La contraseña debe combinar letras y números.";
  return null;
}

/**
 * In-memory limiter for failed login attempts. It counts failures only, per IP and
 * per IP+document, so one person cannot lock out a colleague from another network.
 * With several app instances each keeps its own counters (still a strong brake).
 */
export function createLoginLimiter({ windowMs = 15 * 60 * 1000, perAccount = 8, perIp = 40 } = {}) {
  const hits = new Map();
  const bump = (key, now) => {
    const entry = hits.get(key);
    if (!entry || entry.reset <= now) hits.set(key, { count: 1, reset: now + windowMs });
    else entry.count++;
  };
  const over = (key, limit, now) => {
    const entry = hits.get(key);
    return entry && entry.reset > now && entry.count >= limit ? entry.reset : 0;
  };
  const keys = (ip, documentNumber) => ["ip:" + ip, "acc:" + ip + ":" + String(documentNumber || "").trim().toUpperCase()];
  const prune = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, 60 * 1000);
  prune.unref?.();
  return {
    /** Returns seconds to wait, or 0 when the attempt may proceed. */
    blockedFor(ip, documentNumber, now = Date.now()) {
      const [ipKey, accountKey] = keys(ip, documentNumber);
      const until = Math.max(over(ipKey, perIp, now), over(accountKey, perAccount, now));
      return until ? Math.ceil((until - now) / 1000) : 0;
    },
    fail(ip, documentNumber, now = Date.now()) {
      for (const key of keys(ip, documentNumber)) bump(key, now);
    },
    succeed(ip, documentNumber) {
      hits.delete(keys(ip, documentNumber)[1]);
    },
    reset() { hits.clear(); },
  };
}

/**
 * Blocks state-changing API calls coming from another site (CSRF defence in depth on
 * top of SameSite=Lax cookies). Requests without Origin (curl, server-to-server) pass;
 * they cannot carry the browser session cookie cross-site anyway.
 */
export function sameOriginGuard(allowedOrigins = []) {
  const allowed = new Set(allowedOrigins.map((o) => o.trim().replace(/\/$/, "")).filter(Boolean));
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (req.get("sec-fetch-site") === "cross-site") {
      return res.status(403).json({ error: "Solicitud bloqueada: origen no permitido." });
    }
    const origin = req.get("origin");
    if (!origin) return next();
    let originHost;
    try { originHost = new URL(origin).host; } catch { return res.status(403).json({ error: "Solicitud bloqueada: origen no permitido." }); }
    const hosts = [req.get("x-forwarded-host"), req.get("host")].filter(Boolean).map((h) => h.split(",")[0].trim());
    if (hosts.includes(originHost) || allowed.has(origin.replace(/\/$/, ""))) return next();
    return res.status(403).json({ error: "Solicitud bloqueada: origen no permitido." });
  };
}

const SIGNATURES = [
  ["application/pdf", (b) => b.subarray(0, 5).toString("latin1") === "%PDF-"],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/png", (b) => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))],
  ["image/webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
];

/** Detects the real type from the file content (never trusts the browser's declared type). */
export function detectEvidenceType(buffer) {
  if (!buffer?.length) return null;
  return SIGNATURES.find(([, test]) => test(buffer))?.[0] || null;
}

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** Content-Disposition that never throws on accents, emojis or quotes in file names. */
export function contentDisposition(type, fileName, fallback = "archivo") {
  const name = String(fileName || fallback).replace(/[\r\n"\\/]/g, "_").slice(0, 180) || fallback;
  const ascii = name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
