import { proxyActivities, proxyLocalActivities, log, workflowInfo } from "@temporalio/workflow";
import type * as activities from "../activities/firehoseActivities";
import { PostedLogEntry } from "../lib/types";

// Same replay-safety split dailyRunWorkflow.ts established after a real
// 22-hour outage (see that file's own header comment): a plain in-workflow
// call to a checks.ts-backed function let an in-flight execution's replay
// diverge from history the moment checks.ts was next deployed, and
// ScheduleOverlapPolicy.SKIP silently ate every hourly fire behind the
// wedged execution. proxyLocalActivities for the pure functions (filterPostable,
// buildFirehosePostText) records their result as a lightweight Marker, so a
// future deploy of checks.ts/caption.ts can never diverge an in-flight run's
// replay again — proxyActivities only for real I/O.
const { filterPostable, buildFirehosePostText } = proxyLocalActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 3 },
});

const { loadFirehosePage, loadFirehosePostedLog, recordFirehosePosted } = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

// ES-MCP call, own longer budget — mirrors dailyRunWorkflow.ts's own
// dedicated sourceCandidatePool proxy for the same "a slow sourcing call
// using more of the hour's slack is fine" reasoning.
const { sourceFirehoseArticles } = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 2 },
});

// ⛔ OPERATOR FIX (2026-08-27, same live incident as DEFAULT_MAX_POSTS_PER_RUN
// below): maximumAttempts dropped from 3 to 1. p80's own posting failures
// that night were real Postiz 429 ThrottlerExceptions (rate limit, not a
// transient blip) — retrying 2 more times into an ALREADY-saturated shared
// resource doesn't help this attempt succeed and just adds more requests on
// top of the exact pressure that caused the 429 in the first place. A
// dropped post isn't lost: it's simply still new next hour and gets picked
// up automatically by the permanent key-based dedup in filterPostable.
const { postFirehoseToThreads } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});

export interface FirehoseRunOptions {
  dateISO?: string;
  livePosting: boolean;
  pageId: string;
  // ⛔ OPERATOR FIX (2026-08-27, real live incident): "uncapped" as originally
  // specified turned out not viable — confirmed live, p80 posted 124 times
  // in 8h while the other 41 pages combined got only 44, and BOTH
  // es-threads-worker (135 occurrences) and es-threads-firehose-worker (420
  // occurrences) logged real Postiz 429 ThrottlerExceptions. All Threads
  // pages share ONE Postiz account/API key, so p80's own volume was directly
  // consuming the rate limit budget the main pipeline's posting depends on —
  // established, high-content pages (MMA Archives, Conor McGregor UFC
  // Fanpage) were landing at zero not from lack of content but from POSTING
  // itself failing. Operator directive: cap per hour rather than pace-only,
  // to leave real headroom for the other 41 pages. Optional override still
  // exists for the controlled-test path (clientFirehose.ts's --max-posts);
  // undefined now falls through to DEFAULT_MAX_POSTS_PER_RUN below, not
  // unlimited. Nothing is lost by the cap — sourceFirehoseArticles's
  // permanent key-based dedup means whatever's cut off this hour is simply
  // still new next hour, picked up automatically.
  maxPostsThisRun?: number;
}

export interface FirehoseItemResult {
  key: string;
  outcome: "posted" | "dropped" | "dry_run_would_post" | "skipped";
  reason?: string;
  post_id?: string;
  headline?: string;
  link?: string;
}

// Deliberately much thinner than dailyRunWorkflow.ts: one page, no repair
// passes, no PAGE_CONCURRENCY, no MIN_POSTS_PER_RUN floor — source once,
// filter, post everything that passes up to the per-hour cap below.
const LEAD_TIME_MS = 5 * 60 * 1000;
const STAGGER_MS = 3 * 60 * 1000;
// ⛔ OPERATOR FIX (2026-08-27, real live directive, now evidence-based):
// went 12 -> 5 -> 10 across this same incident. 12 caused the real 429
// flood; 5 was a conservative guess made without knowing the actual limit.
// Confirmed via Postiz's own public docs (docs.postiz.com/public-api): the
// create-post endpoint is capped at 100 requests/hour, ACCOUNT-WIDE (shared
// across every integration under one API key — confirmed by the incident
// itself, since p80's calls to its OWN integration caused 429s on calls to
// OTHER pages' different integrations). Checked the main pipeline's own
// real historical peak (posted-log timestamps, all-time, excluding p80):
// max ever in one hour is 22, 95th percentile 15, average 5.4. 10/hour for
// p80 leaves 90/hour of headroom — over 4x the main pipeline's observed
// all-time peak, real margin even accounting for retries and the fairness
// fix pushing its peak somewhat higher going forward. Operator directive
// still holds: p80 is bonus volume, explicitly subordinate to the main
// pipeline's 5/day/page floor whenever they compete for this same shared
// budget — this number is a data-driven safety margin, not a target to
// maximize.
const DEFAULT_MAX_POSTS_PER_RUN = 10;

export async function firehoseWorkflow(opts: FirehoseRunOptions): Promise<FirehoseItemResult[]> {
  const dateISO = opts.dateISO || new Date(workflowInfo().startTime).toISOString().slice(0, 10);
  const page = await loadFirehosePage(opts.pageId);
  const postedLog = await loadFirehosePostedLog(opts.pageId);
  const pool = await sourceFirehoseArticles(page, dateISO);
  const checked = await filterPostable(pool, postedLog);

  const postable = checked.filter((c) => c.reason === null).map((c) => c.candidate);
  const effectiveCap = opts.maxPostsThisRun ?? DEFAULT_MAX_POSTS_PER_RUN;
  const toProcess = postable.slice(0, effectiveCap);

  log.info("FIREHOSE_RUN_START", { pageId: opts.pageId, sourced: pool.length, postable: postable.length, toProcess: toProcess.length });

  const results: FirehoseItemResult[] = [];
  let index = 0;
  for (const candidate of toProcess) {
    try {
      const postText = await buildFirehosePostText(candidate, page);
      if (!opts.livePosting) {
        results.push({ key: candidate.key, outcome: "dry_run_would_post", headline: candidate.headline, link: candidate.link });
        continue;
      }
      const postTime = new Date(Date.now() + LEAD_TIME_MS + index * STAGGER_MS);
      index++;
      const posted = await postFirehoseToThreads(page, postText, postTime.toISOString());
      const entry: PostedLogEntry = {
        key: candidate.key,
        post_id: posted.id,
        posted_at: new Date().toISOString(),
        reply_url: candidate.link,
        headline: candidate.headline,
        source: candidate.source,
        source_published_at: candidate.publishedAt,
      };
      await recordFirehosePosted(opts.pageId, entry);
      results.push({ key: candidate.key, outcome: "posted", post_id: posted.id });
    } catch (e) {
      // One item's failure must never cost the rest of the run — same
      // discipline as dailyRunWorkflow.ts's own Phase 2 posting loop.
      log.warn("FIREHOSE_POST_FAILED", { key: candidate.key, error: (e as Error).message });
      results.push({ key: candidate.key, outcome: "dropped", reason: (e as Error).message?.slice(0, 200) });
    }
  }

  log.info("FIREHOSE_RUN_COMPLETE", { pageId: opts.pageId, posted: results.filter((r) => r.outcome === "posted").length, dropped: results.filter((r) => r.outcome === "dropped").length });
  return results;
}
