// ⛔ OPERATOR FIX (2026-08-07): "add this Apify token for Reddit and Twitter
// scraping if more new stories are needed."
//
// ⛔ OPERATOR BROADENING (2026-08-10): "make Apify so broad that... nothing
// is ever short of things." Originally one narrow entity-scoped query with
// a same-sport fallback tried only when that came back empty. Now: build
// every real query variant this page supports (each registered entity's
// own name, each entity's individual keywords/nicknames, and a sport-only
// query), run them all in parallel, and merge+dedupe whatever real posts
// come back. A page with a specific fanbase (Dale Earnhardt Sr., Conor
// McGregor) can have real Reddit/Twitter chatter under a nickname
// ("Intimidator", "The Notorious") that a single "full name + sport" query
// misses entirely — this tier now searches every name it actually has
// registered, not just the primary one.

import { Candidate, PageConfig } from "./types";
import { fetchWithTimeout, isCircuitOpen, tripCircuit } from "./httpUtil";

const APIFY_BASE = "https://api.apify.com/v2/acts";

// ⛔ OPERATOR FIX (2026-08-30, real live incident): see httpUtil.ts's
// circuit-breaker comment. One shared key for both functions below — Twitter
// and Reddit share ONE Apify account/quota (confirmed live: identical
// "Monthly usage hard limit exceeded" 403 from both actors simultaneously),
// so a source-specific breaker would still let the other hammer a dead
// shared quota. 6 hours is a pragmatic middle ground for a MONTHLY limit:
// long enough to actually stop the wasted volume (no point re-checking every
// few minutes for something that won't reset for weeks), short enough that
// a same-day plan upgrade gets noticed well within a working day, and moot
// anyway on the next deploy/restart, which always clears this in-memory
// state for a fresh, cheap re-check.
const APIFY_QUOTA_KEY = "apify_social_search";
const APIFY_QUOTA_COOLDOWN_MS = 6 * 3600 * 1000;

function isHardQuotaError(message: string): boolean {
  return message.includes("platform-feature-disabled") || message.includes("Monthly usage hard limit exceeded");
}

// ⛔ OPERATOR FIX (2026-08-10, real live incident): a 16:00Z run stalled for
// 2+ hours and blocked every scheduled fire after it (SKIP overlap policy).
// Root cause confirmed via the live worker logs: Apify's Reddit-scraper
// actor was timing out ("status: TIMED-OUT") on ITS side, but `timeout=45`
// in the URL only tells APIFY when to give up on the actor run — it did
// NOTHING to our own `fetch()` call, which had no client-side abort/timeout
// at all. When Apify's response hung past that, our fetch just kept
// waiting indefinitely. Temporal's activity-level StartToClose timeout
// fired and told the workflow to retry, but that doesn't cancel the real
// in-flight promise still running in this Node process — so the worker sat
// there finishing zombie work for an already-abandoned attempt (confirmed
// by "invalid activityID... already timed out" errors when it finally tried
// to report completion), unable to make forward progress on the real retry
// or the next page. A real, enforced client-side timeout — independent of
// whatever Apify does on its end — is the actual fix; the crash-isolation
// try/catch added earlier this session only covers a call that ACTUALLY
// throws, not one that hangs forever.
// ⛔ OPERATOR FIX (2026-08-12, real live incident): "posts are way below the
// 13 floor" — live logs from the 2026-08-12 10:00Z run showed Apify's
// Reddit-scraper actor (`trudax~reddit-scraper-lite`) TIMED-OUT on nearly
// every page (p35-p61+), and the old 45s Apify budget + 30s local buffer
// meant EVERY affected page ate ~75s just waiting for this one tier to fail
// — before rendering even started, across dozens of pages, inside a fixed
// 20-minute run budget. Cut the ceiling hard: when this actor is genuinely
// degraded/down, failing fast matters far more than giving it more rope,
// since a healthy run returns in a few seconds either way.
// ⛔ OPERATOR FIX (2026-08-14, real live incident): confirmed live — the
// Apify quota exhaustion (403) that had been masking this got resolved, and
// the actor is now genuinely TIMED-OUT at 18s on a healthy run (isolated
// test: same query took ~25s at timeout=45, succeeded every time; failed
// every time at 18s). Restored to 45s — a currently-slow-but-healthy actor
// was being killed before it could ever return real results. If this actor
// degrades/hangs again like 2026-08-12, cut it back down; for now 18s cuts
// off every real result, not just degraded ones.
// ⛔ OPERATOR FIX (2026-08-15, real live incident): confirmed live again —
// 45s was ALSO now cutting off every real result (every sourceFromTwitter/
// sourceFromReddit call in a real run logged TIMED-OUT). Isolated test: the
// same query took ~55s at timeout=90, succeeding; failed at both 18s and
// 45s. Same class of platform-wide slowdown as tonight's Athena/AI-Gateway
// incidents, not a new code issue — raised again to what real calls
// actually need right now.
async function runActorSync<T>(actorId: string, input: Record<string, unknown>, apiKey: string, timeoutSecs = 90): Promise<T[]> {
  // Client-side ceiling set above Apify's own instructed timeout (not equal
  // to it) — this lets Apify's normal "ran out of time, here's a clean
  // TIMED-OUT error" response come back and hit the existing per-query
  // .catch() below the normal way, and only aborts locally if Apify itself
  // fails to honor its own timeout and the connection genuinely hangs.
  const res = await fetchWithTimeout(
    `${APIFY_BASE}/${actorId}/run-sync-get-dataset-items?token=${apiKey}&timeout=${timeoutSecs}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
    (timeoutSecs + 30) * 1000
  );
  if (!res.ok) throw new Error(`Apify ${actorId} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T[];
}

// ⛔ OPERATOR FIX (2026-08-12, real live incident, severe): TWO separate
// live posts traced to this tier in one day — a 2-view tweet ("woke mma
// fan"/"israeli communist", a random personal account, zero real content)
// and a 4-view tweet (a random personal account's unrelated gender/
// workplace argument, using "boxing" purely as a punch-someone idiom, not
// the sport). Both matched only via a bare sport-keyword text match with
// ZERO regard for whether the post had any real reach or came from
// anything resembling a real news source. "A tweet with less than 1,000
// likes should not be used as a source — it should come from a news
// account" (operator, verbatim). This tier had no engagement signal at
// all before this fix — every field below (likeCount, viewCount, author
// verification/followers, upVotes) now actually gets pulled from Apify's
// real output schema and enforced as a hard floor, not just requested at
// generation time and never checked.
interface TweetItem {
  type?: string;
  url: string;
  fullText?: string;
  text?: string;
  createdAt?: string;
  id: string;
  likeCount?: number;
  viewCount?: number;
  author?: { isVerified?: boolean; isBlueVerified?: boolean; followers?: number };
}

interface RedditPostItem {
  dataType?: string;
  id?: string;
  parsedId?: string;
  url?: string;
  title?: string;
  body?: string;
  communityName?: string;
  createdAt?: string;
  upVotes?: number;
}

// The exact bar the operator specified: real reach, not a random account's
// near-zero-view post. Applied as a hard floor, not a preference — a tweet
// below this is dropped before it's even eligible to become a candidate.
const MIN_TWEET_LIKES = 1000;
// No explicit number given for Reddit — this is a deliberately conservative
// equivalent (a real, community-recognized post, not a 1-2-upvote nobody
// post), picked to filter the same class of near-zero-engagement junk
// without requiring front-page-level virality every time.
const MIN_REDDIT_UPVOTES = 50;

// Every real, distinct query this page's own registered data supports —
// never more than 4 (bounds run latency: each is a real Apify actor call),
// but every one of the 4 is a genuinely different real name/nickname/sport
// term, not a repeat of the same string.
//
// ⛔ OPERATOR FIX (2026-08-23 audit): two structural bugs in the original
// version, both latent until Twitter/Reddit's external outages clear:
// (1) the top-priority query joined the first two entity NAMES into one
// string ("Conor McGregor Max Holloway MMA") — social search reads that as
// an AND of unrelated tokens and will structurally return few/no results
// for any 2+-entity page; (2) the broad, reliable sport-only fallback was
// pushed LAST and the final `.slice(0, 4)` cap filled in insertion order,
// so for any page with 3+ entities carrying distinct keywords the
// sport-only query never ran at all, and entities past the first ~3 never
// got their own query either. Reserves the sport-only slot first, then
// queries entity names individually instead of joined.
function queryVariants(page: PageConfig): string[] {
  const sport = page.sport_groups[0] || null;
  const variants: string[] = [];

  if (sport) variants.push(sport);

  for (const e of page.entities) {
    variants.push(sport ? `${e.name} ${sport}` : e.name);
  }

  // Individual keywords/nicknames ("Intimidator", "The Notorious") carry
  // real, distinct search value a page's full display name doesn't — a fan
  // subreddit/tweet is far more likely to use the nickname than the full
  // formal name.
  for (const e of page.entities) {
    for (const kw of e.keywords.slice(0, 1)) {
      if (kw && kw.toLowerCase() !== e.name.toLowerCase()) {
        variants.push(sport ? `${kw} ${sport}` : kw);
      }
    }
  }

  return [...new Set(variants)].slice(0, 4);
}

function dedupeByKey<C extends { key: string }>(candidates: C[]): C[] {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.key)) return false;
    seen.add(c.key);
    return true;
  });
}

export async function sourceFromTwitter(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  const apiKey = process.env.APIFY_API_TOKEN;
  const queries = queryVariants(page);
  if (!apiKey || queries.length === 0 || isCircuitOpen(APIFY_QUOTA_KEY)) return [];

  const toCandidates = (items: TweetItem[]): Candidate[] =>
    items
      .filter((t) => t.url && (t.fullText || t.text))
      // Hard engagement floor — see MIN_TWEET_LIKES comment above. A tweet
      // missing likeCount entirely (field absent/undefined) is treated as
      // failing the floor, not passing it — never assume real reach that
      // isn't actually reported.
      .filter((t) => (t.likeCount ?? 0) >= MIN_TWEET_LIKES)
      .map((t): Candidate => ({
        source: "social_search",
        key: t.id || t.url,
        subject: t.fullText || t.text || "",
        headline: (t.fullText || t.text || "").slice(0, 200),
        link: t.url,
        publishedAt: t.createdAt ? new Date(t.createdAt).toISOString() : `${dateISO}T12:00:00Z`,
        rawText: t.fullText || t.text,
      }));

  const perQuery = await Promise.all(
    queries.map((query) =>
      // Sort "Top" (engagement-ranked), not "Latest" — fetching by recency
      // then filtering by likes on our side meant most of every call was
      // wasted on near-zero-engagement posts that were always going to be
      // dropped; sourcing real, already-substantial posts directly is both
      // cheaper and yields more real candidates per call.
      runActorSync<TweetItem>("apidojo~tweet-scraper", { searchTerms: [query], maxItems: 8, sort: "Top" }, apiKey).catch((e) => {
        const message = (e as Error).message;
        if (isHardQuotaError(message)) tripCircuit(APIFY_QUOTA_KEY, APIFY_QUOTA_COOLDOWN_MS, `sourceFromTwitter: ${message}`);
        console.error(`sourceFromTwitter: query "${query}" failed for ${page.page_id}: ${message}`);
        return [] as TweetItem[];
      })
    )
  );
  return dedupeByKey(toCandidates(perQuery.flat()));
}

export async function sourceFromReddit(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  const apiKey = process.env.APIFY_API_TOKEN;
  const queries = queryVariants(page);
  if (!apiKey || queries.length === 0 || isCircuitOpen(APIFY_QUOTA_KEY)) return [];

  const toCandidates = (items: RedditPostItem[]): Candidate[] =>
    items
      .filter((r) => r.title && r.communityName && r.url) // drop subreddit/community metadata rows, keep real posts only
      // Hard engagement floor — see MIN_REDDIT_UPVOTES comment above.
      .filter((r) => (r.upVotes ?? 0) >= MIN_REDDIT_UPVOTES)
      .map((r): Candidate => ({
        source: "social_search",
        key: r.parsedId || r.id || r.url!,
        subject: r.title!,
        headline: r.title!,
        link: r.url!,
        publishedAt: r.createdAt ? new Date(r.createdAt).toISOString() : `${dateISO}T12:00:00Z`,
        rawText: r.body?.slice(0, 500),
      }));

  const perQuery = await Promise.all(
    queries.map((query) =>
      // Sort "top", not "new" — same reasoning as the Twitter tier: source
      // real, already-substantial posts directly instead of fetching brand
      // new (near-zero-engagement) ones and filtering them out after.
      runActorSync<RedditPostItem>(
        "trudax~reddit-scraper-lite",
        { searches: [query], maxItems: 8, sort: "top", type: "posts" },
        apiKey
      ).catch((e) => {
        const message = (e as Error).message;
        if (isHardQuotaError(message)) tripCircuit(APIFY_QUOTA_KEY, APIFY_QUOTA_COOLDOWN_MS, `sourceFromReddit: ${message}`);
        console.error(`sourceFromReddit: query "${query}" failed for ${page.page_id}: ${message}`);
        return [] as RedditPostItem[];
      })
    )
  );
  return dedupeByKey(toCandidates(perQuery.flat()));
}
