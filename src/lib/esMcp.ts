// Direct REST access to ES-MCP's search_images tool — bypasses MCP/OAuth
// entirely. Confirmed live (2026-08-06) by reading essentiallysports-tech/
// es-mcp's own source (tools/search-images.ts, app/[transport]/route.ts):
// the server accepts a static bearer token (MCP_AUTH_TOKEN) obtained via its
// own self-serve /api/access endpoint (a soft domain-gated email check, no
// OTP loop), and the JSON-RPC tool-call response always embeds each image's
// real full-resolution URL in a predictable text line: "Full-resolution URL
// (use this — the inline preview is a low-res thumbnail): <url>". Regex-
// parsing that line is more robust than depending on the exact wording
// around it, which is UI copy the ES-MCP team could tweak.

import { fetchWithTimeout, createLimiter } from "./httpUtil";

const MCP_URL = "https://mcp.essentiallysports.com/mcp";
const URL_LINE_RE = /Full-resolution URL[^:]*:\s*(\S+)/;

// ⛔ OPERATOR FIX (2026-08-29, real live incident): see httpUtil.ts's
// createLimiter comment for the full incident. This value is a conservative
// starting point, not a measured ES-MCP capacity figure (no published limit
// exists for this internal endpoint) — chosen because the 2026-08-23 incident
// confirmed ~162 simultaneous calls broke it, and this worker easily handled
// normal day-to-day load (spread across the day, no mass-catchup) well
// before that. Bounding in-process concurrency to single digits leaves real
// throughput while queuing the burst instead of firing it all at once.
const limitEsMcp = createLimiter(6);

export interface EsImageResult {
  url: string;
  title: string;
  caption?: string;
  credit?: string;
}

// ⛔ OPERATOR FIX (2026-08-23, real live incident): confirmed live — after
// today's fixes removed an artificial 5-entity cap on evergreen-article
// queries (real coverage gap, e.g. Golf Syndicate's other 10 entities), the
// real concurrent call volume against this ONE shared, static-bearer-token
// endpoint jumped substantially (up to ~27 pages × PAGE_CONCURRENCY=6
// simultaneous, each now firing a query per registered entity instead of a
// capped 5). Real logs immediately showed dozens of "This operation was
// aborted" (30s timeout) failures across nearly every page's ES-article
// tier — the single highest-trust, most real content source in the whole
// pipeline going silent under its own increased load, with zero retry to
// recover a call that just happened to be unlucky. One retry with a short
// backoff (same pattern as checks.ts's fetchWithRetry) costs at most a few
// seconds per call and directly targets a transient-load failure without
// reopening the coverage gap the entity-cap removal fixed.
async function callTool(name: string, args: Record<string, unknown>, attempts = 2): Promise<string[]> {
  const token = process.env.ES_MCP_BEARER_TOKEN;
  if (!token) throw new Error("ES_MCP_BEARER_TOKEN is not set");

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await limitEsMcp(() => fetchWithTimeout(
        MCP_URL,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        },
        // Bumped from a fixed 30s: real logs show these calls now genuinely
        // slower under the increased concurrent load (not just occasionally
        // flaking), so more patience per call matters more than firing
        // another request at an already-strained endpoint.
        45_000
      ));
      if (!res.ok) throw new Error(`ES-MCP ${name} -> ${res.status}: ${await res.text()}`);

      const raw = await res.text();
      const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) throw new Error(`ES-MCP ${name}: no data line in response: ${raw.slice(0, 300)}`);
      const parsed = JSON.parse(dataLine.slice(6));
      if (parsed.error) throw new Error(`ES-MCP ${name} error: ${JSON.stringify(parsed.error)}`);
      const content = parsed.result?.content as Array<{ type: string; text?: string }> | undefined;
      return (content || []).filter((c) => c.type === "text").map((c) => c.text || "");
    } catch (e) {
      lastError = e;
      // Longer backoff than the checks.ts pattern this mirrors (1s) — that
      // one retries against independent third-party URLs; this hits the
      // SAME shared, currently-loaded endpoint, so giving load a real chance
      // to clear before retrying matters more than retrying fast.
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastError;
}

function parseResult(metaText: string): EsImageResult | null {
  const urlMatch = metaText.match(URL_LINE_RE);
  if (!urlMatch) return null;
  const titleMatch = metaText.match(/^\*\*(.+?)\*\*/);
  const captionMatch = metaText.match(/^Caption:\s*(.+)$/m);
  const creditMatch = metaText.match(/^Credit:\s*(.+)$/m);
  return {
    url: urlMatch[1],
    title: titleMatch?.[1] || "",
    caption: captionMatch?.[1],
    credit: creditMatch?.[1],
  };
}

// Searches ES's media library. Returns up to `count` results, ranked as
// ES-MCP ranks them (relevance then recency) — does NOT verify each URL is
// actually reachable (see searchOneImage, which does).
export async function searchImages(query: string, type: "agency" | "custom" | "all" = "agency", count = 5): Promise<EsImageResult[]> {
  const texts = await callTool("search_images", { query, per_page: count, type });
  return texts.map(parseResult).filter((r): r is EsImageResult => r !== null);
}

// ⛔ OPERATOR FIX (2026-08-11, real live incident): a Curt Cignetti photo was
// used on a Stephanie White post (and another mismatched image on a
// separate post) — confirmed live via a screenshot. pickPhoto/cropForCard
// (cloudinary.ts) deliberately trust ES-MCP's own relevance ranking for
// "is this the right subject" (see that file's 2026-08-06 revert comment —
// face-detection can't tell WHICH face is the athlete), but nothing
// anywhere ever cross-checks the search hit's OWN title/caption text
// against the name we searched for. That's the real gap: ES-MCP's ranking
// can and did return an unrelated person's photo, and no downstream step
// catches it. This is a cheap, additional safety net — not a replacement
// for ES-MCP's ranking, which still fully decides ORDER among results that
// pass this filter.
//
// A candidate is rejected only when its title/caption has REAL, checkable
// text that mentions a specific different context and contains none of the
// searched name's tokens — generic/boilerplate credit lines ("Getty
// Images", empty title) are waved through since there's nothing to verify
// against, and rejecting those would starve real photos of comparably
// terse metadata (a known, common case, not a bug).
const GENERIC_METADATA_RE = /^(getty images?|action images?|icon sportswire|imagn|reuters|ap photo|usa today|zuma press)$/i;
const STOPWORD_TOKENS = new Set(["the", "and", "of", "for", "vs", "news"]);

// ⛔ OPERATOR FIX (2026-08-25, real live incident): confirmed live via a
// swept audit of render failures — 622 wasted render attempts in one
// window, heavily concentrated on multi-entity hub pages (MLB Newsroom,
// NBA Newsroom: 8 different athletes/teams each) and even single-entity
// pages (Aaron Judge Fans, Yankees-only). Root cause: the name-token check
// below only confirms the SEARCHED NAME appears somewhere in a photo's
// caption — a caption that merely MENTIONS the target athlete (a
// comparison, an aside, a group photo) passes cleanly even when the
// photo's actual subject is a different player on a different team ("Aaron
// Judge" name-matched a photo of a Mets player; "Ohtani" search matched a
// Phillies player). That mismatch was only ever caught AFTER a full,
// expensive AI render — this catches it before, at the cheap photo-search
// step. Deliberately NOT a positive requirement (a caption naming no team
// at all still passes, same as before — thin/terse real metadata is common
// and shouldn't be punished) — only rejects on an EXPLICIT, checkable
// conflict: the caption names a specific team from the same sport that
// is NOT among the ones this search expects. Scoped to MLB/NBA, the two
// sports with confirmed live evidence; safe to extend if the same pattern
// shows up elsewhere.
const TEAM_NAMES_BY_SPORT: Record<string, string[]> = {
  MLB: [
    "yankees", "mets", "red sox", "dodgers", "phillies", "cubs", "braves", "astros",
    "rangers", "orioles", "blue jays", "rays", "guardians", "tigers", "royals",
    "twins", "white sox", "athletics", "mariners", "angels", "padres", "giants",
    "diamondbacks", "rockies", "brewers", "cardinals", "pirates", "reds", "marlins", "nationals",
  ],
  NBA: [
    "lakers", "celtics", "warriors", "nets", "knicks", "bulls", "heat", "bucks",
    "76ers", "sixers", "nuggets", "suns", "mavericks", "clippers", "grizzlies",
    "pelicans", "kings", "spurs", "thunder", "trail blazers", "blazers", "jazz",
    "timberwolves", "rockets", "hawks", "hornets", "magic", "pistons", "pacers", "raptors", "wizards", "cavaliers",
  ],
};

// `expectedTeamKeywords` are the searched entity's OWN registered keywords
// (e.g. ["ohtani", "dodgers", "two-way star"] for Shohei Ohtani) — any team
// name from the same sport's list that ISN'T among them, but IS in the
// photo's caption, means the caption is explicitly about a different team.
export function hasConflictingTeamMention(text: string, sportGroup: string | undefined, expectedTeamKeywords: string[]): boolean {
  const teamNames = sportGroup ? TEAM_NAMES_BY_SPORT[sportGroup.toUpperCase()] : undefined;
  if (!teamNames) return false; // sport not covered by this list yet — no false positives, just no extra protection
  // Substring match, not exact-set membership: a real entity keyword is
  // often a PHRASE containing the team name ("yankees captain"), not the
  // bare team name itself — exact matching missed this and would have
  // flagged the EXPECTED team as a conflict (caught by this fix's own
  // verification test before deploy).
  const expected = expectedTeamKeywords.map((k) => k.toLowerCase());
  return teamNames.some((team) => !expected.some((k) => k.includes(team) || team.includes(k)) && text.includes(team));
}

export function metadataMatchesSubject(
  result: EsImageResult,
  searchTerm: string,
  teamCheck?: { sportGroup: string | undefined; expectedTeamKeywords: string[] }
): boolean {
  const tokens = searchTerm
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORD_TOKENS.has(t));
  if (tokens.length === 0) return true; // nothing meaningful in the search term to check against

  const text = `${result.title} ${result.caption || ""}`.toLowerCase().trim();
  if (!text || GENERIC_METADATA_RE.test(result.title.trim())) return true; // no real metadata to check against

  // ⛔ OPERATOR FIX (2026-08-13, real live incident): searching "Usman
  // Nurmagomedov" matched a photo captioned only "Umar Nurmagomedov" — his
  // cousin, a different real fighter — because the any-token check below
  // only required ONE token to appear, and the shared surname alone was
  // enough. A two-token search term is almost always a real person's
  // "First Last" name, where the surname alone can never confirm identity
  // among relatives who share it (Nurmagomedov, Manning, Curry-family cases
  // are all real). Requiring BOTH tokens for a plain two-word name closes
  // this without weakening the original Cignetti-on-White fix below (an
  // unrelated person's caption still won't share ANY token) or team/org
  // phrases (3+ tokens), which keep the original any-token match since a
  // caption legitimately may only carry part of a longer name.
  const nameMatches = tokens.length === 2 ? tokens.every((t) => text.includes(t)) : tokens.some((t) => text.includes(t));
  if (!nameMatches) return false;
  // The name matches, but a name match alone doesn't confirm this photo's
  // actual subject — see the 2026-08-25 fix above for why.
  if (teamCheck && hasConflictingTeamMention(text, teamCheck.sportGroup, teamCheck.expectedTeamKeywords)) return false;
  return true;
}

// Searches ES's media library for a real, ACTUALLY REACHABLE photo — tries
// each candidate in ranked order and HEAD-checks it, since the media
// library confirmed live (2026-08-06) to occasionally contain entries whose
// image_url 404s on a different CDN host than the one actually serving the
// image (a real, observed data-quality gap in the library itself, not a
// bug in this code). Returns null if NONE of the top candidates resolve —
// callers must treat null as "no usable photo for this subject," never
// substitute a generic/unrelated image (see the render pipeline's hard
// rules).
export async function searchOneImage(query: string, type: "agency" | "custom" | "all" = "agency"): Promise<EsImageResult | null> {
  const candidates = await searchImages(query, type, 5);
  for (const candidate of candidates) {
    try {
      const head = await fetchWithTimeout(candidate.url, { method: "HEAD" }, 10_000);
      if (head.ok) return candidate;
    } catch {
      // network error on this one candidate — try the next, don't fail the whole search
    }
  }
  return null;
}

export interface EsArticleResult {
  title: string;
  url: string;
  publishedTime: string | null; // "HH:MM" as returned by the tool — no date component
}

// ⛔ OPERATOR FIX (2026-08-07): "at least ES articles can serve as a source
// for the MCP, irrespective of whether T2 is live" — query_articles hits ES's
// own article_big_table directly, which exists and is populated regardless
// of whether the separate Facebook T0-T2 pipeline has run today. This is a
// genuinely independent content source, not a fallback that depends on the
// same upstream pipeline the newsletter/shared-pool tiers already depend on.
// Response is markdown text (title as a link, then a metadata line) — same
// text-content shape as search_images, parsed the same defensive way.
const ARTICLE_LINE_RE = /\*\*\[(.+?)\]\((https?:\/\/[^)]+)\)\*\*\s*\nSport:[^|]*\|[^|]*\|[^|]*\|\s*Published:\s*(\d{2}:\d{2})/g;

export async function queryRecentArticles(sport: string | null, dateISO: string, limit = 20, dateStart?: string): Promise<EsArticleResult[]> {
  const args: Record<string, unknown> = { publish_date_start: dateStart || dateISO, publish_date_end: dateISO, limit };
  if (sport) args.sport = sport;
  return queryArticles(args);
}

// ⛔ OPERATOR FIX (2026-08-08): "only ES article/newsletter link allowed" —
// when a real, externally-discovered story (Tavily/Apify) doesn't itself
// have an ES-owned link, this is how a genuine ES article covering the SAME
// entity gets found instead, rather than either fabricating a link or
// posting the external one. Real query_articles `entity` filter, wider date
// range than queryRecentArticles's single-day default since a real ES piece
// on the same subject may have run a few days either side.
export async function queryArticlesByEntity(entity: string, dateStart: string, dateEnd: string, limit = 20): Promise<EsArticleResult[]> {
  return queryArticles({ entity, publish_date_start: dateStart, publish_date_end: dateEnd, limit });
}

// Result memo for query_articles.
//
// Two call patterns above repeat identical questions many times per run:
// resolveExternalLink (sourcing.ts) runs once per candidate and re-asks for the
// same entity list over the same date window each time; sourceFromEsArticles
// issues one query per sport_group, so pages sharing a sport ask the same
// question independently. Within a run these answers cannot change — same
// entity, same window, same day.
//
// This matters more than query latency suggests: the upstream data warehouse
// bills per query EXECUTION as well as per byte scanned, so repeats are not free
// even when the remote side serves them from its own cache.
//
// Caches the promise rather than the resolved value, so concurrent callers
// coalesce onto one in-flight request instead of issuing N identical ones.
// Rejections are evicted immediately: caching a failure would let one transient
// error starve every later caller in the TTL window of a source that would have
// succeeded on retry.
//
// TTL is shorter than the run schedule so each run still sees fresh articles;
// it only collapses duplicates within a run. Raise ES_ARTICLE_CACHE_TTL_MS to
// trade freshness for fewer calls.
const ARTICLE_CACHE_TTL_MS = Number(process.env.ES_ARTICLE_CACHE_TTL_MS || 15 * 60 * 1000);
const ARTICLE_CACHE_MAX_ENTRIES = Number(process.env.ES_ARTICLE_CACHE_MAX_ENTRIES || 500);

const articleCache = new Map<string, { at: number; value: Promise<EsArticleResult[]> }>();

// Key must be insensitive to property order — callers build `args` object literals
// in different orders (queryRecentArticles adds `sport` conditionally, after the
// dates), and two identical questions written in different key order must share
// one cache entry.
function articleCacheKey(args: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(args)
      .sort()
      .map((k) => [k, args[k]])
  );
}

async function queryArticles(args: Record<string, unknown>): Promise<EsArticleResult[]> {
  const key = articleCacheKey(args);
  const now = Date.now();

  const hit = articleCache.get(key);
  if (hit && now - hit.at < ARTICLE_CACHE_TTL_MS) return hit.value;

  const value = queryArticlesUncached(args);
  articleCache.set(key, { at: now, value });

  // Evict on failure so a transient error is never served for the rest of the TTL.
  // The identity check guards against deleting a newer entry that replaced this one.
  value.catch(() => {
    const current = articleCache.get(key);
    if (current && current.value === value) articleCache.delete(key);
  });

  // Bounded FIFO — Map preserves insertion order, so the first key is the oldest.
  // Keys rotate naturally as `dateISO` advances; this only stops unbounded growth
  // in a long-lived worker process.
  while (articleCache.size > ARTICLE_CACHE_MAX_ENTRIES) {
    const oldest = articleCache.keys().next();
    if (oldest.done) break;
    articleCache.delete(oldest.value);
  }

  return value;
}

async function queryArticlesUncached(args: Record<string, unknown>): Promise<EsArticleResult[]> {
  const texts = await callTool("query_articles", args);
  const joined = texts.join("\n");
  const results: EsArticleResult[] = [];
  for (const match of joined.matchAll(ARTICLE_LINE_RE)) {
    results.push({ title: match[1], url: match[2], publishedTime: match[3] });
  }
  return results;
}
