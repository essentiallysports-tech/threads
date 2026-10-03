// ⛔ OPERATOR DECISION (2026-09-30): the AI-gateway cap was being crossed
// every day (Sep 25 13:07, Sep 26 22:09, Sep 27 17:06, Sep 28 20:04, Sep 29
// 17:10 UTC) and every AI check fails open after that — templated
// "This is bigger than it looks 👀" captions, un-QC'd photos and headlines.
// Sep 25-29: 131 such posts (32 of them on the top pages, mostly US
// afternoon/evening), best one 3,185 views; <1% of all views. Meanwhile 8
// pages earned ~97% of GA4 Threads sessions while the other ~33 spent most
// of the budget. Two rules, both activity-side (no workflow change):
//
//   1. Once PRIORITY_RESERVE_FRACTION of the day's budget is spent, a page
//      without threads.ai_priority holds for the rest of the UTC day, but
//      only after its 3rd post today (the operator's 3-posts/24h floor).
//   2. Once the budget is fully spent, every page holds — nothing posts in
//      the degraded, fail-open mode.
//
// A hold is NOT a render failure: nothing is recorded against the
// candidate, so it's still in tomorrow's pool.
import { dailyBudgetFractionUsed, dailyBudgetUsd } from "./aiGatewayBudget";
import { PageConfig, PostedLogEntry } from "./types";
import { isGapDue, hoursSinceLastPost } from "./checks";

const PRIORITY_RESERVE_FRACTION = Number(process.env.AI_GATEWAY_PRIORITY_RESERVE_FRACTION || 0.7);
const MIN_POSTS_BEFORE_HOLD = 3;

// ⛔ OPERATOR DECISION (2026-10-03): a 150k-click target for Sep 7 - Oct 8 (102k
// on Oct 3), with the daily AI cap kept at $10. The top pages earn the clicks
// (GA4 autopost sessions per post, last 7 days: Eala 854, Detroit 75, Dallas 39,
// Golf 33, Daytona 19; every other page under 8, most under 3), so until the
// sprint ends a page without threads.ai_priority holds after its 3rd post of
// the day from the START of the day, not only once 70% of the budget is gone —
// the AI budget goes to the pages that convert. Ends on its own at SPRINT_END.
export const SPRINT_END_MS = Date.parse("2026-10-09T00:00:00Z");
export function clickSprintActive(nowMs = Date.now()): boolean {
  return nowMs < SPRINT_END_MS;
}
// (2026-10-02, operator rule — see ThreadsConfig.min_post_gap_hours) part of
// the day's budget is kept for gap-guarded pages that are due, so the "never
// 6h without a post" guarantee doesn't run out of AI late in the day. The
// reserve is sized to the hours LEFT in the UTC day, not a fixed last 10%:
// the ten guarded pages need about one post each per 4.5h, at roughly
// $0.10-0.15 of AI per post, so ~$0.25 an hour — a fixed $1 reached at a
// mid-afternoon $9 (Oct 2 was at $6.84 by 12:08 UTC) can't carry them to
// midnight. Inside the reserve, due pages post as before, priority pages
// keep posting but at most every PRIORITY_RESERVE_MIN_GAP_HOURS (so the top
// pages don't go quiet in the US afternoon/evening), and every other page
// holds. Still capped at the daily budget: nothing here spends past it.
const GAP_RESERVE_USD_PER_HOUR = Number(process.env.AI_GATEWAY_GAP_RESERVE_USD_PER_HOUR || 0.25);
const GAP_RESERVE_MIN_FRACTION = 0.1;
const GAP_RESERVE_MAX_FRACTION = 0.35;
const PRIORITY_RESERVE_MIN_GAP_HOURS = 2;

export function gapReserveFraction(nowMs = Date.now(), capUsd = dailyBudgetUsd()): number {
  const d = new Date(nowMs);
  const hoursLeft = 24 - (d.getUTCHours() + d.getUTCMinutes() / 60);
  const fraction = (GAP_RESERVE_USD_PER_HOUR * hoursLeft) / capUsd;
  return Math.min(GAP_RESERVE_MAX_FRACTION, Math.max(GAP_RESERVE_MIN_FRACTION, fraction));
}

export async function aiBudgetHoldReason(page: PageConfig, postedLog: PostedLogEntry[], nowMs = Date.now()): Promise<string | null> {
  const used = await dailyBudgetFractionUsed();
  if (used >= 1) return "AI_BUDGET_EXHAUSTED_HOLD";
  if (used >= 1 - gapReserveFraction(nowMs) && !isGapDue(page, postedLog, nowMs)) {
    const priorityMayPost = !!page.threads?.ai_priority && hoursSinceLastPost(postedLog, nowMs) >= PRIORITY_RESERVE_MIN_GAP_HOURS;
    if (!priorityMayPost) return "AI_BUDGET_RESERVED_FOR_DUE_PAGES";
  }
  if (page.threads?.ai_priority) return null;
  if (used < PRIORITY_RESERVE_FRACTION && !clickSprintActive(nowMs)) return null;
  const today = new Date().toISOString().slice(0, 10);
  const postedToday = postedLog.filter((e) => e.posted_at?.startsWith(today)).length;
  if (postedToday < MIN_POSTS_BEFORE_HOLD) return null;
  return used < PRIORITY_RESERVE_FRACTION ? "CLICK_SPRINT_BUDGET_FOR_TOP_PAGES" : "AI_BUDGET_RESERVED_FOR_PRIORITY_PAGES";
}
