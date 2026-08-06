import { proxyActivities, log, workflowInfo } from "@temporalio/workflow";
import type * as activities from "../activities";
import { PageRunResult } from "../lib/types";
import { matchedEntityNames } from "../lib/checks";

const {
  loadPages,
  loadPostedLog,
  sourceOneCandidate,
  checkCandidate,
  verifyAndTagLink,
  buildCaptionText,
  postToThreads,
  recordPosted,
  saveDryRunResults,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

// Separate, much longer timeout: this activity hands the render job off to
// a different system entirely (the ES Infographic Creation Routine, via S3
// — see requestInfographicRender in activities/index.ts) and polls for its
// result. heartbeatTimeout lets Temporal detect a genuinely stuck/dead
// worker process faster than waiting out the full 10-minute ceiling.
const { requestInfographicRender } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "30 seconds",
  retry: { maximumAttempts: 2 },
});

export interface DailyRunOptions {
  // Left undefined/empty for a scheduled run — a fixed value baked in at
  // schedule-creation time would be wrong for every fire after the first
  // (confirmed bug, caught before this ever ran for real). The workflow
  // computes "today" itself below, from its own start time, which IS safe/
  // deterministic in Temporal — replays always see the same recorded
  // startTime. Only pass a real dateISO for a one-off manual/backfill run.
  dateISO?: string;
  livePosting: boolean;
  dailyBudgetMax: number;
}

// This function is the deterministic replacement for the old prose skill
// file's entire T_THREADS logic. Every decision point here is real,
// replayable code — nothing here is "the model is supposed to remember to
// check this." One workflow EXECUTION handles the whole run across every
// active page; Temporal's own event-history replay is what makes this safe
// to retry/resume without double-posting, the exact problem the old system's
// idempotency rules kept failing to enforce in prose.
export async function dailyRunWorkflow(opts: DailyRunOptions): Promise<PageRunResult[]> {
  // workflowInfo().startTime is Temporal's own recorded start timestamp for
  // THIS execution — safe to use in workflow code (unlike `Date.now()`/
  // `new Date()`, which are non-deterministic and would break replay).
  const dateISO = opts.dateISO || new Date(workflowInfo().startTime).toISOString().slice(0, 10);

  const pages = await loadPages();
  const results: PageRunResult[] = [];

  // Cross-page, same-run duplicate detection (the deterministic circuit
  // breaker) — a plain Set works here because workflow code is single-
  // threaded and deterministic; this is exactly the kind of state Temporal
  // workflows are built to hold safely across activity calls.
  const seenHeadlinesThisRun = new Set<string>();

  for (const page of pages) {
    const postedLog = await loadPostedLog(page.page_id);
    // Defensive on `posted_at` — confirmed live (2026-08-05) that at least one
    // page's real S3 posted-log has entries missing this field entirely
    // (schema drift from whatever wrote it, same class of issue the old FB/
    // Threads skill files hit repeatedly with hand-written JSON). A workflow
    // TASK failure (as opposed to an activity failure) retries indefinitely
    // by default — this crashed silently in a retry loop until caught here.
    const postedToday = postedLog.filter((p) => (p.posted_at || "").startsWith(dateISO)).length;
    const cap = page.threads?.daily_budget_max ?? opts.dailyBudgetMax;

    if (postedToday >= cap) {
      results.push({ page_id: page.page_id, outcome: "skipped_capped", reason: `${postedToday}/${cap}` });
      continue;
    }

    const candidate = await sourceOneCandidate(page, dateISO, postedLog);
    if (!candidate) {
      results.push({ page_id: page.page_id, outcome: "no_candidate" });
      continue;
    }

    const normalizedHeadline = candidate.headline.toLowerCase().trim();
    if (seenHeadlinesThisRun.has(normalizedHeadline)) {
      log.warn("MASS_DUPLICATE_HEADLINE_CIRCUIT_BREAKER", { page_id: page.page_id, headline: candidate.headline });
      results.push({ page_id: page.page_id, outcome: "dropped", reason: "MASS_DUPLICATE_THIS_RUN", candidate });
      continue;
    }

    const checked = await checkCandidate(candidate, page, postedLog);
    if (!checked.pass) {
      results.push({ page_id: page.page_id, outcome: "dropped", reason: checked.reason ?? undefined, candidate });
      continue;
    }

    const linkCheck = await verifyAndTagLink(candidate, page);
    if (!linkCheck.finalLink || !linkCheck.resolves || !linkCheck.hasUtmTag) {
      results.push({
        page_id: page.page_id,
        outcome: "dropped",
        reason: !linkCheck.finalLink ? "UTM_MISSING" : !linkCheck.resolves ? "LINK_DEAD" : "UTM_TAG_MISSING",
        candidate,
      });
      continue;
    }

    const caption = await buildCaptionText(candidate, page);

    // Deterministic, not the Routine's judgment call (operator decision,
    // 2026-08-06) — which registered entity/entities actually matched this
    // candidate's text is exactly what entityOrSportMatch already computed
    // internally to pass STEP checked above; this just surfaces the names.
    const athleteNames = matchedEntityNames(candidate, page);

    let cardUrl: string | null = null;
    try {
      cardUrl = await requestInfographicRender(candidate, page, athleteNames);
    } catch (e) {
      log.warn("RENDER_FAILED_AFTER_RETRIES", { page_id: page.page_id, error: (e as Error).message });
    }

    seenHeadlinesThisRun.add(normalizedHeadline);

    if (!opts.livePosting) {
      results.push({ page_id: page.page_id, outcome: "dry_run_would_post", candidate, cardUrl });
      continue;
    }

    // Never actually post live without a card, mirrors the old skill file's
    // "image mandatory, zero exceptions" rule, now enforced as an actual
    // `if`, not a hoped-for compliance. Confirmed live (2026-08-06): render
    // can genuinely fail even after all retries — e.g. Gemini reliably
    // refuses prompts naming a specific real public figure for one MMA
    // candidate — so this path is real and expected to fire occasionally,
    // not dead code.
    if (!cardUrl) {
      results.push({ page_id: page.page_id, outcome: "dropped", reason: "NO_CARD_RENDER_FAILED", candidate });
      continue;
    }

    const postTime = new Date(Date.now() + 75 * 60 * 1000); // 75 min out, mirrors the 60-90 min posting delay rule
    const posted = await postToThreads(page, caption, cardUrl, linkCheck.finalLink, postTime.toISOString());

    await recordPosted(page.page_id, {
      key: candidate.key,
      post_id: posted.id,
      posted_at: new Date().toISOString(),
      reply_url: linkCheck.finalLink,
      headline: candidate.headline,
    });

    results.push({ page_id: page.page_id, outcome: "posted", candidate, post_id: posted.id });
  }

  await saveDryRunResults(dateISO, results);
  return results;
}
