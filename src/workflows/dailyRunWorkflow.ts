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

// ⛔ OPERATOR FIX (2026-08-24, real live incident, severe): checkDuplicateStory
// (see checks.ts's duplicateStoryCheck for the incident — the same page
// posting the same real-world event twice within hours) is invoked at the
// same high per-candidate frequency as the three pure checks above, but
// unlike them it SOMETIMES makes a real AI-gateway call (only when there's
// a genuine same-entity recent post to compare against — most invocations
// short-circuit on a cheap, free pre-filter and never touch the network at
// all). Still a local activity for the same history-cost reason as above,
// but given its own separate proxy with a LONGER timeout: the underlying
// isDuplicateStoryViaAI call has its own internal 30s fetch timeout and
// deliberately fails open (never-duplicate) on any error — if this outer
// timeout were shorter than that inner one (e.g. the 10s used above), a
// slow-but-real AI call would get killed by Temporal BEFORE the function's
// own graceful fail-open ever got a chance to run, throwing a hard error
// instead of degrading gracefully. maximumAttempts:1 because the function
// already handles its own failure path internally — an outer retry would
// just redundantly re-attempt a call that already degraded on its own.
const { checkDuplicateStory, checkPersonalLifeContent } = proxyLocalActivities<typeof activities>({
  startToCloseTimeout: "35 seconds",
  retry: { maximumAttempts: 1 },
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
// ⛔ OPERATOR FIX (2026-08-25, real live incident): confirmed live — 9
// "SOURCING_FAILED ... Activity task timed out" events in the last ~30h,
// all under the sharded config. Root cause traced into webSearch.ts:
// sourceFromEvergreenWebSearch (always runs) and sourceFromWebSearch (the
// risky-tier fallback, which fires exactly when a page is genuinely short
// on safe candidates — the pages this matters most for) each wrap a
// Claude-then-Grok chain with its own internal retry, worst-case ~168s
// EACH, and the two tiers sit in separate sequential Promise.all groups —
// so a page hitting both slow paths under real Gateway saturation could
// legitimately need ~300s+ to get a real answer. The OLD 6-minute ceiling
// left too little margin for that legitimate case, killing near-complete
// work; and since gateway saturation persists for seconds-to-minutes (the
// same reasoning already behind webSearch.ts's own backoff), a Temporal-
// level retry of the WHOLE activity almost always just re-hits the same
// wall — same "already handles its own failure path internally, an outer
// retry is redundant" reasoning as renderCard's proxy below, since every
// individual tier inside sourceCandidatePoolForPage already catches its
// own errors. Raised the ceiling for real headroom, dropped to 1 attempt
// so a doomed call fails once (~8 min) instead of twice (~12 min) before
// that page's repair pass moves on to a candidate that can actually post.
// ⛔ OPERATOR FIX (2026-08-31, real live incident): p44 (EssentiallySports
// Media, the flagship multi-sport page) registers 6 sport_groups — every
// other page in the fleet has 1-2 — so its sport×day fan-out in
// sourceFromEsArticles is ~6x a normal page's (24 combos vs ~4), still at
// the same page-local concurrency=2. That routinely blew through the old
// 8-minute ceiling (confirmed live: p44 posted zero times in 44+ hours,
// every attempt logging SOURCING_FAILED/"Activity task timed out", while
// sibling pages in the same shard kept posting normally). Deliberately
// fixed via MORE TIME, not more concurrency: this same file's ES-MCP
// limiter (esMcp.ts) has already caused two real fleet-wide incidents
// (2026-08-23, 2026-08-29) when concurrent load against that one shared
// endpoint went up — raising p44's own fan-out concurrency would repeat
// that exact class of failure for every other page sharing the limiter.
// A longer single-attempt ceiling only costs anything for a page that
// actually needs it; every other page still returns in seconds.
const { sourceCandidatePool } = proxyActivities<typeof activities>({
  startToCloseTimeout: "20 minutes",
  retry: { maximumAttempts: 1 },
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
  // ⛔ OPERATOR FIX (2026-08-24, real live directive): "40+ pages now, so
  // daily 250+ posts are anyhow needed now, so transform the system such
  // that it does not cause timeouts, it doesnt reduce the cadence." One
  // workflow execution looping over every page (even at PAGE_CONCURRENCY=6)
  // scales linearly with page count — this is the SAME shape of bug that
  // caused the 2026-08-10/11 "run still going 2.5 hours later" incident at
  // just 26 pages sequential; going from 27 to 45+ pages in the same single
  // execution risks recreating it. Mirrors the FB pipeline's own proven
  // SHARD MODE (es-pipeline skill: 6 shards of ~4 pages each, independently
  // scheduled) instead of reinventing a different fix — when both are set,
  // the workflow processes only pages whose numeric page_id mod shardCount
  // equals shardIndex; every OTHER page is untouched by this execution.
  // Undefined/omitted (either field) falls through to the pre-sharding
  // behavior (every page, one execution) — this is what keeps a manual
  // run-once or an already-scheduled fire from a pre-sharding deploy safe.
  shardIndex?: number;
  shardCount?: number;
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

  const allPages = await loadPages();
  // Deterministic, no hash function needed — every real page_id here is
  // "p" + a number (confirmed live across all 45+ registry entries), and a
  // numeric mod distributes newly-added pages round-robin across shards
  // automatically as page_ids keep incrementing, with zero shard-membership
  // list to maintain by hand (the FB pipeline's shard table needs manual
  // upkeep every time a page is added; this doesn't).
  const pages =
    opts.shardCount && opts.shardCount > 1
      ? allPages.filter((p) => {
          const n = parseInt(p.page_id.replace(/\D/g, ""), 10);
          return Number.isFinite(n) && n % opts.shardCount! === (opts.shardIndex ?? 0);
        })
      : allPages;
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
    sourcePhotoUrl: string | null;
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
  // ⛔ OPERATOR FIX (2026-08-24, sharding rollout): was 12, enforced against
  // ALL ~27 pages in one execution. Post-sharding this floor applies PER
  // SHARD (~7-8 pages, roughly 8/27 of the fleet) — kept proportional
  // (12 * 8/27 ≈ 3.5, rounded up with margin) rather than carried over
  // unchanged, which would demand nearly the OLD floor from a fraction of
  // the pages. 6 shards * 5 * ~14.5 active hours (09:00-23:30 posting
  // window) gives real headroom above the 250+/day target even if some
  // hourly fires fall short — needs real-data validation like every other
  // number here, not a guaranteed hit.
  const MIN_POSTS_PER_RUN = 5;
  // ⛔ OPERATOR FIX (2026-08-25, sharding rollout, real live incident):
  // confirmed live — EVERY post-sharding BELOW_RUN_FLOOR log shows
  // repairPassesUsed:10 (the max), with elapsedMs of 47-82 minutes; pre-
  // sharding runs mostly used repairPassesUsed:1 and finished in 17-53
  // minutes chasing a HIGHER floor (12, not 5). 10 was calibrated for a
  // single execution's ~27-page pool with the ORIGINAL, higher per-shard
  // concurrency; lowering PAGE_CONCURRENCY and the ES-MCP/web-search fan-out
  // to fix the overload problem (see their own comments) directly made each
  // individual repair pass slower, so the same pass count now costs
  // proportionally more wall-clock. Halved rather than left unchanged —
  // the MIN_GAP and retrospective-page fixes landed the same day should
  // mean fewer pages NEED repair passes to begin with (less artificial
  // blocking to retry around), so this isn't purely a "give up sooner"
  // trade — needs real-data validation like every other number here.
  const MAX_REPAIR_PASSES = 5;
  // ⛔ OPERATOR FIX (2026-08-27, real live incident, explicit operator
  // directive: "atleast 5 should go to every page per day that is the
  // minimum"). Confirmed live: 14 of 42 pages had ZERO posts in 24h while a
  // handful had 9-12 — not random variance, a structural bias. The repair-
  // pass loop below only checked the SHARD-WIDE total against
  // MIN_POSTS_PER_RUN, and stopped dispatching to a page the instant that
  // shared total was hit by ANY sibling page — so pages with slower
  // sourcing or harder-to-pass content lost the race every single cycle,
  // all day, forever. This is a genuinely different, per-page floor (5/day/
  // page, not 5/shard/run) — 5 * 42 pages = 210, which also satisfies the
  // "at least 200/day total" directive as the same fix.
  const MIN_POSTS_PER_PAGE_PER_DAY = 5;
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
  // ⛔ OPERATOR FIX (2026-08-25, sharding rollout, explicit operator
  // directive: "high volume but not in 100 mins, in under 40 mins cos that
  // is doable"). 90 minutes was calibrated for a single execution chasing a
  // 12-post floor across ~27 pages — post-sharding, a shard chases a 5-post
  // floor across ~7-8 pages, and the FIRST cycle's own healthy shards
  // (before any of today's other fixes) already finished in ~29-33 minutes
  // on their own. Today's other fixes (MIN_GAP, retrospective exemption,
  // team-conflict check, generic-profile detection, the repair-pass short-
  // circuit, MAX_REPAIR_PASSES halved) all target the SAME thing — fewer
  // wasted attempts on candidates that were structurally doomed regardless
  // of content — so the realistic per-pass yield should be higher than it
  // was when 90 minutes was chosen, not lower. Set to 35 minutes for Phase 1
  // (repair-pass chasing), leaving real margin below the 40-minute target
  // for Phase 2's own posting time. Still a hard, finite ceiling — an
  // honest below-floor result from hitting this stays a logged outcome, not
  // a fabrication shortcut, same as always.
  const RUN_TIME_BUDGET_MS = 35 * 60 * 1000;
  // ⛔ OPERATOR REVERSAL (2026-08-24, sharding rollout, real live incident,
  // same day): was raised 6->8 at rollout on the theory that a smaller
  // ~7-8 page shard could afford more internal concurrency. The FIRST real
  // sharded cycle disproved that: 2 of 6 shards (shard-2, shard-4) came in
  // BELOW their own 5-post floor DESPITE burning all 10 repair passes and
  // ~55-58 minutes each (vs ~30 min for the 4 healthy shards) — confirmed
  // live via BELOW_RUN_FLOOR's own repairPassesUsed:10 — and the worker log
  // showed 406 "operation was aborted" events in that same window. Raising
  // PAGE_CONCURRENCY made EVERY shard's peak concurrent fan-out bigger at
  // the exact moment 6 shards were ALSO now running concurrently with each
  // other — the two changes compounded instead of offsetting. Lowered
  // below the ORIGINAL pre-sharding value (not just back to 6): the 6-way
  // shard split now supplies the primary parallelism system-wide, so each
  // shard doesn't need to also aggressively parallelize internally against
  // shared downstream services it's no longer using alone.
  const PAGE_CONCURRENCY = 4;
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

  // ⛔ OPERATOR FIX (2026-08-24, sharding rollout): raised from 150 (site-
  // wide target at ~27 pages) to reflect "40+ pages now, 250+ posts/day
  // needed." `postedTodaySoFar` below only sums pages THIS execution can
  // see, which post-sharding is one shard's slice (~8/45 pages), not the
  // whole fleet — divided accordingly so this log stays internally
  // consistent per shard. Telemetry only, same as before: logs a warning,
  // never blocks or alters this run's own results.
  const MIN_DAILY_POSTS_TARGET = opts.shardCount && opts.shardCount > 1 ? Math.ceil(250 / opts.shardCount) : 250;
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
        // ⛔ OPERATOR FIX (2026-08-31, real live incident): the flat 96h cap
        // applied even to single-athlete entity fan pages (e.g. p54 Conor
        // McGregor), whose whole premise is "the latest on this one person" —
        // a day-old story reads as stale there in a way a 4-day-old team
        // story doesn't. Entity pages now get a tighter 24h cap; general
        // pages tightened back 96h -> 72h (operator call, same session —
        // reverting most of the 2026-08-08 throughput widening now that the
        // actual stale-content path, sourceFromEsEvergreenArticles's faked
        // "now" timestamp, is handled explicitly via classifyCaptionAgeTone
        // instead of relying on a loose accuracy-gate window to catch it).
        const maxAgeHours = state.page.page_type === "entity" ? 24 : 72;
        const accuracy = await checkAccuracy(candidate, athleteNames[0] || null, maxAgeHours);
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
          // ⛔ OPERATOR FIX (2026-08-25, real live incident): confirmed live
          // as the single dominant failure reason before the MIN_GAP fix
          // (100+ occurrences in one cycle) — unlike every other gate here,
          // the MIN_GAP check is PAGE-LEVEL and time-based, not candidate-
          // specific: it fails identically for EVERY candidate on this page
          // until real wall-clock time passes, no matter which one is tried.
          // `continue`-ing just burns the rest of this page's pool (and,
          // across repair passes, fresh re-sourcing calls) on attempts that
          // are structurally doomed regardless of content — confirmed via
          // BELOW_RUN_FLOOR logs always showing repairPassesUsed at the max.
          // The entity/league caps just above stay per-candidate (a
          // DIFFERENT candidate about a less-saturated entity on the same
          // page can still legitimately pass), so only this specific reason
          // short-circuits the whole page for this run.
          if (frequency.reason?.startsWith("TOPIC_FREQUENCY_MIN_GAP")) return;
          continue;
        }
        const dominantNarrative = await checkDominantNarrative(primaryEntity, effectivePostedLog, state.page);
        if (!dominantNarrative.pass) {
          state.attemptFailures.push(`${candidate.key}:${dominantNarrative.reason}`);
          continue;
        }
        // ⛔ OPERATOR FIX (2026-08-24, real live incident, severe): catches
        // the SAME real-world event being posted twice by this SAME page
        // within ~48h under a different link/wording — see checks.ts's
        // duplicateStoryCheck for the full incident. Placed before caption
        // generation so a real duplicate never spends an LLM call writing a
        // caption for content that's about to be dropped anyway.
        const duplicateStory = await checkDuplicateStory(candidate, primaryEntity, effectivePostedLog);
        if (!duplicateStory.pass) {
          state.attemptFailures.push(`${candidate.key}:${duplicateStory.reason}`);
          continue;
        }
        // ⛔ OPERATOR RULE (2026-09-10, explicit operator directive): "no
        // stories related to player's personal lives on essentiallysports
        // media page" — see checks.ts's personalLifeContentCheck for the
        // page-scoping (p44 only, a free no-op for every other page) and
        // the actual AI judgment. Placed last among the free/cheap gates,
        // same reasoning as checkDuplicateStory's own placement comment
        // above: a candidate that's about to fail this never wastes the
        // caption/render pipeline's own AI calls first.
        const personalLife = await checkPersonalLifeContent(candidate, state.page);
        if (!personalLife.pass) {
          state.attemptFailures.push(`${candidate.key}:${personalLife.reason}`);
          continue;
        }

        const caption = await buildCaptionText(candidate, state.page, athleteNames);

        let cardUrl: string | null = null;
        let sourcePhotoUrl: string | null = null;
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
          sourcePhotoUrl = render.sourcePhotoUrl ?? null;
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
            sourcePhotoUrl,
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
  const anyPageBelowDailyMin = () =>
    states.some((s) => s.postedTodayCount < Math.min(MIN_POSTS_PER_PAGE_PER_DAY, s.cap) && s.postedThisRun < perRunCapFor(s.cap));

  let repairPass = 0;
  while (
    (totalPostedThisRun() < MIN_POSTS_PER_RUN || anyPageBelowDailyMin()) &&
    repairPass < MAX_REPAIR_PASSES &&
    !timeBudgetExceeded() &&
    !attemptBudgetExceeded()
  ) {
    repairPass++;
    // Pages still below their own daily minimum go FIRST — mapWithConcurrency
    // processes this array in order (bounded by PAGE_CONCURRENCY slots), so
    // this is what actually gives a structurally-slower page priority for a
    // concurrency slot instead of losing the race to faster pages every time.
    const eligible = states
      .filter((s) => s.postedThisRun < perRunCapFor(s.cap) && s.postedTodayCount < s.cap)
      .sort((a, b) => a.postedTodayCount - b.postedTodayCount);
    if (eligible.length === 0) break; // every remaining page is genuinely exhausted — nothing left to repair

    const postedBeforePass = totalPostedThisRun();
    await mapWithConcurrency(eligible, PAGE_CONCURRENCY, async (state) => {
      // Only the real, run-wide safety valves stop a DISPATCHED page from
      // getting its attempt — never the shard-wide MIN_POSTS_PER_RUN total,
      // which is what let a page that hasn't been tried yet get silently
      // skipped just because SOME OTHER page's success already hit the
      // shared floor. See the MIN_POSTS_PER_PAGE_PER_DAY comment above.
      if (timeBudgetExceeded() || attemptBudgetExceeded()) return;
      if (state.postedTodayCount >= Math.min(MIN_POSTS_PER_PAGE_PER_DAY, state.cap) && totalPostedThisRun() >= MIN_POSTS_PER_RUN) return;
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

    // ⛔ OPERATOR FIX (2026-09-08, real live incident): a repair pass that
    // adds zero new posts across EVERY eligible page is strong evidence
    // there's genuinely nothing more to find right now, not a transient
    // blip worth retrying — sourceCandidatePool's own web-search/evergreen
    // tiers make real, billed AI-gateway calls on every single invocation
    // regardless of whether anything usable comes back, so re-running the
    // SAME full sourcing pipeline for the SAME exhausted pages up to
    // MAX_REPAIR_PASSES (5) times, every hourly run, is pure repeated spend
    // with no chance of a different outcome. Confirmed live: 73 runs hit
    // repairPassesUsed:5 in well under a day right after the AI Gateway key
    // was fixed (it had been silently free while that key was broken) —
    // the exact same floor-chasing pattern the 2026-08-31 cost incident
    // diagnosed and flagged as needing this circuit-breaker, never built
    // until now. Same principle as this pipeline's own "don't force it"
    // rule for content relevance: a pass finding nothing is a correct
    // signal to stop, not a reason to try again hoping for luck.
    if (totalPostedThisRun() === postedBeforePass) break;
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
      const posted = await postToThreads(item.page, item.caption, item.cardUrl, item.finalLink, itemPostTime.toISOString(), item.sportGroup);

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
        source_photo_url: item.sourcePhotoUrl,
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
