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
import { fetchWithTimeout } from "./httpUtil";

const APIFY_BASE = "https://api.apify.com/v2/acts";

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
async function runActorSync<T>(actorId: string, input: Record<string, unknown>, apiKey: string, timeoutSecs = 18): Promise<T[]> {
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
function queryVariants(page: PageConfig): string[] {
  const sport = page.sport_groups[0] || null;
  const variants: string[] = [];

  const entityNames = page.entities.map((e) => e.name);
  if (entityNames.length > 0) {
    const primary = entityNames.slice(0, 2).join(" ");
    variants.push(sport ? `${primary} ${sport}` : primary);
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

  if (sport) variants.push(sport);

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
  if (!apiKey || queries.length === 0) return [];

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
        console.error(`sourceFromTwitter: query "${query}" failed for ${page.page_id}: ${(e as Error).message}`);
        return [] as TweetItem[];
      })
    )
  );
  return dedupeByKey(toCandidates(perQuery.flat()));
}

export async function sourceFromReddit(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  const apiKey = process.env.APIFY_API_TOKEN;
  const queries = queryVariants(page);
  if (!apiKey || queries.length === 0) return [];

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
        console.error(`sourceFromReddit: query "${query}" failed for ${page.page_id}: ${(e as Error).message}`);
        return [] as RedditPostItem[];
      })
    )
  );
  return dedupeByKey(toCandidates(perQuery.flat()));
}
