// ⛔ OPERATOR FIX (2026-09-04): "remove apify also as fallback, cos there are
// already 3-4 sources so a fallback source isnt needed clearly, cos apify
// costing is too high." Apify was already demoted to a same-day fallback
// earlier today (2026-09-04, microservice-first swap); this removes it
// entirely — a deliberate decision, not an oversight. Reasoning: Twitter/
// Reddit was always this pipeline's last-resort tier (sourcing.ts only
// invokes it when es_article/beehiiv/newsletter/evergreen combined don't
// clear MIN_SAFE_CANDIDATES), so a page never depended on it alone; losing
// it during a rare microservice outage costs availability on an already-
// optional tier, not quality — the engagement floor below still applies
// unconditionally to whatever this tier does return. Keeping Apify wired in
// "just in case" would mean the one thing this fix is explicitly for (never
// spending Apify's real per-item cost again) stays one bad day away from
// happening anyway. If the microservice is unreachable, these two functions
// now simply return no candidates for this tier — see candidatesFromMicroservice.
//
// ⛔ OPERATOR BROADENING (2026-08-10, historical): "make [sourcing] so broad
// that... nothing is ever short of things." Build every real query variant
// this page supports (each registered entity's own name, each entity's
// individual keywords/nicknames, and a sport-only query), run them all in
// parallel, and merge+dedupe whatever real posts come back. A page with a
// specific fanbase (Dale Earnhardt Sr., Conor McGregor) can have real
// Reddit/Twitter chatter under a nickname ("Intimidator", "The Notorious")
// that a single "full name + sport" query misses entirely — this tier
// searches every name it actually has registered, not just the primary one.

import { Candidate, PageConfig } from "./types";
import { fetchWithTimeout, createLimiter } from "./httpUtil";

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
// non-2xx, bad shape) — distinct from a real, possibly-empty result array.
// Both ultimately produce no candidates for this tier (see
// candidatesFromMicroservice), but the distinction is kept for the
// console.error paths below: it's the difference between "this tier is
// broken" and "this tier legitimately found nothing," which matters when
// reading logs later.
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
 * Shared candidate-builder for both platforms via the microservice — the
 * ONLY source for this tier now that Apify is removed (see module header).
 * A microservice outage means this tier returns no candidates for the run;
 * every other sourcing tier (es_article, beehiiv, newsletter, evergreen,
 * web_search) is unaffected, which is the whole basis for that decision.
 */
async function candidatesFromMicroservice(
  platform: "twitter" | "reddit",
  queries: string[],
  minScore: number,
  dateISO: string
): Promise<Candidate[]> {
  const perQuery = await Promise.all(queries.map((q) => microserviceSocialSearch(platform, q, 8)));
  const items = perQuery.filter((r): r is MicroserviceResultItem[] => r !== null).flat();

  const candidates = items
    .filter((r) => r.title && r.url)
    // Hard engagement floor — same bar this tier has always enforced (see
    // MIN_TWEET_LIKES/MIN_REDDIT_UPVOTES below). A result with no reported
    // score is treated as failing it, never as passing.
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

// ⛔ OPERATOR FIX (2026-08-12, real live incident, severe, historical — the
// reasoning still governs the score gate above even though Apify's own
// output schema no longer applies): TWO separate live posts traced to this
// tier in one day — a 2-view tweet ("woke mma fan"/"israeli communist", a
// random personal account, zero real content) and a 4-view tweet (a random
// personal account's unrelated gender/workplace argument, using "boxing"
// purely as a punch-someone idiom, not the sport). Both matched only via a
// bare sport-keyword text match with ZERO regard for whether the post had
// any real reach or came from anything resembling a real news source. "A
// tweet with less than 1,000 likes should not be used as a source — it
// should come from a news account" (operator, verbatim).

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
// never more than 4 (bounds run latency: each is a real microservice call),
// but every one of the 4 is a genuinely different real name/nickname/sport
// term, not a repeat of the same string.
//
// ⛔ OPERATOR FIX (2026-08-23 audit): two structural bugs in the original
// version: (1) the top-priority query joined the first two entity NAMES
// into one string ("Conor McGregor Max Holloway MMA") — social search reads
// that as an AND of unrelated tokens and will structurally return few/no
// results for any 2+-entity page; (2) the broad, reliable sport-only
// fallback was pushed LAST and the final `.slice(0, 4)` cap filled in
// insertion order, so for any page with 3+ entities carrying distinct
// keywords the sport-only query never ran at all, and entities past the
// first ~3 never got their own query either. Reserves the sport-only slot
// first, then queries entity names individually instead of joined.
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
  return candidatesFromMicroservice("twitter", queries, MIN_TWEET_LIKES, dateISO);
}

export async function sourceFromReddit(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  const queries = queryVariants(page);
  if (queries.length === 0) return [];
  return candidatesFromMicroservice("reddit", queries, MIN_REDDIT_UPVOTES, dateISO);
}
