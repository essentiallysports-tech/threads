// ⛔ OPERATOR FIX (2026-09-24, real live incident, severe): every
// repetition gate in this pipeline was per-page only, and each hourly shard
// only sees its own slice of pages. Confirmed live on 2026-09-22/23: five
// NASCAR pages registered with near-identical configs (p91-p95, one per
// shard) posted the same article on all five accounts within ~8 minutes,
// then again an hour later — one Ryan Blaney story went out 10 times in 68
// minutes. Cross-page duplicate posts doubled (~45/day -> ~96/day) and
// fleet-wide Threads impressions and GA4 clicks fell ~80-90% the same day.
//
// ⛔ CORRECTION (2026-09-25): the first version capped EVERY page (at most 2
// pages per article per 24h, 3h apart). That also blocked established pages
// from articles a new page had grabbed first in an earlier shard, starving
// them of article links. The rule now applies only to pages flagged
// threads.exclusive_articles: such a page takes only articles no other page
// has posted in the last 24h. Unflagged pages behave exactly as before this
// ledger existed (the 2026-08-07 operator call that two pages covering the
// same real story is normal editorial overlap) — their posts are recorded
// here, but they're never blocked.
//
// All six shards' activities run inside the one es-threads-worker process,
// so this module-level map IS shared across shards. Seeded once per process
// from every active page's posted log (firehose pages are excluded by
// loadActiveThreadsPages), then kept current by claimArticle() at the
// moment a post is actually scheduled. claimArticle's check-then-record has
// no await in between, so it's atomic within the process.
//
// (2026-09-30) The 24h lookback is now per page: threads.exclusive_window_hours
// (see types.ts) narrows it for pages that share a thin supply. The ledger
// itself still keeps 24h of claims, the most any page can ask for.
//
// (2026-10-16, operator decision) every page is exclusive by default
// (threads.exclusive_articles: false opts out): across Sep 7-Oct 15, 16-31%
// of posts shared an article with another of our accounts within 24h (31% the
// week of the Sep 22 clone launch), the pattern of a coordinated network. To
// avoid the 2026-09-25 starvation, a top page (threads.ai_priority) is refused
// only by another top page's claim — a smaller page that posted the story
// first never blocks it.

import { loadActiveThreadsPages, getPostedLog } from "./s3registry";
import { PageConfig } from "./types";

const WINDOW_MS = 24 * 3600 * 1000;

function windowHoursFor(page: PageConfig): number {
  const h = page.threads?.exclusive_window_hours;
  return typeof h === "number" && h > 0 ? Math.min(h, 24) : 24;
}

interface LedgerEntry {
  pageId: string;
  at: number;
  priority: boolean;
}

function isExclusive(page: PageConfig): boolean {
  return page.threads?.exclusive_articles !== false;
}

function isPriority(page: PageConfig): boolean {
  return page.threads?.ai_priority === true;
}

const ledger = new Map<string, LedgerEntry[]>();
let seeding: Promise<void> | null = null;

const ES_ARTICLE_URL_RE = /https?:\/\/(?:www\.)?essentiallysports\.com\/[^\s"'<>?#]+/i;

export function articleKey(urlOrHtml: string | null | undefined): string | null {
  const m = (urlOrHtml || "").match(ES_ARTICLE_URL_RE);
  return m ? m[0].replace(/\/+$/, "").toLowerCase() : null;
}

function record(key: string, pageId: string, at: number, priority: boolean): void {
  const entries = (ledger.get(key) || []).filter((e) => at - e.at < WINDOW_MS);
  entries.push({ pageId, at, priority });
  ledger.set(key, entries);
}

// Idempotent and non-fatal: a failed seed leaves the ledger empty and
// retries on the next call, rather than blocking sourcing for every page.
export function ensureCrossPageLedgerSeeded(): Promise<void> {
  if (!seeding) {
    seeding = (async () => {
      const pages = await loadActiveThreadsPages();
      const logs = await Promise.all(pages.map(async (p) => ({ pageId: p.page_id, priority: isPriority(p), log: await getPostedLog(p.page_id) })));
      const cutoff = Date.now() - WINDOW_MS;
      let seeded = 0;
      for (const { pageId, priority, log } of logs) {
        for (const e of log) {
          const key = articleKey(e.reply_url);
          const at = e.posted_at ? Date.parse(e.posted_at) : NaN;
          if (key && at > cutoff) {
            record(key, pageId, at, priority);
            seeded++;
          }
        }
      }
      console.error(`crossPageLedger: seeded ${seeded} posts from ${pages.length} active pages`);
    })().catch((e) => {
      seeding = null;
      console.error(`crossPageLedger: seed failed, cross-page dedup inactive until next attempt: ${(e as Error).message}`);
    });
  }
  return seeding;
}

// Read-only check — used early (checkCandidate) so a doomed candidate is
// dropped before it's rendered. Same page never conflicts with itself;
// same-page repeats are runDeterministicChecks' job.
export function crossPageConflict(urlOrHtml: string | null | undefined, page: PageConfig, now = Date.now()): string | null {
  if (!isExclusive(page)) return null;
  const key = articleKey(urlOrHtml);
  if (!key) return null;
  const hours = windowHoursFor(page);
  const priority = isPriority(page);
  const other = (ledger.get(key) || []).find(
    (e) => e.pageId !== page.page_id && now - e.at < hours * 3600 * 1000 && (!priority || e.priority)
  );
  return other ? `CROSS_PAGE_EXCLUSIVE_${hours}H:${other.pageId}` : null;
}

// Check-and-record in one synchronous step, called right before the post is
// actually scheduled. Every page's post is recorded; a page with
// exclusive_articles: false is never refused.
export function claimArticle(urlOrHtml: string | null | undefined, page: PageConfig, at = Date.now()): string | null {
  const conflict = crossPageConflict(urlOrHtml, page, at);
  if (conflict) return conflict;
  const key = articleKey(urlOrHtml);
  if (key) record(key, page.page_id, at, isPriority(page));
  return null;
}

// Undo a claim whose post then failed to schedule.
export function releaseArticle(urlOrHtml: string | null | undefined, pageId: string, at: number): void {
  const key = articleKey(urlOrHtml);
  if (!key) return;
  const entries = (ledger.get(key) || []).filter((e) => !(e.pageId === pageId && e.at === at));
  if (entries.length) ledger.set(key, entries);
  else ledger.delete(key);
}
