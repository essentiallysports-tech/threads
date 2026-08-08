import { proxyActivities, log, workflowInfo } from "@temporalio/workflow";
import type * as activities from "../activities";
import { PageRunResult, PageConfig, Candidate } from "../lib/types";
import { matchedEntityNames, matchedSportGroup } from "../lib/checks";

const {
  loadPages,
  loadPostedLog,
  sourceCandidatePool,
  checkCandidate,
  checkAccuracy,
  checkTopicFrequency,
  checkDominantNarrative,
  verifyAndTagLink,
  buildCaptionText,
  postToThreads,
  recordPosted,
  saveDryRunResults,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

// renderCard makes 3 real network calls (ES-MCP search, Cloudinary crop, AI
// render via OpenArt — Orshot was removed from this pipeline entirely, see
// activities/index.ts) within this worker — no separate MCP Routine or S3
// polling. A slightly longer timeout than the default 2 minutes covers a slow
// heartbeats.
const { renderCard } = proxyActivities<typeof activities>({
  startToCloseTimeout: "3 minutes",
  retry: { maximumAttempts: 3 },
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

  // ⛔ OPERATOR CORRECTION (2026-08-07): the old cross-page "mass duplicate
  // headline" circuit breaker treated multiple pages legitimately covering
  // the SAME real story (e.g. three different NASCAR pages all posting
  // about the same real Mark Martin story) as a failure to halt the entire
  // run over — that's wrong. Different pages/audiences reporting the same
  // real, topically-relevant news is normal editorial behavior, not a
  // duplicate-content bug; entityOrSportMatch already guarantees each page's
  // pick is actually relevant to IT, which is what the original 2026-08-02/
  // 08-03 incident (generic wrapper text posted regardless of subject) was
  // really missing. The guardrail this project actually needs is "the same
  // page doesn't post the same story/link twice" — which already exists
  // (alreadyPostedRecently, duplicateLinkRecently in checks.ts, per page,
  // untouched by this change) — not "no two pages may ever cover one topic."
  // Removed entirely rather than kept as a softened version: there's no
  // similarity threshold that distinguishes "two pages legitimately reusing
  // the real headline" from "an actual duplicate," because the caption text
  // itself is now genuinely story-specific (see caption.ts) not a generic
  // reused wrapper.

  // ⛔ OPERATOR OVERRIDE (2026-08-07): two-phase run, not schedule-as-you-go.
  // Every post's scheduled time must be at least an hour AFTER THE WHOLE
  // ROUTINE FINISHES — matching how the earlier Threads routines worked —
  // not "75 min from whenever THIS page happened to be processed" (that
  // computed each post_time individually, mid-run; a page processed early
  // in a run that takes a while could end up scheduled less than an hour
  // after the run actually completes). Phase 1 below sources/checks/renders
  // every page and collects what's ready to post WITHOUT calling Postiz yet;
  // Phase 2, after that loop ends, computes ONE shared post_time anchored to
  // completion and then schedules everything.
  interface ReadyToPost {
    page: PageConfig;
    candidate: Candidate;
    caption: string;
    cardUrl: string;
    finalLink: string;
    template: string | null;
    entity: string | null;
    sportGroup: string | null;
  }
  const readyToPost: ReadyToPost[] = [];

  // ⛔ OPERATOR TARGET (2026-08-08): "add a minimum of 150 posts a day in
  // the system" — explicitly not a hard gate (nothing here fabricates
  // content or loosens a check to hit this number), but a real, computed,
  // logged pace signal every run: with 24 hourly fires/day and up to
  // dailyBudgetMax(8) per page, 150/day is well within the structural
  // ceiling (up to 200 across 25 pages) as long as the sourcing tiers
  // actually find real, postable content most hours.
  const MIN_DAILY_POSTS_TARGET = 150;
  let postedTodaySoFar = 0;

  for (const page of pages) {
    const postedLog = await loadPostedLog(page.page_id);
    // Defensive on `posted_at` — confirmed live (2026-08-05) that at least one
    // page's real S3 posted-log has entries missing this field entirely
    // (schema drift from whatever wrote it, same class of issue the old FB/
    // Threads skill files hit repeatedly with hand-written JSON). A workflow
    // TASK failure (as opposed to an activity failure) retries indefinitely
    // by default — this crashed silently in a retry loop until caught here.
    const postedToday = postedLog.filter((p) => (p.posted_at || "").startsWith(dateISO)).length;
    postedTodaySoFar += postedToday;
    const cap = page.threads?.daily_budget_max ?? opts.dailyBudgetMax;

    if (postedToday >= cap) {
      results.push({ page_id: page.page_id, outcome: "skipped_capped", reason: `${postedToday}/${cap}` });
      continue;
    }

    // ⛔ OPERATOR FIX (2026-08-07): "you can't drop it, you should fix them —
    // guardrails are to fix and keep trying till fix is done, not drop."
    // A single bad candidate (dead link, no entity match, stale source) no
    // longer zeroes out this page for the whole run — every gate below tries
    // the NEXT candidate in this page's own sourced pool before giving up on
    // the page.
    const pool = await sourceCandidatePool(page, dateISO, postedLog);
    if (pool.length === 0) {
      results.push({ page_id: page.page_id, outcome: "no_candidate" });
      continue;
    }

    const attemptFailures: string[] = [];
    let posted = false;

    for (const candidate of pool) {
      const checked = await checkCandidate(candidate, page, postedLog);
      if (!checked.pass) {
        attemptFailures.push(`${candidate.key}:${checked.reason}`);
        continue;
      }

      const linkCheck = await verifyAndTagLink(candidate, page);
      if (!linkCheck.finalLink || !linkCheck.resolves || !linkCheck.hasUtmTag) {
        attemptFailures.push(
          `${candidate.key}:${!linkCheck.finalLink ? "UTM_MISSING" : !linkCheck.resolves ? "LINK_DEAD" : "UTM_TAG_MISSING"}`
        );
        continue;
      }

      // Deterministic, not the Routine's judgment call (operator decision,
      // 2026-08-06) — which registered entity/entities actually matched this
      // candidate's text is exactly what entityOrSportMatch already computed
      // internally to pass the check above; this just surfaces the names.
      const athleteNames = matchedEntityNames(candidate, page);

      // Deterministic accuracy-gate approximation (freshness + "does the
      // linked source's fetched text actually mention the matched subject") —
      // see checks.ts's accuracyGate for why this isn't full per-claim LLM
      // fact-checking. ⛔ OPERATOR THROUGHPUT PUSH (2026-08-08): widened
      // 72h -> 96h — STALE_CANDIDATE was the #2 cause of dropped candidates
      // (61 of ~200 in one run). A real story from 4 days ago is still a
      // real, accurate story — this loosens a time window, never the actual
      // truth/named-entity/ES-link requirements.
      const accuracy = await checkAccuracy(candidate, athleteNames[0] || null, 96);
      if (!accuracy.pass) {
        attemptFailures.push(`${candidate.key}:${accuracy.reason ?? "ACCURACY_GATE_FAILED"}`);
        continue;
      }

      // ⛔ OPERATOR FIX (2026-08-08): "do what is left" — topic-frequency
      // (3 entity tags/24h, 5 league tags/24h, 2h min gap) and dominant-
      // narrative (≤25% of a page's 7-day posts on one subject) caps from
      // the reference skill file, ported here now. Both try the next
      // candidate on failure like every other gate — never a page-level drop
      // just because THIS candidate happens to repeat a recent subject.
      const primaryEntity = athleteNames[0] || null;
      const frequency = await checkTopicFrequency(candidate, page, primaryEntity, postedLog);
      if (!frequency.pass) {
        attemptFailures.push(`${candidate.key}:${frequency.reason}`);
        continue;
      }
      const dominantNarrative = await checkDominantNarrative(primaryEntity, postedLog);
      if (!dominantNarrative.pass) {
        attemptFailures.push(`${candidate.key}:${dominantNarrative.reason}`);
        continue;
      }

      const caption = await buildCaptionText(candidate, page, athleteNames);

      let cardUrl: string | null = null;
      let template: string | null = null;
      try {
        const render = await renderCard(candidate, page, athleteNames, postedLog, dateISO);
        cardUrl = render.cardUrl;
        template = render.template;
      } catch (e) {
        log.warn("RENDER_FAILED_AFTER_RETRIES", { page_id: page.page_id, error: (e as Error).message });
      }

      // Never actually post live without a card, mirrors the old skill file's
      // "image mandatory, zero exceptions" rule, now enforced as an actual
      // `if`, not a hoped-for compliance. Real, expected failure modes: ES-MCP
      // has no photo for any of the matched athlete/team names (renderCard
      // returns null rather than substituting a generic photo), or the render
      // chain errors out after all retries.
      if (!cardUrl) {
        attemptFailures.push(`${candidate.key}:NO_CARD_RENDER_FAILED`);
        continue;
      }

      if (!opts.livePosting) {
        results.push({ page_id: page.page_id, outcome: "dry_run_would_post", candidate, cardUrl });
      } else {
        // Not scheduled yet — collected for Phase 2 below, which computes one
        // shared post_time anchored to when this whole loop actually finishes.
        readyToPost.push({
          page,
          candidate,
          caption,
          cardUrl,
          finalLink: linkCheck.finalLink,
          template,
          entity: primaryEntity,
          sportGroup: matchedSportGroup(candidate, page),
        });
      }
      posted = true;
      break; // this page's slot for the run is filled — don't consume a second candidate from its pool
    }

    if (!posted) {
      results.push({ page_id: page.page_id, outcome: "dropped", reason: `ALL_CANDIDATES_FAILED:${attemptFailures.join("|")}` });
    }
  }

  // Phase 2 — schedule everything now that all rendering/network work for
  // every page is done. `Date.now()` here (not workflowInfo().startTime) is
  // deliberate: the whole point is "at least an hour from ACTUAL completion,"
  // not from the run's start — replay-determinism doesn't need to hold for a
  // value that only affects a future Postiz schedule timestamp, never a
  // decision this workflow branches on.
  const postTime = new Date(Date.now() + 60 * 60 * 1000);
  for (const item of readyToPost) {
    const posted = await postToThreads(item.page, item.caption, item.cardUrl, item.finalLink, postTime.toISOString(), item.entity, item.sportGroup);

    await recordPosted(item.page.page_id, {
      key: item.candidate.key,
      post_id: posted.id,
      posted_at: new Date().toISOString(),
      reply_url: item.finalLink,
      headline: item.candidate.headline,
      template: item.template ?? undefined,
      entity: item.entity ?? undefined,
      sportGroup: item.sportGroup ?? undefined,
    });

    results.push({ page_id: item.page.page_id, outcome: "posted", candidate: item.candidate, post_id: posted.id });
    postedTodaySoFar++;
  }

  // Pace check against the 150/day target — hour-of-day-aware so an early
  // morning run isn't flagged just for not being at 150 yet. Log only;
  // never blocks or alters this run's own results.
  const hourOfDay = new Date(workflowInfo().startTime).getUTCHours();
  const expectedByNow = Math.round(((hourOfDay + 1) / 24) * MIN_DAILY_POSTS_TARGET);
  if (postedTodaySoFar < expectedByNow) {
    log.warn("BELOW_DAILY_POST_PACE", {
      dateISO,
      postedTodaySoFar,
      expectedByNow,
      target: MIN_DAILY_POSTS_TARGET,
      hourOfDay,
    });
  }

  await saveDryRunResults(dateISO, results);
  return results;
}
