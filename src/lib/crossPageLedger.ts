// ⛔ OPERATOR FIX (2026-09-24, real live incident, severe): every
// repetition gate in this pipeline was per-page only. Nothing stopped two
// DIFFERENT pages from posting the same ES article link minutes apart —
// and because each hourly shard only sees its own slice of pages, the
// run-level mass-duplicate breaker in dailyRunWorkflow.ts can never see a
// collision between pages in different shards either. Confirmed live on
// 2026-09-22/23: five NASCAR pages registered with near-identical configs
// (p91-p95, one per shard) posted the same article on all five accounts
// within ~8 minutes, then again an hour later — e.g. one Ryan Blaney story
// went out 10 times in 68 minutes. Cross-page duplicate posts doubled
// (~45/day -> ~96/day) and fleet-wide Threads impressions and GA4 clicks
// fell ~80-90% the same day.
//
// All six shards' activities run inside the one es-threads-worker process,
// so a module-level map IS shared across shards. Seeded once per process
// from every active page's posted log (firehose pages are excluded by
// loadActiveThreadsPages, so p80's post-everything feed never blocks
// anyone), then kept current by claimArticle() at the moment a post is
// actually scheduled. claimArticle's check-then-record has no await in
// between, so it's atomic within the process — two pages can't both pass.

import { loadActiveThreadsPages, getPostedLog } from "./s3registry";

const WINDOW_MS = 24 * 3600 * 1000;
// Same article on a second page is allowed (real overlap exists, e.g. a Big
// Ten story on both Michigan and Ohio State pages), but never within 3
// hours of another page, and never on a third page within 24h.
const MIN_SPACING_MS = 3 * 3600 * 1000;
const MAX_PAGES_PER_ARTICLE_24H = 2;

interface LedgerEntry {
  pageId: string;
  at: number;
}

const ledger = new Map<string, LedgerEntry[]>();
let seeding: Promise<void> | null = null;

const ES_ARTICLE_URL_RE = /https?:\/\/(?:www\.)?essentiallysports\.com\/[^\s"'<>?#]+/i;

export function articleKey(urlOrHtml: string | null | undefined): string | null {
  const m = (urlOrHtml || "").match(ES_ARTICLE_URL_RE);
  return m ? m[0].replace(/\/+$/, "").toLowerCase() : null;
}

function record(key: string, pageId: string, at: number): void {
  const entries = (ledger.get(key) || []).filter((e) => at - e.at < WINDOW_MS);
  entries.push({ pageId, at });
  ledger.set(key, entries);
}

// Idempotent and non-fatal: a failed seed just leaves the ledger empty (the
// same per-page-only behavior this pipeline had before) and retries on the
// next call, rather than blocking sourcing for every page.
export function ensureCrossPageLedgerSeeded(): Promise<void> {
  if (!seeding) {
    seeding = (async () => {
      const pages = await loadActiveThreadsPages();
      const logs = await Promise.all(pages.map(async (p) => ({ pageId: p.page_id, log: await getPostedLog(p.page_id) })));
      const cutoff = Date.now() - WINDOW_MS;
      let seeded = 0;
      for (const { pageId, log } of logs) {
        for (const e of log) {
          const key = articleKey(e.reply_url);
          const at = e.posted_at ? Date.parse(e.posted_at) : NaN;
          if (key && at > cutoff) {
            record(key, pageId, at);
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
export function crossPageConflict(urlOrHtml: string | null | undefined, pageId: string, now = Date.now()): string | null {
  const key = articleKey(urlOrHtml);
  if (!key) return null;
  const others = (ledger.get(key) || []).filter((e) => e.pageId !== pageId && now - e.at < WINDOW_MS);
  if (others.length === 0) return null;
  const tooClose = others.find((e) => now - e.at < MIN_SPACING_MS);
  if (tooClose) return `CROSS_PAGE_DUPLICATE_3H:${tooClose.pageId}`;
  const distinctPages = new Set(others.map((e) => e.pageId));
  if (distinctPages.size >= MAX_PAGES_PER_ARTICLE_24H) return `CROSS_PAGE_DUPLICATE_24H:${[...distinctPages].join(",")}`;
  return null;
}

// Check-and-record in one synchronous step, called right before the post is
// actually scheduled. Returns the conflict reason (and records nothing) if
// another page already has this article.
export function claimArticle(urlOrHtml: string | null | undefined, pageId: string, at = Date.now()): string | null {
  const conflict = crossPageConflict(urlOrHtml, pageId, at);
  if (conflict) return conflict;
  const key = articleKey(urlOrHtml);
  if (key) record(key, pageId, at);
  return null;
}

// Undo a claim whose post then failed to schedule, so the article isn't
// blocked for other pages by a post that never went out.
export function releaseArticle(urlOrHtml: string | null | undefined, pageId: string, at: number): void {
  const key = articleKey(urlOrHtml);
  if (!key) return;
  const entries = (ledger.get(key) || []).filter((e) => !(e.pageId === pageId && e.at === at));
  if (entries.length) ledger.set(key, entries);
  else ledger.delete(key);
}
