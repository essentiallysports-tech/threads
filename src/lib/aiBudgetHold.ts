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
import { dailyBudgetFractionUsed } from "./aiGatewayBudget";
import { PageConfig, PostedLogEntry } from "./types";
import { isGapDue } from "./checks";

const PRIORITY_RESERVE_FRACTION = Number(process.env.AI_GATEWAY_PRIORITY_RESERVE_FRACTION || 0.7);
const MIN_POSTS_BEFORE_HOLD = 3;
// (2026-10-02, operator rule — see ThreadsConfig.min_post_gap_hours) the last
// 10% of the day's budget is kept for gap-guarded pages that are due, so the
// "never 6h without a post" guarantee doesn't run out of AI late in the day.
const GAP_RESERVE_FRACTION = Number(process.env.AI_GATEWAY_GAP_RESERVE_FRACTION || 0.9);

export async function aiBudgetHoldReason(page: PageConfig, postedLog: PostedLogEntry[]): Promise<string | null> {
  const used = await dailyBudgetFractionUsed();
  if (used >= 1) return "AI_BUDGET_EXHAUSTED_HOLD";
  if (used >= GAP_RESERVE_FRACTION && !isGapDue(page, postedLog)) return "AI_BUDGET_RESERVED_FOR_DUE_PAGES";
  if (used < PRIORITY_RESERVE_FRACTION || page.threads?.ai_priority) return null;
  const today = new Date().toISOString().slice(0, 10);
  const postedToday = postedLog.filter((e) => e.posted_at?.startsWith(today)).length;
  return postedToday >= MIN_POSTS_BEFORE_HOLD ? "AI_BUDGET_RESERVED_FOR_PRIORITY_PAGES" : null;
}
