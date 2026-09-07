// ⛔ OPERATOR FIX (2026-09-07): "ES MCP is down... remove ES MCP from the
// system itself." Replaces esMcp.ts entirely. Two direct backends now, no
// MCP server in between:
//   - Images:   Typesense directly (same host/collection/key ES-MCP's own
//     search_images tool used — see tools/search-images.ts in the es-mcp
//     repo, read directly to extract this).
//   - Articles: the ES WordPress REST API (wp-json/wp/v2/posts), replacing
//     the Athena-backed query_articles tool.
//
// Every exported name/signature below matches esMcp.ts exactly on purpose —
// sourcing.ts and activities/index.ts needed a one-line import-path change
// and nothing else. metadataMatchesSubject/hasConflictingTeamMention are
// pure functions with no ES-MCP dependency at all and are copied verbatim.
//
// WP endpoint is staging.essentiallysports.com, not www — confirmed
// deliberately, not a leftover placeholder: fetching wp-json on the
// production hostname 308-redirects to staging (a CDN almost certainly
// fronts www and doesn't proxy /wp-json/), and staging's own response
// carries today's real posts with `link` already pointing at the real
// public essentiallysports.com domain — same underlying content, this is
// just the real API origin.
//
// Real side benefit beyond "the dependency that was down is gone": ES-MCP's
// query_articles billed real Athena/S3 dollars per execution (utilities/
// cost.ts in that repo exists because of it). WordPress's own REST API
// queries its own MySQL database — no Athena, no S3 list-call cost, no
// per-query dollar figure at all.

import { fetchWithTimeout, createLimiter } from "./httpUtil";

const WP_POSTS_URL = "https://staging.essentiallysports.com/wp-json/wp/v2/posts";
const WP_MAX_PER_PAGE = 100; // WordPress's own hard ceiling on this param

// Own limiter per shared dependency — every one of this pipeline's external
// calls that ever went without one (ES-MCP itself, Apify, the AI Gateway)
// has gone on to cause a real concurrent-overload incident this session.
// Built in from day one here instead of waiting for the same lesson again.
const limitWpApi = createLimiter(8);
const limitTypesense = createLimiter(6);

// ── Images — direct Typesense ────────────────────────────────────────────

const TS_HOST = "z1jtlbof42i8dqg0p.a1.typesense.net";
const TS_COLLECTION = "wp_images";

function typesenseApiKey(): string {
  const key = process.env.TYPESENSE_SEARCH_API_KEY;
  if (!key) throw new Error("TYPESENSE_SEARCH_API_KEY is not set");
  return key;
}

// Same CDN-hostname correction ES-MCP's own tools/search-images.ts applies —
// the media library's raw image_url occasionally names a CDN host that
// doesn't actually serve the file; this one does.
function fixImageUrl(url: string | undefined): string {
  return (url || "").replace("cdn.essentiallysports.com", "image-cdn.essentiallysports.com");
}

export interface EsImageResult {
  url: string;
  title: string;
  caption?: string;
  credit?: string;
}

interface TypesenseImageDoc {
  id: string;
  wp_id: number;
  image_type: "agency" | "custom";
  image_url: string;
  thumb_url?: string;
  title?: string;
  alt_text?: string;
  exif_caption?: string;
  exif_credit?: string;
  post_date_ts: number;
}

async function fetchFromTypesense(query: string, type: "agency" | "custom" | "all", perPage: number): Promise<TypesenseImageDoc[]> {
  const params = new URLSearchParams({
    q: query.trim(),
    query_by: "title,alt_text,exif_caption,keywords",
    query_by_weights: "4,4,3,2",
    sort_by: "_text_match:desc,post_date_ts:desc",
    per_page: String(perPage),
    include_fields: "id,wp_id,title,alt_text,exif_caption,exif_credit,image_type,image_url,thumb_url,post_date_ts",
    ...(type !== "all" ? { filter_by: `image_type:=${type}` } : {}),
  });

  const res = await limitTypesense(() =>
    fetchWithTimeout(
      `https://${TS_HOST}/collections/${TS_COLLECTION}/documents/search?${params}`,
      { headers: { "X-TYPESENSE-API-KEY": typesenseApiKey() } },
      8_000
    )
  );
  if (!res.ok) throw new Error(`Typesense error ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = (await res.json()) as { hits?: Array<{ document: TypesenseImageDoc }> };
  return (data.hits || []).map((h) => h.document);
}

// Searches ES's media library. Returns up to `count` results, ranked by
// Typesense's own relevance-then-recency sort — does NOT verify each URL is
// actually reachable (see searchOneImage, which does).
export async function searchImages(query: string, type: "agency" | "custom" | "all" = "agency", count = 5): Promise<EsImageResult[]> {
  const docs = await fetchFromTypesense(query, type, count);
  return docs.map((doc) => ({
    url: fixImageUrl(doc.image_url),
    title: doc.title || "",
    caption: doc.exif_caption,
    credit: doc.exif_credit,
  }));
}

// ⛔ Everything below this point through hasConflictingTeamMention is
// copied verbatim from esMcp.ts — pure text-matching logic with no ES-MCP
// (or any external) dependency, so nothing here needed to change. Comments
// trimmed to the parts still relevant post-rename; the original 2026-08-11/
// 08-13/08-25 incident context that justified this logic is preserved in
// git history on esMcp.ts if it's ever needed again.

const GENERIC_METADATA_RE = /^(getty images?|action images?|icon sportswire|imagn|reuters|ap photo|usa today|zuma press)$/i;
const STOPWORD_TOKENS = new Set(["the", "and", "of", "for", "vs", "news"]);

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

export function hasConflictingTeamMention(text: string, sportGroup: string | undefined, expectedTeamKeywords: string[]): boolean {
  const teamNames = sportGroup ? TEAM_NAMES_BY_SPORT[sportGroup.toUpperCase()] : undefined;
  if (!teamNames) return false;
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
  if (tokens.length === 0) return true;

  const text = `${result.title} ${result.caption || ""}`.toLowerCase().trim();
  if (!text || GENERIC_METADATA_RE.test(result.title.trim())) return true;

  const nameMatches = tokens.length === 2 ? tokens.every((t) => text.includes(t)) : tokens.some((t) => text.includes(t));
  if (!nameMatches) return false;
  if (teamCheck && hasConflictingTeamMention(text, teamCheck.sportGroup, teamCheck.expectedTeamKeywords)) return false;
  return true;
}

// Searches ES's media library for a real, ACTUALLY REACHABLE photo — tries
// each candidate in ranked order and HEAD-checks it, matching the same
// data-quality gap esMcp.ts's own version existed to cover (an entry whose
// image_url 404s on a different CDN host than the one actually serving it).
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

// ── Articles — direct WordPress REST API ─────────────────────────────────

export interface EsArticleResult {
  title: string;
  url: string;
  publishedTime: string | null; // "HH:MM" UTC — no date component, matching esMcp.ts's original contract
}

interface WpPost {
  link: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  date_gmt?: string; // "YYYY-MM-DDTHH:MM:SS", genuinely UTC — NOT `date`, which is site-local
}

// Callers downstream (sourcing.ts) append a literal "Z" to publishedTime
// when building publishedAt — esMcp.ts's original HH:MM was already an
// implicit-UTC time-of-day, so this extracts from date_gmt specifically,
// never the site-local `date` field, to preserve that same assumption.
// Getting this wrong wouldn't error — it would silently shift every
// article's apparent age by the site's UTC offset, which the freshness
// gates (checkAccuracy's maxAgeHours) would never catch on their own.
function utcTimeOfDay(dateGmt: string | undefined): string | null {
  const match = dateGmt?.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : null;
}

// WordPress's excerpt.rendered is real HTML (paragraph tags, often a
// trailing "[&hellip;]"). Stripped to plain text for rawText — genuinely
// new context the old ES-MCP-backed EsArticleResult never carried at all
// (that shape only ever had title/url/time), not a required field for
// parity, just free quality: sourcing.ts currently sets rawText to a bare
// copy of the title, so real excerpt text is a strict improvement for
// whatever downstream caption-writing reads it, never a regression.
// ⛔ Caught by live-testing this file against the real API before shipping:
// WordPress titles carry both literal unicode (some curly quotes arrived
// as real characters already) AND numeric HTML entities for the same
// characters elsewhere ("&#8220;"/"&#8221;" showed up undecoded in real
// titles during that test). A hardcoded list of specific entities missed
// them — decoding numeric entities generically instead of guessing which
// ones will show up next.
const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&nbsp;": " ",
  "&hellip;": "…",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&rdquo;": "”",
  "&ldquo;": "“",
};

function stripHtml(html: string | undefined): string {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&[a-z]+;/gi, (m) => NAMED_ENTITIES[m.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

// ⛔ OPERATOR FIX (2026-08-30-era retry pattern, carried over): a single
// retry with a short backoff on a transient failure — same shape as
// esMcp.ts's own callTool, for the same reason: one bad response on a
// shared endpoint shouldn't cost a whole sourcing tier for the run.
async function fetchWpPosts(params: URLSearchParams, attempts = 2): Promise<WpPost[]> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await limitWpApi(() =>
        fetchWithTimeout(`${WP_POSTS_URL}?${params}`, {}, 15_000)
      );
      if (!res.ok) throw new Error(`WP posts -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return (await res.json()) as WpPost[];
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastError;
}

function toArticleResults(posts: WpPost[]): EsArticleResult[] {
  return posts
    .filter((p) => p.link && p.title?.rendered)
    .map((p) => ({
      title: stripHtml(p.title!.rendered),
      url: p.link,
      publishedTime: utcTimeOfDay(p.date_gmt),
    }));
}

// `excerpt` is fetched even though EsArticleResult doesn't carry it — parity
// with esMcp.ts's original {title, url, publishedTime} contract, nothing
// more, since sourcing.ts's own Candidate-building only ever reads those
// three fields today (confirmed by reading it). Real excerpt text would be
// a genuine, free quality improvement for caption-writing context, but
// wiring it through is a separate change, not bundled into this parity
// swap — see stripHtml, kept here for whoever picks that up next.
const FIELDS = "title,excerpt,link,date_gmt";

// Same request-memoization esMcp.ts had: resolveExternalLink runs once per
// candidate re-asking the same entity+window question, and sourceFromEsArticles
// issues one query per sport_group, so pages sharing a sport ask the same
// question independently — these answers cannot change within a run.
const ARTICLE_CACHE_TTL_MS = Number(process.env.ES_ARTICLE_CACHE_TTL_MS || 15 * 60 * 1000);
const ARTICLE_CACHE_MAX_ENTRIES = Number(process.env.ES_ARTICLE_CACHE_MAX_ENTRIES || 500);
const articleCache = new Map<string, { at: number; value: Promise<EsArticleResult[]> }>();

function articleCacheKey(args: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]]));
}

async function cachedArticleQuery(args: Record<string, unknown>, run: () => Promise<EsArticleResult[]>): Promise<EsArticleResult[]> {
  const key = articleCacheKey(args);
  const now = Date.now();

  const hit = articleCache.get(key);
  if (hit && now - hit.at < ARTICLE_CACHE_TTL_MS) return hit.value;

  const value = run();
  articleCache.set(key, { at: now, value });

  value.catch(() => {
    const current = articleCache.get(key);
    if (current && current.value === value) articleCache.delete(key);
  });

  while (articleCache.size > ARTICLE_CACHE_MAX_ENTRIES) {
    const oldest = articleCache.keys().next();
    if (oldest.done) break;
    articleCache.delete(oldest.value);
  }

  return value;
}

// sport=null means no search term at all — WordPress's own default
// (chronological, newest first) over the date window, matching
// query_articles's original "no sport filter" behavior.
export async function queryRecentArticles(sport: string | null, dateISO: string, limit = 20, dateStart?: string): Promise<EsArticleResult[]> {
  const args = { kind: "recent", sport, dateISO, limit, dateStart };
  return cachedArticleQuery(args, async () => {
    const params = new URLSearchParams({
      _fields: FIELDS,
      per_page: String(Math.min(limit, WP_MAX_PER_PAGE)),
      orderby: "date",
      order: "desc",
      after: `${dateStart || dateISO}T00:00:00`,
      before: `${dateISO}T23:59:59`,
    });
    if (sport) params.set("search", sport);
    return toArticleResults(await fetchWpPosts(params));
  });
}

// Real query_articles `entity` filter equivalent — WordPress's own
// full-text search across title/content, same "same subject, different
// exact wording" tolerance the original had.
export async function queryArticlesByEntity(entity: string, dateStart: string, dateEnd: string, limit = 20): Promise<EsArticleResult[]> {
  const args = { kind: "entity", entity, dateStart, dateEnd, limit };
  return cachedArticleQuery(args, async () => {
    const params = new URLSearchParams({
      _fields: FIELDS,
      per_page: String(Math.min(limit, WP_MAX_PER_PAGE)),
      orderby: "date",
      order: "desc",
      search: entity,
      after: `${dateStart}T00:00:00`,
      before: `${dateEnd}T23:59:59`,
    });
    return toArticleResults(await fetchWpPosts(params));
  });
}
