// Temporal activities — the ONLY place real I/O happens. Workflow code
// (src/workflows/*) must stay deterministic/replayable, so every network
// call, S3 read/write, and non-deterministic operation (Date.now(), random)
// is wrapped here and invoked from the workflow via proxyActivities.

import { Context } from "@temporalio/activity";
import { PageConfig, Candidate, PostedLogEntry, PageRunResult } from "../lib/types";
import {
  loadActiveThreadsPages,
  getPostedLog,
  appendPostedLog,
  writeDryRunResult,
  writeInfographicJob,
  getInfographicResult,
} from "../lib/s3registry";
import { sourceFromNewsletter, sourceFromSharedPool, shouldSourceFromNewsletter } from "../lib/sourcing";
import { runDeterministicChecks, linkResolves, hasUtm, matchedEntityNames } from "../lib/checks";
import { buildCaption, buildReplyLink } from "../lib/caption";
import { scheduleThreadsPost } from "../lib/postiz";

export async function loadPages(): Promise<PageConfig[]> {
  return loadActiveThreadsPages();
}

export async function loadPostedLog(pageId: string): Promise<PostedLogEntry[]> {
  return getPostedLog(pageId);
}

// Picks ONE candidate for this page per the 70/30 newsletter/shared-pool mix,
// falling back to shared pool if the newsletter edition is missing/stale.
export async function sourceOneCandidate(page: PageConfig, dateISO: string, postedLog: PostedLogEntry[]): Promise<Candidate | null> {
  // Confirmed live: real posted-log entries can be missing `posted_at`
  // entirely — defend the same way dailyRunWorkflow.ts does.
  const todaysEntries = postedLog.filter((p) => (p.posted_at || "").startsWith(dateISO));
  const newsletterCount = todaysEntries.filter((p) => p.reply_url?.includes("utm_content=reply_link")).length; // best-effort tag
  const preferNewsletter = shouldSourceFromNewsletter(newsletterCount, todaysEntries.length);

  if (preferNewsletter) {
    const fromNewsletter = await sourceFromNewsletter(page);
    if (fromNewsletter) return fromNewsletter;
  }

  const pool = await sourceFromSharedPool(page, dateISO);
  if (pool.length > 0) return pool[0];

  // Newsletter was the preferred tier and had nothing usable — still try it
  // as a fallback before giving up entirely.
  if (!preferNewsletter) {
    const fromNewsletter = await sourceFromNewsletter(page);
    if (fromNewsletter) return fromNewsletter;
  }

  return null;
}

export interface CheckedCandidate {
  candidate: Candidate;
  pass: boolean;
  reason: string | null;
}

// Runs every deterministic check EXCEPT the cross-run mass-duplicate one
// (that needs a Set shared across the whole run, which can't cross the
// activity/workflow boundary — see workflows/dailyRunWorkflow.ts).
export async function checkCandidate(candidate: Candidate, page: PageConfig, postedLog: PostedLogEntry[]): Promise<CheckedCandidate> {
  const result = runDeterministicChecks(candidate, page, postedLog, new Set());
  return { candidate, ...result };
}

export interface LinkVerification {
  finalLink: string | null; // null means UTM_MISSING — caller must drop the candidate, never post a bare link
  resolves: boolean;
  hasUtmTag: boolean;
}

export async function verifyAndTagLink(candidate: Candidate, page: PageConfig): Promise<LinkVerification> {
  const link = buildReplyLink(candidate, page); // null if this page has no registered utm_string — a real, expected outcome, not an error
  if (!link) return { finalLink: null, resolves: false, hasUtmTag: false };
  const resolves = await linkResolves(candidate.link); // verify the underlying article/edition, not the UTM'd copy
  return { finalLink: link, resolves, hasUtmTag: hasUtm(link) };
}

export async function buildCaptionText(candidate: Candidate, page: PageConfig): Promise<string> {
  return buildCaption(candidate, page);
}

// Render now happens in a SEPARATE Claude Routine (ES-Infographic-Creation-
// Skill-v1.md on S3), because both OpenArt and ES-MCP (needed to fetch real
// athlete photos to use as the image2image reference) are MCP-only tools —
// unreachable from this standalone Node worker, exactly like OpenArt was
// before this redesign. This worker's job is now just the handoff: write
// the job, wait for the Routine (woken by its own trigger) to write the
// result back to S3.
//
// `athleteNames` is computed deterministically by the WORKFLOW (via
// checks.matchedEntityNames) before this is called — which athlete/team
// photos to search ES-MCP for is a decided fact by the time this activity
// runs, not something the Routine has to infer from the headline itself.
//
// Heartbeats during the poll so Temporal doesn't consider this activity
// stuck during the (potentially multi-minute) wait for a separate system —
// startToCloseTimeout for this specific activity is set generously in
// dailyRunWorkflow.ts's proxyActivities to match.
export async function requestInfographicRender(
  candidate: Candidate,
  page: PageConfig,
  athleteNames: string[]
): Promise<string | null> {
  await writeInfographicJob({
    page_id: page.page_id,
    candidate_key: candidate.key,
    headline: candidate.headline,
    page_theme: page.page_theme,
    athlete_names: athleteNames,
    // `candidate.subject` is the Beehiiv newsletter's per-audience fan-page
    // persona name (e.g. "Conor McGregor UFC Fanpage") — NOT a fact about
    // the story. Confirmed live (2026-08-06): passing something like this
    // as accent text got a real public figure's name into an image prompt
    // for a story that wasn't actually about them, and the render refused
    // entirely. Never source accent from the audience-persona field.
    accent: candidate.rawText && candidate.rawText !== candidate.headline ? candidate.rawText : undefined,
  });

  const pollIntervalMs = 15_000;
  const maxWaitMs = 8 * 60_000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    Context.current().heartbeat();
    const result = await getInfographicResult(candidate.key);
    if (result?.status === "completed") return result.card_url ?? null;
    if (result?.status === "failed") {
      Context.current().log.warn("INFOGRAPHIC_ROUTINE_FAILED", { candidate_key: candidate.key, error: result.error });
      return null;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  Context.current().log.warn("INFOGRAPHIC_ROUTINE_TIMEOUT", { candidate_key: candidate.key, maxWaitMs });
  return null;
}

export async function postToThreads(
  page: PageConfig,
  mainPostHtml: string,
  cardUrl: string | null,
  replyLinkHtml: string,
  postTimeUtc: string
): Promise<{ id: string }> {
  if (process.env.LIVE_POSTING !== "true") {
    throw new Error("postToThreads called while LIVE_POSTING is not 'true' — this should never happen, the workflow must gate this itself");
  }
  return scheduleThreadsPost(page.threads!.postiz_integration_id, mainPostHtml, cardUrl, replyLinkHtml, new Date(postTimeUtc));
}

export async function recordPosted(pageId: string, entry: PostedLogEntry): Promise<void> {
  await appendPostedLog(pageId, entry);
}

export async function saveDryRunResults(dateISO: string, results: PageRunResult[]): Promise<void> {
  await writeDryRunResult(dateISO, results);
}
