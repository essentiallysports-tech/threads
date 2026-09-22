// One-off seed script: registers 7 new Threads pages (already connected as
// real Postiz integrations, confirmed live via Postiz's own integrationList/
// postsListTool) into the page registry, so both this pipeline's automated
// posting (loadActiveThreadsPages, s3registry.ts) and the read-only
// threads-dashboard start covering them. Same credential/bucket convention
// as the rest of this repo (see s3registry.ts) — reads AWS_ACCESS_KEY_ID/
// AWS_SECRET_ACCESS_KEY/AWS_REGION/S3_BUCKET from .env.local, never hardcoded.
//
// Run once, by hand, after review: `node --env-file=.env.local scripts/seed-new-threads-pages.mjs`
// (or `node scripts/seed-new-threads-pages.mjs` if those vars are already exported).
//
// Why these particular page_ids/personas: p91-p97 were individually confirmed
// free (no existing pages/p9N.json for any of them) before this script was
// written — see the PR description for how. Personas for the 5 NASCAR pages
// and World of Alcaraz come from scanning each account's real recent posts via
// Postiz's postsListTool, not invented; Deuce Court Daily has zero post
// history (brand-new account) and is flagged as an assumption in its own
// page_theme text.
//
// Safety: this script is fail-closed and idempotent-safe —
// 1. Aborts entirely (writes nothing) if index.json is missing/malformed, or
//    if ANY of the 7 target page_ids already appear in it or already have a
//    pages/{id}.json file — never partially applies.
// 2. Writes each new page's own JSON file with IfNoneMatch:"*" (S3-level
//    guarantee it can never silently overwrite something that appeared
//    between the check and the write).
// 3. Only after every individual page file is confirmed written does it
//    read-modify-write index.json to append the 7 new {page_id, page_name,
//    platform, status} entries — appended, no existing entry touched,
//    removed, or reordered.

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.S3_BUCKET || "essentiallysports-images-v2prod";
const REGISTRY_PREFIX = "config/page-registry/";

async function getObject(key) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return await res.Body.transformToString();
  } catch (e) {
    if (e.name === "NoSuchKey") return null;
    throw e;
  }
}

function threadsBase(handle, integrationId, utmMedium) {
  return {
    account_handle: handle,
    postiz_integration_id: integrationId,
    char_limit: 500,
    hashtag_logic: "write_then_delete",
    topic_registration: true,
    caption_voice_mode: "fan",
    emoji_count_min: 1,
    emoji_count_max: 3,
    beehiiv_link_exempt: true,
    daily_budget_min: 8,
    daily_budget_max: 8,
    posting_window_start: "09:00",
    posting_window_end: "23:30",
    utm_string: `utm_source=threads&utm_medium=${utmMedium}&utm_campaign=threads`,
  };
}

const NEW_PAGES = [
  {
    page_id: "p91", page_name: "Checkers and Wreckers", page_type: "national",
    platform: "threads", status: "active",
    page_theme: "General NASCAR Cup Series news — race results, driver incidents/rivalries, team news across the whole garage, not one team or driver.",
    sport_groups: ["NASCAR"], entities: [], national_threshold: 55, rival_entities: [],
    threads: threadsBase("checkersandwreckers", "cmt5ou4mj0234qk0ypr84clvz", "checkersandwreckers"),
  },
  {
    page_id: "p92", page_name: "Daytona Racing Digest", page_type: "national",
    platform: "threads", status: "active",
    page_theme: "General NASCAR Cup Series news — race results, driver incidents/rivalries, team news across the whole garage, not one team or driver.",
    sport_groups: ["NASCAR"], entities: [], national_threshold: 55, rival_entities: [],
    threads: threadsBase("daytonaracingdigest", "cmp1bpu4i01n3qf0yvnxd6g4b", "daytonaracingdigest"),
  },
  {
    page_id: "p93", page_name: "Lucky Dog On Track", page_type: "national",
    platform: "threads", status: "active",
    page_theme: "General NASCAR Cup Series news — race results, driver incidents/rivalries, team news across the whole garage, not one team or driver.",
    sport_groups: ["NASCAR"], entities: [], national_threshold: 55, rival_entities: [],
    threads: threadsBase("luckydogontrack_", "cmtbhnfa803y1rw0yzfgh7iwq", "luckydogontrack"),
  },
  {
    page_id: "p94", page_name: "Classic NASCAR", page_type: "national",
    platform: "threads", status: "active",
    page_theme: "General NASCAR Cup Series news — race results, driver incidents/rivalries, team news across the whole garage, not one team or driver. Real post history also mixes in occasional genuine throwback/legacy content (Earnhardt, Gordon, Jimmy Spencer).",
    sport_groups: ["NASCAR"], entities: [], national_threshold: 55, rival_entities: [],
    threads: threadsBase("classicnascar_", "cmt8z24lb0jxzp20yuotsbw54", "classicnascar"),
  },
  {
    page_id: "p95", page_name: "NASCAR Crashes", page_type: "national",
    platform: "threads", status: "active",
    page_theme: "General NASCAR Cup Series news with a slight incident/wreck-content lean, but not crash-exclusive per real post history.",
    sport_groups: ["NASCAR"], entities: [], national_threshold: 55, rival_entities: [],
    threads: threadsBase("_nascarcrashes", "cmtadfog906e5qs0yizg0dfk6", "nascarcrashes"),
  },
  {
    page_id: "p96", page_name: "World of Alcaraz", page_type: "entity",
    platform: "threads", status: "active",
    page_theme: "Carlos Alcaraz and Jannik Sinner — the two dominant young ATP rivals, their season, rankings, and rivalry.",
    sport_groups: ["Tennis"],
    entities: [
      { name: "Carlos Alcaraz", keywords: ["carlos alcaraz", "alcaraz"], weight: 20 },
      { name: "Jannik Sinner", keywords: ["jannik sinner", "sinner"], weight: 20 },
    ],
    national_threshold: 60, rival_entities: ["Novak Djokovic", "Alexander Zverev"],
    threads: threadsBase("worldofalcaraz_sinner", "cmu4coez505r4mn0y9wy9cobr", "worldofalcaraz"),
  },
  {
    page_id: "p97", page_name: "Deuce Court Daily", page_type: "national",
    platform: "threads", status: "active",
    page_theme: "General tennis news across ATP and WTA — not player-specific (Alcaraz/Sinner coverage lives on the separate World of Alcaraz page). ASSUMPTION: this account had zero real post history at the time this page was registered, so this persona is not yet confirmed against real output — revisit once it has posted.",
    sport_groups: ["Tennis"], entities: [], national_threshold: 55, rival_entities: [],
    threads: threadsBase("deucecourtdaily", "cmu4bmvzk05e2mn0y1pmufwnn", "deucecourtdaily"),
  },
];

async function main() {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY not set — run with --env-file=.env.local or export them first.");
  }

  const indexRaw = await getObject(`${REGISTRY_PREFIX}index.json`);
  if (!indexRaw) throw new Error("index.json missing or unreadable — aborting, writing nothing.");
  const index = JSON.parse(indexRaw);
  if (!Array.isArray(index.pages)) throw new Error("index.json has no pages[] array — aborting, writing nothing.");

  const existingIds = new Set(index.pages.map((p) => p.page_id));
  for (const page of NEW_PAGES) {
    if (existingIds.has(page.page_id)) {
      throw new Error(`${page.page_id} already exists in index.json — aborting, writing nothing. Re-check page_id assignment.`);
    }
    const existingFile = await getObject(`${REGISTRY_PREFIX}pages/${page.page_id}.json`);
    if (existingFile) {
      throw new Error(`${REGISTRY_PREFIX}pages/${page.page_id}.json already exists on S3 — aborting, writing nothing. Re-check page_id assignment.`);
    }
  }

  const now = new Date().toISOString();
  for (const page of NEW_PAGES) {
    const key = `${REGISTRY_PREFIX}pages/${page.page_id}.json`;
    const body = JSON.stringify({ ...page, created_at: now, updated_at: now }, null, 2);
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: "application/json", IfNoneMatch: "*" }));
    console.log(`WROTE ${key}`);
  }

  // Index updated LAST and ONLY after every individual page file above is
  // confirmed written — a page file existing without an index entry is
  // harmless (simply not yet discovered); an index entry pointing at a
  // page file that doesn't exist would make loadActiveThreadsPages() throw
  // on that page for every future run until fixed.
  const updatedIndex = {
    ...index,
    pages: [
      ...index.pages,
      ...NEW_PAGES.map((p) => ({ page_id: p.page_id, page_name: p.page_name, platform: p.platform, status: p.status })),
    ],
    last_updated: now,
  };
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${REGISTRY_PREFIX}index.json`,
      Body: JSON.stringify(updatedIndex, null, 2),
      ContentType: "application/json",
    })
  );
  console.log(`WROTE ${REGISTRY_PREFIX}index.json (+${NEW_PAGES.length} entries)`);
}

main().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
