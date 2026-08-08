import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { PageConfig, PageIndex, PostedLogEntry } from "./types";

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.S3_BUCKET || "essentiallysports-images-v2prod";
const REGISTRY_PREFIX = "config/page-registry/";

async function getObject(key: string): Promise<string | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return await res.Body!.transformToString();
  } catch (e: unknown) {
    if ((e as { name?: string }).name === "NoSuchKey") return null;
    throw e;
  }
}

async function putObject(key: string, body: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: "application/json" }));
}

// The SAME registry es-page-registry manages — this service reads it, never
// writes to it. Adding/pausing a page in that app's UI takes effect here on
// the next workflow run automatically, with zero deploy needed on this side.
export async function loadActiveThreadsPages(): Promise<PageConfig[]> {
  const indexRaw = await getObject(`${REGISTRY_PREFIX}index.json`);
  if (!indexRaw) return [];
  const index: PageIndex = JSON.parse(indexRaw);

  const pages = await Promise.all(
    index.pages
      .filter((p) => p.platform === "threads" && p.status === "active")
      .map(async ({ page_id }) => {
        const raw = await getObject(`${REGISTRY_PREFIX}pages/${page_id}.json`);
        return raw ? (JSON.parse(raw) as PageConfig) : null;
      })
  );

  // A page is only actually live if it also has a real Postiz integration —
  // mirrors the same guard the old skill file (and the FB pipeline before it)
  // had to add after finding ghost/disconnected registry entries.
  return pages.filter((p): p is PageConfig => !!p && !!p.threads?.postiz_integration_id);
}

// Defensive parse — confirmed live (2026-08-05): at least one real
// threads_posted_{page_id}.json on S3 is NOT a bare array, the same class of
// schema drift the old FB/Threads skill files already had to write explicit
// workarounds for on the approval-queue file (wrapped as {entries:[...]} or
// {queue:[...]} on different occasions, never consistently a plain array).
// Tolerate the same set of shapes here rather than assuming one.
function extractPostedLogEntries(parsed: unknown): PostedLogEntry[] {
  if (Array.isArray(parsed)) return parsed;
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  if (Array.isArray(obj?.entries)) return obj!.entries as PostedLogEntry[];
  if (Array.isArray(obj?.queue)) return obj!.queue as PostedLogEntry[];
  return [];
}

export async function getPostedLog(pageId: string): Promise<PostedLogEntry[]> {
  const raw = await getObject(`pool/threads_posted_${pageId}.json`);
  if (!raw) return [];
  try {
    return extractPostedLogEntries(JSON.parse(raw));
  } catch {
    return []; // malformed JSON — treat as empty rather than crash the whole run
  }
}

// Read-append-write. Real concurrency protection (ETag/IfMatch) is worth
// adding once this runs for real, but Temporal's own workflow-level
// serialization (one workflow execution per page per run, never overlapping
// for the same page — see dailyRunWorkflow) already prevents the double-post
// race this file exists to close, the same race the old skill file's
// idempotency rule was written for.
export async function appendPostedLog(pageId: string, entry: PostedLogEntry): Promise<void> {
  const log = await getPostedLog(pageId);
  log.push(entry);
  await putObject(`pool/threads_posted_${pageId}.json`, JSON.stringify(log, null, 2));
}

export async function getSharedPool(dateISO: string): Promise<Array<Record<string, unknown>>> {
  const raw = await getObject(`pool/t2_stories_${dateISO}_latest.json`);
  return raw ? JSON.parse(raw) : [];
}

export async function writeDryRunResult(dateISO: string, results: unknown): Promise<void> {
  await putObject(`pool/temporal_dry_run_${dateISO}.json`, JSON.stringify(results, null, 2));
}

export interface EvergreenAngle {
  angle_id: string;
  angle_type: number;
  bucket: string;
  subject: string;
  subject_class: string;
  frame: string;
  verify_at_runtime: string;
  default_photo_subject: string;
}

// Shared with the Facebook pipeline, keyed by FACEBOOK page_id (p02-p31) —
// confirmed live (2026-08-07) that this key space has ZERO overlap with
// Threads page_ids (p35-p61), exactly the gap the reference skill file
// flagged as "likely genuinely empty for Threads pages." Flattened here
// across every FB page's entries rather than looked up by page_id, since a
// real angle about a real entity/subject is equally usable for any Threads
// page covering that same entity — the FB-side page grouping is irrelevant
// to whether the angle itself is on-topic for a given Threads page.
export async function getAllEvergreenAngles(): Promise<EvergreenAngle[]> {
  const raw = await getObject("config/evergreen_bank.json");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Record<string, EvergreenAngle[]>;
    return Object.values(parsed).flat();
  } catch {
    return [];
  }
}

