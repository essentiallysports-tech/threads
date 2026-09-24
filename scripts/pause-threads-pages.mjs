// Incident rollback (2026-09-24): pauses the 7 pages registered by
// seed-new-threads-pages.mjs (p91-p97). The 5 NASCAR pages had near-identical
// configs and were posting the same article across 5 accounts within minutes
// (plus a same-page "angle" repost an hour later), which coincided with a
// fleet-wide Threads reach/click collapse. Status flip only — no page data
// is deleted; set status back to "active" (same script with STATUS=active)
// to undo.
//
// Usage: node --env-file=.env.local scripts/pause-threads-pages.mjs
//        STATUS=active node --env-file=.env.local scripts/pause-threads-pages.mjs   (undo)

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const BUCKET = process.env.S3_BUCKET || "essentiallysports-images-v2prod";
const PREFIX = "config/page-registry/";
const IDS = ["p91", "p92", "p93", "p94", "p95", "p96", "p97"];
const STATUS = process.env.STATUS || "paused";

async function get(key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return { body: await r.Body.transformToString(), etag: r.ETag };
}

const now = new Date().toISOString();

for (const id of IDS) {
  const key = `${PREFIX}pages/${id}.json`;
  const { body, etag } = await get(key);
  const page = JSON.parse(body);
  page.status = STATUS;
  page.updated_at = now;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify(page, null, 2), ContentType: "application/json", IfMatch: etag }));
  console.log(`${id} -> ${STATUS}`);
}

const { body, etag } = await get(`${PREFIX}index.json`);
const index = JSON.parse(body);
const before = index.pages.length;
let touched = 0;
for (const p of index.pages) {
  if (IDS.includes(p.page_id)) {
    p.status = STATUS;
    touched++;
  }
}
if (touched !== IDS.length || index.pages.length !== before) {
  throw new Error(`index sanity check failed (touched=${touched}, expected ${IDS.length}) — index.json NOT written`);
}
index.last_updated = now;
await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}index.json`, Body: JSON.stringify(index, null, 2), ContentType: "application/json", IfMatch: etag }));
console.log(`index.json: ${touched} entries -> ${STATUS} (${before} total, unchanged count)`);
