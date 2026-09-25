// Adds a team-nickname entity slot to Dallas Cowboys Community (p41) and
// Detroit Lions Community (p40). ES headlines call them "Cowboys"/"Lions" (and
// name Jerry Jones), almost never the full "Dallas Cowboys"/"Detroit Lions"
// the player slots carry, so most real team articles were being rejected
// NO_NAMED_ENTITY. Same shape Eagles/Warriors/Lakers/Kings pages already use.
//
// p40's "lions" needs whole_word (else it matches "Billions"), which only the
// code from this PR honors — run p40 only AFTER that is deployed. p41's
// keywords have no substring collisions, so it is safe on either version.
//
// Usage: node --env-file=.env.local scripts/add-team-nickname-slots.mjs p41 [p40]
//        DRY_RUN=1 to print without writing.

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const BUCKET = process.env.S3_BUCKET || "essentiallysports-images-v2prod";
const PREFIX = "config/page-registry/pages/";
const DRY_RUN = process.env.DRY_RUN === "1";

const SLOTS = {
  p41: { name: "Dallas Cowboys", keywords: ["dallas cowboys", "cowboys", "jerry jones"], weight: 20, whole_word: true },
  p40: { name: "Detroit Lions", keywords: ["detroit lions", "lions"], weight: 20, whole_word: true },
};

const ids = process.argv.slice(2);
if (ids.length === 0 || ids.some((id) => !SLOTS[id])) {
  throw new Error(`usage: add-team-nickname-slots.mjs <${Object.keys(SLOTS).join("|")}>...`);
}

for (const id of ids) {
  const key = `${PREFIX}${id}.json`;
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const etag = r.ETag;
  const page = JSON.parse(await r.Body.transformToString());
  if (page.entities.some((e) => e.name.toLowerCase() === SLOTS[id].name.toLowerCase())) {
    console.log(`${id}: "${SLOTS[id].name}" slot already present — unchanged`);
    continue;
  }
  page.entities.push(SLOTS[id]);
  page.updated_at = new Date().toISOString();
  console.log(`${id} ${page.page_name}: entities -> ${page.entities.map((e) => e.name).join(", ")}`);
  if (DRY_RUN) continue;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify(page, null, 2), ContentType: "application/json", IfMatch: etag }));
  console.log(`${id}: written`);
}
