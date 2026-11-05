import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { contentDisposition } from "./security.js";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const localDir = path.resolve("uploads");

function spacesConfigured() {
  return Boolean(
    process.env.SPACES_ENDPOINT &&
    process.env.SPACES_BUCKET &&
    process.env.SPACES_KEY &&
    process.env.SPACES_SECRET
  );
}

let s3;
function spacesClient() {
  return s3 ||= new S3Client({
    endpoint: process.env.SPACES_ENDPOINT,
    region: process.env.SPACES_REGION || "us-east-1",
    forcePathStyle: false,
    credentials: {
      accessKeyId: process.env.SPACES_KEY,
      secretAccessKey: process.env.SPACES_SECRET,
    },
  });
}

// The extension comes from the verified type, never from the name the user chose.
function extensionFor(file) {
  return { "application/pdf": ".pdf", "image/png": ".png", "image/webp": ".webp", "image/jpeg": ".jpg" }[file.mimetype] || ".bin";
}

export async function saveEvidence(file, folder='rendiciones') {
  if (!['rendiciones','constancias'].includes(folder)) throw new Error('Carpeta de evidencia inválida.');
  const key = folder + "/" +
    new Date().toISOString().slice(0, 10) + "/" +
    crypto.randomUUID() + extensionFor(file);

  if (spacesConfigured()) {
    const client = spacesClient();
    await client.send(new PutObjectCommand({
      Bucket: process.env.SPACES_BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      Metadata: { originalname: encodeURIComponent(file.originalname || "comprobante") },
    }));
    return { storage: "spaces", key };
  }

  const target = path.join(localDir, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, file.buffer);
  return { storage: "local", key };
}

// Used only to clean up a newly uploaded object if its database transaction fails.
export async function removeEvidence(saved) {
  if(saved.storage==='spaces') {
    await spacesClient().send(new DeleteObjectCommand({Bucket:process.env.SPACES_BUCKET,Key:saved.key}));
  } else {
    const target=path.resolve(localDir,saved.key);
    if(!target.startsWith(localDir+path.sep)) throw new Error('Ruta de evidencia inválida.');
    await fs.unlink(target);
  }
}

export async function sendEvidence(res, expense) {
  res.setHeader("Content-Type", expense.file_mime || "application/octet-stream");
  res.setHeader("Content-Disposition", contentDisposition("inline", expense.file_name, "comprobante"));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");

  if (expense.file_storage === "spaces") {
    if (!spacesConfigured()) throw new Error("El almacenamiento Spaces no está configurado en este servidor.");
    const object = await spacesClient().send(new GetObjectCommand({
      Bucket: process.env.SPACES_BUCKET,
      Key: expense.file_key,
    }));
    object.Body.on("error", (error) => {
      console.error("[archivos] Error leyendo " + expense.file_key + ":", error.message);
      res.destroy(error);
    });
    object.Body.pipe(res);
    return;
  }

  const target = path.resolve(localDir, String(expense.file_key || ""));
  if (!target.startsWith(localDir + path.sep)) throw new Error("Ruta de evidencia inválida.");
  res.send(await fs.readFile(target));
}
