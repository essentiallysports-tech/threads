// Reactivates p91-p97 with threads.exclusive_articles=true (see
// src/lib/crossPageLedger.ts). Run only AFTER the code that honors the flag
// is deployed — older code ignores it, and these pages would collide again.
//
// Usage: node --env-file=.env.local scripts/reactivate-exclusive-pages.mjs

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const BUCKET = process.env.S3_BUCKET || "essentiallysports-images-v2prod";
const PREFIX = "config/page-registry/";
const IDS = ["p91", "p92", "p93", "p94", "p95", "p96", "p97"];

async function get(key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return { body: await r.Body.transformToString(), etag: r.ETag };
}

const now = new Date().toISOString();

for (const id of IDS) {
  const key = `${PREFIX}pages/${id}.json`;
  const { body, etag } = await get(key);
  const page = JSON.parse(body);
  page.status = "active";
  page.threads = { ...page.threads, exclusive_articles: true };
  page.updated_at = now;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify(page, null, 2), ContentType: "application/json", IfMatch: etag }));
  console.log(`${id} -> active, exclusive_articles=true`);
}

const { body, etag } = await get(`${PREFIX}index.json`);
const index = JSON.parse(body);
const before = index.pages.length;
let touched = 0;
for (const p of index.pages) {
  if (IDS.includes(p.page_id)) {
    p.status = "active";
    touched++;
  }
}
if (touched !== IDS.length || index.pages.length !== before) {
  throw new Error(`index sanity check failed (touched=${touched}, expected ${IDS.length}) — index.json NOT written`);
}
index.last_updated = now;
await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}index.json`, Body: JSON.stringify(index, null, 2), ContentType: "application/json", IfMatch: etag }));
console.log(`index.json: ${touched} entries -> active (${before} total, unchanged count)`);
