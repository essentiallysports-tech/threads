import { proxyActivities, proxyLocalActivities, log, workflowInfo } from "@temporalio/workflow";
import type * as activities from "../activities";
import { PageRunResult, PageConfig, Candidate, PostedLogEntry } from "../lib/types";
import { matchedEntityNames, matchedSportGroup } from "../lib/checks";

// ⛔ OPERATOR FIX (2026-08-22, real live incident): checkCandidate,
// checkTopicFrequency, and checkDominantNarrative were all proxied as full
// REMOTE Temporal activities despite doing ZERO real I/O — each is just a
// thin wrapper over a pure, synchronous function in checks.ts. Every one of
// the ~391 candidate attempts a real run makes was paying a full activity
// round-trip (multiple Temporal history events each) for zero actual
// benefit, which was confirmed to be why every run was hitting the
// 6000-event workflow-history safety cap during Pass 1, with repair passes
// stuck at 0 every time (BELOW_RUN_FLOOR logs).
//
// ⛔ OPERATOR FIX (2026-08-23, real live incident, SEVERE): the first fix
// called these three as plain in-workflow function calls instead — this
// removed the history cost, but also removed Temporal's replay-determinism
// isolation. A workflow execution in flight when `lib/checks.ts` was next
// deployed (e.g. the foxsports.com domain fix, the role-profile regex fix)
// replayed its already-recorded history against the NEW code — since these
// functions' output for the same inputs had changed, the replay diverged
// from history, the workflow task started failing silently, and it retried
// forever. Because the hourly Temporal Schedule uses
// `ScheduleOverlapPolicy.SKIP`, every subsequent hourly fire was silently
// skipped for 22+ hours until the stuck execution was found and manually
// terminated — a total pipeline outage caused by the very fix meant to
// increase volume.
//
// The real fix is `proxyLocalActivities`, not a plain call: a LOCAL
// activity still executes in-process (no network round-trip to the
// Temporal server to schedule it, unlike proxyActivities) but its RESULT is
// recorded as a single lightweight history Marker — replay reuses that
// recorded value instead of re-invoking the function, so a future
// checks.ts deploy can never diverge an in-flight execution's replay again.
// This keeps the full history-size win (a Marker costs roughly the same as
// what a plain call would have saved, nowhere near a full remote activity's
// ~3 events) while restoring the deploy-safety a remote activity gave for
// free. `checkCandidate`/`checkTopicFrequency`/`checkDominantNarrative`
// still exist as normal exports in activities/index.ts — only how the
// workflow calls them changed.
const { checkCandidate, checkTopicFrequency, checkDominantNarrative } = proxyLocalActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 3 },
});

const {
  loadPages,
  loadPostedLog,
  checkAccuracy,
  verifyAndTagLink,
  buildCaptionText,
  postToThreads,
  recordPosted,
  saveDryRunResults,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

// ⛔ OPERATOR FIX (2026-08-15, real live incident): confirmed live —
// SOURCING_FAILED/"Activity task timed out" on real runs after the internal
// Apify/web-search per-call budgets were raised tonight (Apify's own
// client-side ceiling alone is now (90+30)s = 120s, equal to this activity's
// OLD 2-minute ceiling, before even counting a page's own tier fanning out
// several sequential queries within one call). Its own proxy, longer budget:
// a slow sourcing call using more of the hour's slack is fine; the shared
// 2-minute group above is for the many cheap S3-read activities it used to
// sit alongside, which should still fail fast if THEY hang.
const { sourceCandidatePool } = proxyActivities<typeof activities>({
  startToCloseTimeout: "6 minutes",
  retry: { maximumAttempts: 2 },
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

  // ⛔ OPERATOR HARD FLOOR (2026-08-10): "I want at least 13 posts per run,
  // that is a no compromise now — this should be the minimum ceiling." Unlike
  // the old 150/day number (a logged pace signal only), this is enforced:
  // if the normal single pass across all pages doesn't reach 13, repair
  // passes below re-source and re-try every page that still has run/day
  // budget left, using fresh (often non-deterministic — live search) results,
  // until either 13 is reached or every page is genuinely exhausted. Nothing
  // here fabricates a candidate or skips a guardrail to hit the number —
  // it only spends more real sourcing attempts and lets a page contribute
  // more than one real post per run.
  // ⛔ OPERATOR FIX (2026-08-12): "i anyhow want the 10+ cap atleast to be
  // implemented, cant go lower than that anyhow." 13 already clears that
  // (kept at 13, not lowered) — the real gap was the repair loop below
  // giving up (MAX_REPAIR_PASSES exhausted, or the wall-clock budget hit)
  // before the floor was reached, even on pages that still had untried
  // candidates. Raised MAX_REPAIR_PASSES so the loop keeps spending real
  // sourcing/render attempts on genuinely-still-eligible pages for longer
  // before giving up — it already exits immediately once a pass finds zero
  // eligible pages (real exhaustion), so this only spends more time when
  // there's real remaining work to try, never fabricates to fill the gap.
  // ⛔ OPERATOR REVERSAL (2026-08-12, same day): "I am ready to bring down
  // the floor to 7 per run but then quality must be at par with what
  // manual posting is doing. No errors allowed then." Lowered from 13 to 7
  // in direct exchange for sourcing.ts's tier-gating reversal (risky
  // tiers now last-resort only) — every quality incident this session
  // traced back to chasing volume through Twitter/Reddit/web_search; a
  // lower, honest floor built almost entirely from es_article + real
  // Beehiiv polls is the actual trade being made here, not an arbitrary
  // number change.
  // ⛔ OPERATOR FIX (2026-08-18): "make sure every run anyhow produces more
  // than 8+ genuine posts." Raised from 7 — the quality trade the 7-floor
  // was made for (real es_article/Beehiiv-poll sourcing over risky Twitter/
  // Reddit/web_search tiers) is still in force; this doesn't reopen that,
  // it raises the target now that the entity-scoping, evergreen-web-search,
  // and composite-render fixes (2026-08-17/18) have measurably improved
  // real candidate yield per page. MAX_REPAIR_PASSES raised to match — a
  // higher floor needs more real attempts to reach it honestly, not a
  // shortcut.
  const MIN_POSTS_PER_RUN = 12;
  const MAX_REPAIR_PASSES = 10;
  // ⛔ OPERATOR FIX (2026-08-19): "make sure more posts are created now so
  // we can compete with manual postings." Raised from 3 — the same-day
  // fixes landed this run (OpenArt credential restored, the history-size
  // crash backstop, the content-value gate broadening, entity-priority
  // candidate ordering, the broken composite path disabled) mean a page
  // with genuinely good candidates now reliably clears its gates instead
  // of stalling on infra failures or getting crowded out by generic noise
  // — the real remaining lever for volume is letting a page that has
  // several REAL, passing stories post more than 3 of them in one run,
  // not artificially spreading the floor thinner across pages that don't
  // have anything good to say today. MIN_POSTS_PER_RUN raised alongside it
  // so the floor still reflects a genuinely higher bar, not just a wider
  // per-page allowance.
  const PER_RUN_PAGE_CAP = 5;
  // ⛔ OPERATOR FIX (2026-08-23, real live incident): 13 of 27 pages carry a
  // daily_budget_max of 6-8 — a single good hour hitting the flat
  // PER_RUN_PAGE_CAP=5 could burn 63-83% of such a page's ENTIRE day in one
  // run, leaving it capped out for ~20 remaining hourly fires and shrinking
  // the pool later runs draw from to hit the 12-post floor. Repair passes
  // don't fix this — they address cross-run candidate availability, not a
  // single run already having spent the page's whole daily allowance.
  // Scales the per-run cap to roughly a quarter of the page's own budget
  // (floor of 2, never above the global PER_RUN_PAGE_CAP) so no single hour
  // can exhaust a low-budget page's whole day — spreading real posts across
  // the day is itself part of looking like a real, ongoing account, not
  // just a volume nicety.
  function perRunCapFor(cap: number): number {
    return Math.min(PER_RUN_PAGE_CAP, Math.max(2, Math.ceil(cap / 4)));
  }

  // ⛔ OPERATOR FIX (2026-08-19, real live incident, severe): confirmed live
  // via Temporal's own reverse-history lookup — the "mystery" workflow
  // terminations investigated earlier this session, and the "no posts went
  // out" incident today, were the SAME root cause: Temporal's own
  // history-service auto-terminates a workflow once its execution history
  // exceeds Temporal's hard size limit ("Workflow history size exceeds
  // limit.", identity: "history-service"). Every candidate attempt in
  // attemptPageCandidates below costs at least 1 activity (checkCandidate)
  // and up to 7+ (verifyAndTagLink, checkAccuracy, checkTopicFrequency,
  // checkDominantNarrative, buildCaptionText, renderCard's own sub-calls,
  // postToThreads) — with 27 pages, up to MAX_REPAIR_PASSES repair passes,
  // and every source tier now offering more candidates than before
  // (sourceFromEsArticles doubled per-article via the multi-angle fix), a
  // bad-enough day (today's OpenArt outage made EVERY render fail, so EVERY
  // candidate for EVERY page burned through its whole pool every pass) can
  // genuinely blow past Temporal's ceiling and kill the run outright —
  // losing every post that would have gone out, not just the failing ones.
  // This is a hard backstop independent of the underlying cause: once the
  // run's total candidate-attempt count crosses this ceiling, stop trying
  // NEW candidates entirely and proceed straight to Phase 2 with whatever's
  // already ready — a below-floor result from this cap is an honest, logged
  // outcome (same posture as the existing time-budget cutoff), never a
  // silent crash that loses a whole run's real work.
  // ⛔ OPERATOR FIX (2026-08-19, real live incident, same day, FOUR
  // attempts): candidate-attempt counters (350, then 3000) were the wrong
  // proxy — real history growth comes from everything that generates
  // Temporal events (sourcing/render activity retries included), not just
  // this loop's own gate-chain calls. `continueAsNewSuggested` measured the
  // real thing but fires far too early for a bounded one-hour workflow.
  // `historyLength` (attempt 3, threshold 20,000) was STILL wrong —
  // confirmed live the real crash happened at ~9,614 EVENTS, nowhere near
  // 20,000. The actual server error is "Workflow history SIZE exceeds
  // limit" — size, i.e. BYTES (`historySize`), not event count
  // (`historyLength`) — this workflow's events apparently carry heavy
  // payloads (full render specs, candidate data, API error bodies), so a
  // byte ceiling is reached at a deceptively low event count. Checking the
  // metric the server's own error message actually names, with a
  // conservative margin below a typical ~50MB Temporal default, since this
  // namespace's exact configured limit isn't directly visible.
  const MAX_HISTORY_SIZE_BYTES = 30_000_000; // ~30MB — real margin below a ~50MB-class ceiling
  // Redundant safety net, real margin below the ACTUAL observed crash point
  // (confirmed live: terminated at event 9614) — in case `historySize`
  // reads zero on this server version (the SDK docs note it's only
  // populated on Temporal Server 1.20+) and would otherwise never trip.
  const MAX_HISTORY_LENGTH_FALLBACK = 6_000;
  let totalCandidateAttempts = 0; // observability only
  function attemptBudgetExceeded(): boolean {
    const info = workflowInfo();
    return info.historySize >= MAX_HISTORY_SIZE_BYTES || info.historyLength >= MAX_HISTORY_LENGTH_FALLBACK;
  }

  // ⛔ OPERATOR FIX (2026-08-10/11, real live incident): a run that started
  // at 16:00Z was STILL RUNNING at 18:26Z — 2.5 hours, blocking every
  // scheduled fire in between (ScheduleOverlapPolicy.SKIP). Root cause: every
  // page was processed one at a time in a plain `for` loop, so total runtime
  // scaled linearly with (page count × sourcing/render latency), and with
  // Apify's Reddit scraper having a genuinely bad day (real TIMED-OUT
  // responses), each slow tier's now-enforced timeout ceiling (see
  // httpUtil.ts) got paid out sequentially, once per page, per pass. "15
  // minutes, skip what fails" (operator directive) — two real levers: pages
  // now run CONCURRENTLY (bounded — a full unbounded fan-out across ~26
  // pages would itself risk hammering Apify/OpenArt/ES-MCP into more
  // timeouts, defeating the point), and a hard wall-clock budget stops the
  // run from chasing the 13-post floor past a sane ceiling — a below-floor
  // result because time ran out is an honest, logged outcome, never a
  // fabrication shortcut.
  // ⛔ OPERATOR FIX (2026-08-12): raised from 15 to 20, then to 45 minutes —
  // "cant go lower than [10] anyhow." Real live runs (2026-08-12 morning)
  // were hitting BELOW_RUN_FLOOR specifically because this ceiling cut the
  // repair loop off before the newly-raised MAX_REPAIR_PASSES could be
  // used, even on pages that still had real untried candidates. The hourly
  // schedule (ScheduleOverlapPolicy.SKIP) tolerates a run this long —
  // worst case it skips the next hourly fire rather than overlapping, and
  // that's a far smaller cost than missing the floor outright. Still a
  // hard ceiling, not removed — a below-floor result from genuinely
  // running out of time stays an honest, logged outcome, never a
  // fabrication shortcut.
  // ⛔ OPERATOR FIX (2026-08-18, explicit operator directive: "even 7 wasn't
  // enforced before, so not just raise the floor, make sure it is enforced
  // as well"). Confirmed: real observed runs were already taking ~35-40
  // minutes, meaning this 45-minute ceiling was very likely the actual
  // reason the 7-floor kept getting logged as BELOW_RUN_FLOOR — the repair
  // loop was hitting the clock, not genuine candidate exhaustion (which
  // already exits the loop immediately on its own, per the loop's own
  // logic below). Raised to 90 minutes so a below-floor result is far more
  // likely to be a real "ran out of eligible candidates" outcome instead of
  // an artificial time cutoff. Still a hard, finite ceiling, not removed —
  // an honest below-floor result from genuine exhaustion stays a logged
  // outcome, never a fabrication shortcut.
  const RUN_TIME_BUDGET_MS = 90 * 60 * 1000;
  const PAGE_CONCURRENCY = 6;
  const runStartMs = new Date(workflowInfo().startTime).getTime();
  const timeBudgetExceeded = () => Date.now() - runStartMs > RUN_TIME_BUDGET_MS;

  // Bounded-concurrency fan-out — plain Promise/async, no timers or
  // external randomness, so it replays exactly like any other workflow-code
  // control flow. Each of `concurrency` workers pulls the next unclaimed
  // item off a shared index until the list is exhausted; every item still
  // runs through the SAME per-page try/catch (attemptPageCandidates,
  // sourceCandidatePool) as before, so a failure in one page's slot still
  // only costs that page.
  async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
    let index = 0;
    async function worker(): Promise<void> {
      while (index < items.length) {
        const item = items[index++];
        await fn(item);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  }

  const MIN_DAILY_POSTS_TARGET = 150; // secondary pace telemetry only, see below
  let postedTodaySoFar = 0;

  interface PageRunState {
    page: PageConfig;
    postedLog: PostedLogEntry[];
    postedTodayCount: number;
    cap: number;
    thisRunEntries: PostedLogEntry[]; // synthetic entries for candidates already picked THIS run — fed back into checks so a second pull from the same page's pool can't repeat/oversaturate a subject the first pull already used
    triedKeys: Set<string>;
    postedThisRun: number;
    attemptFailures: string[];
    hadAnyCandidateInitially: boolean;
  }

  const states: PageRunState[] = [];
  for (const page of pages) {
    let postedLog: PostedLogEntry[];
    try {
      postedLog = await loadPostedLog(page.page_id);
    } catch (e) {
      // ⛔ OPERATOR FIX (2026-08-10, real live incident): this exact
      // unguarded call is part of why 7 hourly runs failed today before a
      // fix — an S3 read failure for ONE page must never take down the
      // entire run before any other page even gets a chance.
      log.warn("LOAD_POSTED_LOG_FAILED", { page_id: page.page_id, error: (e as Error).message });
      results.push({ page_id: page.page_id, outcome: "dropped", reason: `LOAD_POSTED_LOG_FAILED:${(e as Error).message?.slice(0, 200)}` });
      continue;
    }
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

    states.push({
      page,
      postedLog,
      postedTodayCount: postedToday,
      cap,
      thisRunEntries: [],
      triedKeys: new Set(),
      postedThisRun: 0,
      attemptFailures: [],
      hadAnyCandidateInitially: false,
    });
  }

  const nowISO = new Date(workflowInfo().startTime).toISOString();

  // ⛔ OPERATOR FIX (2026-08-07, extended 2026-08-10): "you can't drop it,
  // you should fix them — guardrails are to fix and keep trying till fix is
  // done, not drop." A single bad candidate no longer zeroes out a page —
  // every gate below tries the NEXT candidate in the page's pool. Extended
  // now to try MULTIPLE passing candidates per page per run (not just one),
  // so a page whose pool has 3 real, distinct, passing stories contributes
  // 3 posts this run instead of 1 — directly serves both the 13-post floor
  // and "no ES article left unposted" (candidates is already ES-article-
  // first ordered, see sourcing.ts).
  async function attemptPageCandidates(state: PageRunState, pool: Candidate[]): Promise<void> {
    for (const candidate of pool) {
      if (state.postedThisRun >= perRunCapFor(state.cap) || state.postedTodayCount >= state.cap) return;
      // "15 min run, skip what fails" — a page's own candidate loop (up to
      // PER_RUN_PAGE_CAP tries, each a full source→check→render→QC chain)
      // must not keep grinding once the run's overall time budget is spent,
      // even if this one page still has untried candidates left.
      if (timeBudgetExceeded()) return;
      if (attemptBudgetExceeded()) return;
      if (state.triedKeys.has(candidate.key)) continue;
      state.triedKeys.add(candidate.key);
      totalCandidateAttempts++;

      const effectivePostedLog = [...state.postedLog, ...state.thisRunEntries];

      // ⛔ OPERATOR FIX (2026-08-10, real live incident): 7 consecutive
      // hourly runs failed today (01:00-08:00Z) before this fix — root
      // cause confirmed via Temporal's actual execution history: a
      // `checkAccuracy` activity call exhausted its retries on a slow
      // fetch and threw, and NOTHING here caught it. Only `renderCard`
      // below had a try/catch; every other check — checkCandidate,
      // verifyAndTagLink, checkAccuracy, checkTopicFrequency,
      // checkDominantNarrative, buildCaptionText — could throw straight
      // through this function and crash the ENTIRE workflow execution,
      // losing every other page not yet processed that run. This directly
      // contradicts the project's own stated design ("guardrails are to
      // fix and keep trying till fix is done, not drop the whole page/run")
      // — a slow or dead URL on ONE candidate should cost that candidate,
      // never the whole run. The entire per-candidate gate chain is now
      // one try/catch: any unexpected error (activity timeout after
      // exhausted retries, a network blip, anything) is treated exactly
      // like a normal failed gate — logged, added to attemptFailures, and
      // the loop moves on to the next candidate.
      try {
        const checked = await checkCandidate(candidate, state.page, effectivePostedLog);
        if (!checked.pass) {
          state.attemptFailures.push(`${candidate.key}:${checked.reason}`);
          continue;
        }

        const linkCheck = await verifyAndTagLink(candidate, state.page);
        if (!linkCheck.finalLink || !linkCheck.resolves || !linkCheck.hasUtmTag) {
          state.attemptFailures.push(
            `${candidate.key}:${!linkCheck.finalLink ? "UTM_MISSING" : !linkCheck.resolves ? "LINK_DEAD" : "UTM_TAG_MISSING"}`
          );
          continue;
        }

        // Deterministic, not the Routine's judgment call (operator decision,
        // 2026-08-06) — which registered entity/entities actually matched this
        // candidate's text is exactly what entityOrSportMatch already computed
        // internally to pass the check above; this just surfaces the names.
        const athleteNames = matchedEntityNames(candidate, state.page);

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
          state.attemptFailures.push(`${candidate.key}:${accuracy.reason ?? "ACCURACY_GATE_FAILED"}`);
          continue;
        }

        // ⛔ OPERATOR FIX (2026-08-08): "do what is left" — topic-frequency
        // (3 entity tags/24h, 5 league tags/24h, 2h min gap) and dominant-
        // narrative (≤25% of a page's 7-day posts on one subject) caps from
        // the reference skill file, ported here now. Both try the next
        // candidate on failure like every other gate — never a page-level drop
        // just because THIS candidate happens to repeat a recent subject.
        // `effectivePostedLog` (not the raw log loaded at run start) is what
        // makes these caps see a candidate this SAME run already picked for
        // this page, so a second/third pull from one page's pool can't just
        // repeat the same entity three times in one hour.
        const primaryEntity = athleteNames[0] || null;
        // ⛔ OPERATOR FIX (2026-08-23): the original `<= 1` cutoff only
        // covered a literal single-entity page. The math generalizes: with N
        // entities, a perfectly EVEN split still gives each one a 1/N share
        // — dominantNarrativeCheck's >25% threshold is only satisfiable at
        // all once 1/N <= 0.25, i.e. N >= 4. A 2-entity page (Purple & Gold
        // Pride: Lakers + Doncic; Colorado Prime Time: Deion + Shedeur
        // Sanders) or 3-entity page is just as structurally guaranteed to
        // fail as a 1-entity one, confirmed live: Colorado's OWN namesake
        // (Deion Sanders) was getting capped by this exact math. Both flags
        // are computed inside the checkTopicFrequency/checkDominantNarrative
        // activity wrappers from `page` now, not here.
        const frequency = await checkTopicFrequency(candidate, state.page, primaryEntity, effectivePostedLog);
        if (!frequency.pass) {
          state.attemptFailures.push(`${candidate.key}:${frequency.reason}`);
          continue;
        }
        const dominantNarrative = await checkDominantNarrative(primaryEntity, effectivePostedLog, state.page);
        if (!dominantNarrative.pass) {
          state.attemptFailures.push(`${candidate.key}:${dominantNarrative.reason}`);
          continue;
        }

        const caption = await buildCaptionText(candidate, state.page, athleteNames);

        let cardUrl: string | null = null;
        let template: string | null = null;
        // ⛔ OPERATOR FIX (2026-08-12, real live incident): "still the same
        // errors repeating" — renderCard resolves the entity correctly
        // internally (AI-priority, see its own comments), but the workflow
        // was still logging/capping against `primaryEntity` above, computed
        // from the OLD regex-fallback-inclusive matchedEntityNames call —
        // garbage entities kept getting written to the posted log (and
        // feeding future frequency/dominant-narrative checks) even after
        // the photo itself got fixed. `resolvedPrimaryEntity` overrides
        // `primaryEntity` for logging purposes once render actually runs —
        // frequency/dominant-narrative checks above still use the cheaper
        // upfront guess as a fast pre-filter (acceptable; low-stakes
        // compared to what gets permanently written to the log).
        let resolvedPrimaryEntity = primaryEntity;
        try {
          const render = await renderCard(candidate, state.page, athleteNames, effectivePostedLog, dateISO);
          cardUrl = render.cardUrl;
          template = render.template;
          if (render.resolvedEntity) resolvedPrimaryEntity = render.resolvedEntity;
        } catch (e) {
          log.warn("RENDER_FAILED_AFTER_RETRIES", { page_id: state.page.page_id, error: (e as Error).message });
        }

        // Never actually post live without a card, mirrors the old skill file's
        // "image mandatory, zero exceptions" rule, now enforced as an actual
        // `if`, not a hoped-for compliance. Real, expected failure modes: ES-MCP
        // has no photo for any of the matched athlete/team names (renderCard
        // returns null rather than substituting a generic photo), or the render
        // chain errors out after all retries.
        if (!cardUrl) {
          state.attemptFailures.push(`${candidate.key}:NO_CARD_RENDER_FAILED`);
          continue;
        }

        const sportGroup = matchedSportGroup(candidate, state.page);

        if (!opts.livePosting) {
          results.push({ page_id: state.page.page_id, outcome: "dry_run_would_post", candidate, cardUrl });
        } else {
          // Not scheduled yet — collected for Phase 2 below, which computes one
          // shared post_time anchored to when this whole loop actually finishes.
          readyToPost.push({
            page: state.page,
            candidate,
            caption,
            cardUrl,
            finalLink: linkCheck.finalLink,
            template,
            entity: resolvedPrimaryEntity,
            sportGroup,
          });
        }

        state.thisRunEntries.push({
          key: candidate.key,
          posted_at: nowISO,
          reply_url: linkCheck.finalLink,
          headline: candidate.headline,
          template: template ?? undefined,
          entity: resolvedPrimaryEntity ?? undefined,
          sportGroup: sportGroup ?? undefined,
          card_url: cardUrl,
          source: candidate.source,
          source_published_at: candidate.publishedAt,
        });
        state.postedThisRun++;
        state.postedTodayCount++;
      } catch (e) {
        log.warn("CANDIDATE_GATE_CHAIN_FAILED", { page_id: state.page.page_id, key: candidate.key, error: (e as Error).message });
        state.attemptFailures.push(`${candidate.key}:UNEXPECTED_ERROR:${(e as Error).message?.slice(0, 200)}`);
      }
    }
  }

  const totalPostedThisRun = () => states.reduce((sum, s) => sum + s.postedThisRun, 0);

  // Pass 1 — every page's sourcing + candidate-gate-chain now runs
  // concurrently (bounded by PAGE_CONCURRENCY), instead of one page fully
  // finishing before the next starts. Each page is still wrapped in its own
  // try/catch for the same reason as before: sourceCandidatePool fans out
  // across many live network tiers (web/social search, ES-MCP, evergreen
  // bank) — one page's sourcing hitting an unexpected error must cost only
  // that page, never the rest of the run.
  await mapWithConcurrency(states, PAGE_CONCURRENCY, async (state) => {
    try {
      const pool = await sourceCandidatePool(state.page, dateISO, state.postedLog);
      state.hadAnyCandidateInitially = pool.length > 0;
      if (pool.length === 0) return;
      await attemptPageCandidates(state, pool);
    } catch (e) {
      log.warn("SOURCING_FAILED", { page_id: state.page.page_id, error: (e as Error).message });
      state.attemptFailures.push(`SOURCING_ERROR:${(e as Error).message?.slice(0, 200)}`);
    }
  });

  // Repair passes — only runs when pass 1 didn't reach the floor AND the
  // run's time budget isn't already spent (chasing the floor is explicitly
  // subordinate to the 15-minute ceiling — "15 min run, skip what fails").
  // Each pass re-sources (fresh call: web/social search tiers are live, so
  // this can genuinely surface new content, not just re-fail the same
  // candidates) every page still under its per-run and per-day cap,
  // skipping any candidate key already tried this run — and, like pass 1,
  // every page in a pass runs concurrently rather than one at a time.
  let repairPass = 0;
  while (totalPostedThisRun() < MIN_POSTS_PER_RUN && repairPass < MAX_REPAIR_PASSES && !timeBudgetExceeded() && !attemptBudgetExceeded()) {
    repairPass++;
    const eligible = states.filter((s) => s.postedThisRun < perRunCapFor(s.cap) && s.postedTodayCount < s.cap);
    if (eligible.length === 0) break; // every remaining page is genuinely exhausted — nothing left to repair

    await mapWithConcurrency(eligible, PAGE_CONCURRENCY, async (state) => {
      if (totalPostedThisRun() >= MIN_POSTS_PER_RUN || timeBudgetExceeded() || attemptBudgetExceeded()) return;
      try {
        const pool = await sourceCandidatePool(state.page, dateISO, state.postedLog);
        const fresh = pool.filter((c) => !state.triedKeys.has(c.key));
        if (fresh.length === 0) return;
        await attemptPageCandidates(state, fresh);
      } catch (e) {
        log.warn("SOURCING_FAILED", { page_id: state.page.page_id, repairPass, error: (e as Error).message });
        state.attemptFailures.push(`SOURCING_ERROR:${(e as Error).message?.slice(0, 200)}`);
      }
    });
  }

  for (const state of states) {
    if (state.postedThisRun > 0) continue;
    if (!state.hadAnyCandidateInitially && state.attemptFailures.length === 0) {
      results.push({ page_id: state.page.page_id, outcome: "no_candidate" });
    } else {
      results.push({ page_id: state.page.page_id, outcome: "dropped", reason: `ALL_CANDIDATES_FAILED:${state.attemptFailures.join("|")}` });
    }
  }

  if (opts.livePosting && totalPostedThisRun() < MIN_POSTS_PER_RUN) {
    log.warn("BELOW_RUN_FLOOR", {
      dateISO,
      postedThisRun: totalPostedThisRun(),
      floor: MIN_POSTS_PER_RUN,
      repairPassesUsed: repairPass,
      elapsedMs: Date.now() - runStartMs,
      totalCandidateAttempts,
      reason: timeBudgetExceeded()
        ? "hit the run time budget before reaching the floor — 'skip what fails' takes priority over exhaustively chasing the floor, not a fabrication shortcut"
        : attemptBudgetExceeded()
        ? `workflow history reached the ${MAX_HISTORY_SIZE_BYTES}-byte or ${MAX_HISTORY_LENGTH_FALLBACK}-event safety threshold before reaching the floor — stopped rather than risk the whole run getting force-terminated by the server's own history-size limit; a below-floor result here is far better than losing the whole run`
        : "every eligible page is at its per-run/day cap or genuinely has no more passing candidates — not a fabrication shortcut",
    });
  }

  // Phase 2 — schedule everything now that all rendering/network work for
  // every page is done. `Date.now()` here (not workflowInfo().startTime) is
  // deliberate: the whole point is "at least an hour from ACTUAL completion,"
  // not from the run's start — replay-determinism doesn't need to hold for a
  // value that only affects a future Postiz schedule timestamp, never a
  // decision this workflow branches on.
  const postTime = new Date(Date.now() + 60 * 60 * 1000);
  // Multiple posts from the SAME page in one run (new as of the 13-post
  // floor above) must not all land on the exact same scheduled second —
  // stagger same-page posts 15 minutes apart so they don't fire simultaneously.
  const postCountForPage = new Map<string, number>();
  for (const item of readyToPost) {
    const indexForPage = postCountForPage.get(item.page.page_id) ?? 0;
    postCountForPage.set(item.page.page_id, indexForPage + 1);
    const itemPostTime = new Date(postTime.getTime() + indexForPage * 15 * 60 * 1000);

    // ⛔ OPERATOR FIX (2026-08-10): same class of bug as attemptPageCandidates
    // above — a Postiz/S3 failure scheduling ONE already-rendered item must
    // never abort every other already-rendered item still waiting in this
    // same loop (each represents real, already-spent render/AI-caption work).
    try {
      const posted = await postToThreads(item.page, item.caption, item.cardUrl, item.finalLink, itemPostTime.toISOString(), item.entity, item.sportGroup);

      await recordPosted(item.page.page_id, {
        key: item.candidate.key,
        post_id: posted.id,
        posted_at: new Date().toISOString(),
        reply_url: item.finalLink,
        headline: item.candidate.headline,
        template: item.template ?? undefined,
        entity: item.entity ?? undefined,
        sportGroup: item.sportGroup ?? undefined,
        card_url: item.cardUrl,
        source: item.candidate.source,
        source_published_at: item.candidate.publishedAt,
      });

      results.push({ page_id: item.page.page_id, outcome: "posted", candidate: item.candidate, post_id: posted.id });
      postedTodaySoFar++;
    } catch (e) {
      log.warn("POST_TO_THREADS_FAILED", { page_id: item.page.page_id, key: item.candidate.key, error: (e as Error).message });
      results.push({ page_id: item.page.page_id, outcome: "dropped", reason: `POST_FAILED:${(e as Error).message?.slice(0, 200)}` });
    }
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
