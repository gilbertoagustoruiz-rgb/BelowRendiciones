import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

const localDir = path.resolve("uploads");

function spacesConfigured() {
  return Boolean(
    process.env.SPACES_ENDPOINT &&
    process.env.SPACES_BUCKET &&
    process.env.SPACES_KEY &&
    process.env.SPACES_SECRET
  );
}

function spacesClient() {
  return new S3Client({
    endpoint: process.env.SPACES_ENDPOINT,
    region: process.env.SPACES_REGION || "us-east-1",
    forcePathStyle: false,
    credentials: {
      accessKeyId: process.env.SPACES_KEY,
      secretAccessKey: process.env.SPACES_SECRET,
    },
  });
}

function extensionFor(file) {
  const original = path.extname(file.originalname || "").toLowerCase();
  if (original && original.length <= 8) return original;
  if (file.mimetype === "application/pdf") return ".pdf";
  if (file.mimetype === "image/png") return ".png";
  if (file.mimetype === "image/webp") return ".webp";
  return ".jpg";
}

export async function saveEvidence(file) {
  const key = "rendiciones/" +
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

export async function sendEvidence(res, expense) {
  res.setHeader("Content-Type", expense.file_mime || "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    'inline; filename="' + String(expense.file_name || "comprobante").replace(/"/g, "") + '"'
  );

  if (expense.file_storage === "spaces" && spacesConfigured()) {
    const client = spacesClient();
    const object = await client.send(new GetObjectCommand({
      Bucket: process.env.SPACES_BUCKET,
      Key: expense.file_key,
    }));
    if (object.ContentType) res.setHeader("Content-Type", object.ContentType);
    object.Body.pipe(res);
    return;
  }

  const target = path.join(localDir, expense.file_key);
  const buffer = await fs.readFile(target);
  res.send(buffer);
}
