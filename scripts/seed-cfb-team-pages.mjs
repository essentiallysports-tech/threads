// One-off seed script (2026-10-04, operator request): registers three new
// college football Threads pages, already connected as Postiz integrations
// (confirmed via Postiz integrationList), in the page registry so the posting
// pipeline and the threads-dashboard both pick them up:
//   p98  Crimson Tide Takeover  (@crimson_tide_takeover)  Alabama
//   p99  Fighting Irish Fan Club (@fightingirish_fanclub) Notre Dame
//   p100 Hotty Toddy Hooligans  (@hottytoddy_hooligans)  Ole Miss
// Each persona comes from the account's own Threads bio (all three had no
// posts yet). Entities are the team plus people ES covers under their own
// tags, verified against ES headlines from the last 45 days (DeBoer 1,638
// tagged articles, Saban 1,483, Freeman 713, Russell 149, Chambliss 149,
// Carr 135, Golding 133). Ambiguous bare surnames ("freeman", "russell",
// "carr") are left out on purpose.
//
// Guard against the 2026-09-22 duplicate incident (see crossPageLedger.ts):
// every new page is exclusive_articles, so it only takes articles no other
// page has posted in the last 24h — e.g. Ole Miss can't repeat the LSU page's
// Lane Kiffin stories, and Alabama can't repeat College Football Forum's.
//
// Fail-closed like seed-new-threads-pages.mjs: aborts (writes nothing) if any
// page_id is already in index.json or has a pages/{id}.json; writes each page
// with IfNoneMatch:"*"; appends to index.json last. DRY_RUN=1 prints only.
//
// Run on the worker box: node --env-file=.env.local scripts/seed-cfb-team-pages.mjs
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const BUCKET = process.env.S3_BUCKET || "essentiallysports-images-v2prod";
const REGISTRY_PREFIX = "config/page-registry/";
const DRY_RUN = process.env.DRY_RUN === "1";

async function getObject(key) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return await res.Body.transformToString();
  } catch (e) {
    if (e.name === "NoSuchKey") return null;
    throw e;
  }
}

function threads(handle, integrationId, utmMedium) {
  return {
    account_handle: handle,
    postiz_integration_id: integrationId,
    char_limit: 500,
    hashtag_logic: "write_then_delete",
    topic_registration: true,
    caption_voice_mode: "regional_fan",
    emoji_count_min: 1,
    emoji_count_max: 3,
    beehiiv_link_exempt: true,
    daily_budget_min: 8,
    daily_budget_max: 8,
    posting_window_start: "09:00",
    posting_window_end: "23:30",
    utm_string: `utm_source=threads&utm_medium=${utmMedium}&utm_campaign=threads`,
    exclusive_articles: true,
  };
}

const base = { page_type: "regional", platform: "threads", status: "active", sport_groups: ["College Football"], national_threshold: 55, rival_entities: [] };

const NEW_PAGES = [
  {
    ...base,
    page_id: "p98",
    page_name: "Crimson Tide Takeover",
    page_theme: "Alabama football fan page — the latest Crimson Tide news and updates plus throwback stuff straight from Tuscaloosa: Kalen DeBoer's program, the roster, and the Nick Saban dynasty years.",
    entities: [
      { name: "Alabama Crimson Tide", keywords: ["alabama crimson tide", "crimson tide", "alabama"], weight: 40, is_team_identity: true, whole_word: true },
      { name: "Kalen DeBoer", keywords: ["kalen deboer", "deboer"], weight: 25 },
      { name: "Nick Saban", keywords: ["nick saban", "saban"], weight: 20 },
      { name: "Keelon Russell", keywords: ["keelon russell"], weight: 15 },
    ],
    threads: threads("crimson_tide_takeover", "cmuta2wo508ohqy0ygto4p86v", "cfb_fan_page_alabama"),
  },
  {
    ...base,
    page_id: "p99",
    page_name: "Fighting Irish Fan Club",
    page_theme: "Notre Dame football fan club — news and updates on the Fighting Irish under Marcus Freeman, the roster led by QB CJ Carr, and the program's history.",
    entities: [
      { name: "Notre Dame Fighting Irish", keywords: ["notre dame", "fighting irish"], weight: 40, is_team_identity: true, whole_word: true },
      { name: "Marcus Freeman", keywords: ["marcus freeman"], weight: 30 },
      { name: "CJ Carr", keywords: ["cj carr", "c.j. carr"], weight: 30 },
    ],
    threads: threads("fightingirish_fanclub", "cmuta0epo02lzlh0yorhrxrx4", "cfb_fan_page_notredame"),
  },
  {
    ...base,
    page_id: "p100",
    page_name: "Hotty Toddy Hooligans",
    page_theme: "Ole Miss football fan page — the latest from Oxford: Pete Golding's Rebels and QB Trinidad Chambliss. Fans love Chambliss and have no love for Lane Kiffin since he left for LSU.",
    entities: [
      { name: "Ole Miss Rebels", keywords: ["ole miss rebels", "ole miss", "hotty toddy"], weight: 40, is_team_identity: true, whole_word: true },
      { name: "Trinidad Chambliss", keywords: ["trinidad chambliss", "chambliss"], weight: 30 },
      { name: "Pete Golding", keywords: ["pete golding", "golding"], weight: 30 },
    ],
    threads: threads("hottytoddy_hooligans", "cmuta5zfz08q6qy0y250s337d", "cfb_fan_page_olemiss"),
  },
];

async function main() {
  const indexRaw = await getObject(`${REGISTRY_PREFIX}index.json`);
  if (!indexRaw) throw new Error("index.json missing or unreadable — aborting, writing nothing.");
  const index = JSON.parse(indexRaw);
  if (!Array.isArray(index.pages)) throw new Error("index.json has no pages[] array — aborting, writing nothing.");
  const existingIds = new Set(index.pages.map((p) => p.page_id));
  for (const page of NEW_PAGES) {
    if (existingIds.has(page.page_id)) throw new Error(`${page.page_id} already in index.json — aborting, writing nothing.`);
    if (await getObject(`${REGISTRY_PREFIX}pages/${page.page_id}.json`)) throw new Error(`pages/${page.page_id}.json already exists — aborting, writing nothing.`);
  }
  if (DRY_RUN) {
    for (const p of NEW_PAGES) console.log(`DRY RUN ${p.page_id} ${p.page_name} @${p.threads.account_handle} entities=${p.entities.map((e) => e.name).join(", ")} utm=${p.threads.utm_string}`);
    console.log(`DRY RUN index.json would go from ${index.pages.length} to ${index.pages.length + NEW_PAGES.length} pages`);
    return;
  }
  const now = new Date().toISOString();
  for (const page of NEW_PAGES) {
    const key = `${REGISTRY_PREFIX}pages/${page.page_id}.json`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify({ ...page, created_at: now, updated_at: now }, null, 2), ContentType: "application/json", IfNoneMatch: "*" }));
    console.log(`WROTE ${key}`);
  }
  // Index last — see seed-new-threads-pages.mjs for why.
  const updatedIndex = {
    ...index,
    pages: [...index.pages, ...NEW_PAGES.map((p) => ({ page_id: p.page_id, page_name: p.page_name, platform: p.platform, status: p.status }))],
    last_updated: now,
  };
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${REGISTRY_PREFIX}index.json`, Body: JSON.stringify(updatedIndex, null, 2), ContentType: "application/json" }));
  console.log(`WROTE ${REGISTRY_PREFIX}index.json (${index.pages.length} -> ${updatedIndex.pages.length} pages)`);
}

main().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
