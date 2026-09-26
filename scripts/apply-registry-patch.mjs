// Applies a reviewed registry patch file (scripts/registry-patches/*.json) to
// config/page-registry/pages/{id}.json. Each page entry may:
//   addEntities:  [EntitySlot]                         appended (skipped if a slot with that name exists)
//   editEntities: [{ name, addKeywords?, whole_word? }] modifies an existing slot
//   renameEntity: [from, to]
//   set:          { page_type?, ... }                   top-level fields
//   setThreads:   { exclusive_articles?, utm_string? }  fields under `threads`
// Writes are IfMatch-guarded on the ETag read, and the pre-change JSON is saved
// under ./registry-backups/ before anything is written.
//
// Usage: node --env-file=.env.local scripts/apply-registry-patch.mjs <patch.json> [pageId...]
//        DRY_RUN=1 prints the resulting diff without writing.

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const BUCKET = process.env.S3_BUCKET || "essentiallysports-images-v2prod";
const PREFIX = "config/page-registry/pages/";
const DRY_RUN = process.env.DRY_RUN === "1";

const [patchPath, ...only] = process.argv.slice(2);
if (!patchPath) throw new Error("usage: apply-registry-patch.mjs <patch.json> [pageId...]");
const patch = JSON.parse(readFileSync(patchPath, "utf8"));
const ids = only.length > 0 ? only : Object.keys(patch.pages);
const stamp = new Date().toISOString().replace(/[:.]/g, "");
mkdirSync("registry-backups", { recursive: true });

function apply(page, p) {
  const notes = [];
  for (const slot of p.addEntities || []) {
    if (page.entities.some((e) => e.name.toLowerCase() === slot.name.toLowerCase())) notes.push(`slot "${slot.name}" already present`);
    else { page.entities.push(slot); notes.push(`+slot "${slot.name}" [${slot.keywords.join(", ")}]${slot.whole_word ? " whole_word" : ""}`); }
  }
  for (const edit of p.editEntities || []) {
    const e = page.entities.find((x) => x.name.toLowerCase() === edit.name.toLowerCase());
    if (!e) throw new Error(`${page.page_id}: no slot named "${edit.name}"`);
    for (const k of edit.addKeywords || []) {
      if (e.keywords.some((x) => x.toLowerCase() === k.toLowerCase())) notes.push(`"${e.name}" already has "${k}"`);
      else { e.keywords.push(k); notes.push(`"${e.name}" +keyword "${k}"`); }
    }
    if (edit.whole_word !== undefined && e.whole_word !== edit.whole_word) { e.whole_word = edit.whole_word; notes.push(`"${e.name}" whole_word=${edit.whole_word}`); }
  }
  if (p.renameEntity) {
    const [from, to] = p.renameEntity;
    const e = page.entities.find((x) => x.name === from);
    if (e) { e.name = to; notes.push(`rename "${from}" -> "${to}"`); } else notes.push(`no slot "${from}" to rename`);
  }
  for (const [k, v] of Object.entries(p.set || {})) { if (page[k] !== v) { notes.push(`${k}: ${JSON.stringify(page[k])} -> ${JSON.stringify(v)}`); page[k] = v; } }
  for (const [k, v] of Object.entries(p.setThreads || {})) {
    if (page.threads?.[k] !== v) { notes.push(`threads.${k}: ${JSON.stringify(page.threads?.[k])} -> ${JSON.stringify(v)}`); page.threads = { ...page.threads, [k]: v }; }
  }
  return notes;
}

for (const id of ids) {
  if (!patch.pages[id]) throw new Error(`${id} is not in ${patchPath}`);
  const key = `${PREFIX}${id}.json`;
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const etag = r.ETag;
  const body = await r.Body.transformToString();
  const page = JSON.parse(body);
  const notes = apply(page, patch.pages[id]);
  console.log(`${id} ${page.page_name}: ${notes.join("; ") || "no change"}`);
  if (DRY_RUN || notes.every((n) => /already|no slot/.test(n))) continue;
  writeFileSync(`registry-backups/${id}.${stamp}.json`, body);
  page.updated_at = new Date().toISOString();
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify(page, null, 2), ContentType: "application/json", IfMatch: etag }));
  console.log(`${id}: written (backup registry-backups/${id}.${stamp}.json)`);
}
