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
import { fetchWithTimeout, isCircuitOpen, tripCircuit, createLimiter } from "./httpUtil";

const APIFY_BASE = "https://api.apify.com/v2/acts";

// ⛔ OPERATOR FIX (2026-09-04): "wire the twitter/reddit pipeline" — same
// microservice-first swap as webSearch.ts, via its new /social_search
// endpoint (twitterapi.io/redditapis.com — flat, no-minimum resellers,
// deliberately not Apify; see that endpoint's own module docstrings for the
// real ~$1,000/month reason Apify was rejected). Root cause this targets:
// Apify's real bill for this org runs far above its headline per-item price
// once platform/compute/storage overhead is counted, the same class of
// problem already fixed for web_search/evergreen_search this session.
//
// Deliberately NOT the same empty-falls-through-to-next-tier semantics as
// webSearch.ts's own swap: there, Claude's own internal convention already
// treated an empty result as "try the next provider," so falling through to
// Grok on empty just preserved existing behavior. Here, Apify is a genuinely
// different vendor with its own real per-call cost — falling through to it
// every time the cheap tier legitimately finds nothing would double-spend on
// most queries (most "is there real chatter about X" questions legitimately
// have nothing worth posting) and defeat much of the point of this swap.
// Apify only fires when the microservice is provably unreachable/
// unconfigured (every query in this tier returned null, not just empty) —
// see the reachable/microserviceDown handling in candidatesFromMicroservice
// below.
const WEB_SEARCH_MICROSERVICE_URL = process.env.WEB_SEARCH_MICROSERVICE_URL?.replace(/\/+$/, "");
const WEB_SEARCH_MICROSERVICE_API_KEY = process.env.WEB_SEARCH_MICROSERVICE_API_KEY;
const limitMicroserviceSocial = createLimiter(10);

interface MicroserviceResultItem {
  title?: string;
  url?: string;
  snippet?: string;
  published_at?: string | null;
  // Reddit's real post score, or a tweet's like count when the provider
  // reports one (best-effort on the Twitter side — see twitter_api.py's own
  // confidence note). None means "not reported," not zero — never treated as
  // passing the floor below.
  score?: number | null;
}

// Returns null on "couldn't get a real answer" (unconfigured, network error,
// non-2xx, bad shape) — distinct from a real, possibly-empty result array —
// so the caller can tell an outage apart from "asked successfully, nothing
// cleared the bar."
async function microserviceSocialSearch(
  platform: "twitter" | "reddit",
  query: string,
  count: number
): Promise<MicroserviceResultItem[] | null> {
  if (!WEB_SEARCH_MICROSERVICE_URL || !WEB_SEARCH_MICROSERVICE_API_KEY) return null;

  try {
    const res = await limitMicroserviceSocial(() =>
      fetchWithTimeout(
        `${WEB_SEARCH_MICROSERVICE_URL}/social_search`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": WEB_SEARCH_MICROSERVICE_API_KEY },
          body: JSON.stringify({ platform, query, count }),
        },
        20_000
      )
    );
    // 503 covers "this platform isn't configured server-side" — not a real failure.
    if (res.status === 503) return null;
    if (!res.ok) {
      console.error(`microserviceSocialSearch: HTTP ${res.status} for ${platform} "${query}"`);
      return null;
    }
    const data = (await res.json()) as { results?: MicroserviceResultItem[] };
    return Array.isArray(data.results) ? data.results : null;
  } catch (e) {
    console.error(`microserviceSocialSearch: failed for ${platform} "${query}": ${(e as Error).message}`);
    return null;
  }
}

/**
 * Shared candidate-builder for both platforms via the microservice. Returns
 * null when the tier is genuinely unreachable (every query failed/
 * unconfigured) so the caller falls through to Apify; returns a real
 * (possibly empty) array otherwise — see the module header for why empty
 * does NOT also trigger the Apify fallback here.
 */
async function candidatesFromMicroservice(
  platform: "twitter" | "reddit",
  queries: string[],
  minScore: number,
  dateISO: string
): Promise<Candidate[] | null> {
  const perQuery = await Promise.all(queries.map((q) => microserviceSocialSearch(platform, q, 8)));
  const reachable = perQuery.some((r) => r !== null);
  if (!reachable) return null;

  const items = perQuery.filter((r): r is MicroserviceResultItem[] => r !== null).flat();
  const candidates = items
    .filter((r) => r.title && r.url)
    // Same hard engagement floor as the Apify path below — a result with no
    // reported score is treated as failing it, never as passing.
    .filter((r) => (r.score ?? -1) >= minScore)
    .map((r): Candidate => ({
      source: "social_search",
      key: r.url!,
      subject: r.title!,
      headline: r.title!.slice(0, 200),
      link: r.url!,
      publishedAt: r.published_at || `${dateISO}T12:00:00Z`,
      rawText: r.snippet,
    }));

  return dedupeByKey(candidates);
}

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
  const queries = queryVariants(page);
  if (queries.length === 0) return [];

  const viaMicroservice = await candidatesFromMicroservice("twitter", queries, MIN_TWEET_LIKES, dateISO);
  if (viaMicroservice !== null) return viaMicroservice;

  const apiKey = process.env.APIFY_API_TOKEN;
  if (!apiKey || isCircuitOpen(APIFY_QUOTA_KEY)) return [];

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
  const queries = queryVariants(page);
  if (queries.length === 0) return [];

  const viaMicroservice = await candidatesFromMicroservice("reddit", queries, MIN_REDDIT_UPVOTES, dateISO);
  if (viaMicroservice !== null) return viaMicroservice;

  const apiKey = process.env.APIFY_API_TOKEN;
  if (!apiKey || isCircuitOpen(APIFY_QUOTA_KEY)) return [];

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
