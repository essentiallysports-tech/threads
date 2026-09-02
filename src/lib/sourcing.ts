import { PageConfig, Candidate, PostedLogEntry } from "./types";
import { latestConfirmedPost, recentConfirmedPosts, recentPublishedPolls } from "./beehiiv";
import { isFreshEnough, entityOrSportMatch, isEsOwnedLink, isTestMarkerContent, isFlatStatDump, realRegisteredEntityMatches } from "./checks";
import { getSharedPool, getAllEvergreenAngles, EvergreenAngle } from "./s3registry";
import { queryRecentArticles, queryArticlesByEntity, EsArticleResult } from "./esMcp";
import { sourceFromWebSearch, sourceFromEvergreenWebSearch, webSearch, searchResultsToCandidates } from "./webSearch";
import { sourceFromTwitter, sourceFromReddit } from "./socialSearch";
import { fetchWithTimeout } from "./httpUtil";
import { getPostContent } from "./beehiiv";

// ⛔ OPERATOR FIX (2026-08-23, real live incident): today's removal of the
// artificial 5-entity cap on sourceFromEsEvergreenArticles (a real coverage
// gap — Golf Syndicate's other 10 entities were getting zero evergreen
// coverage) also removed the only thing bounding how many SIMULTANEOUS
// requests one page's sourcing fires at ES-MCP's one shared endpoint. With
// PAGE_CONCURRENCY=6 pages running at once in dailyRunWorkflow.ts, a
// 15-entity page alone could fire 15 concurrent requests, and worst case
// across 6 concurrent pages that's up to ~90 simultaneous calls against a
// single static-bearer-token endpoint — confirmed live: dozens of "This
// operation was aborted" timeouts appeared across nearly every page
// immediately after this fix shipped. Bounds concurrency PER CALL SITE
// without giving up any coverage — every entity still gets queried, just
// not all in one simultaneous burst.
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

const NEWSLETTER_MIX_TARGET = 0.7; // 70% of posts sourced directly from the newsletter, per operator directive
const NEWSLETTER_MAX_AGE_HOURS = 24 * 5; // a 5-day-old "latest" edition is still a real, usable source; older falls back

// How many candidates may have their ES link resolved concurrently. Each resolution
// issues up to 3 query_articles calls and all shards run in parallel, so the real
// ceiling on simultaneous warehouse queries is a multiple of this. Athena's
// on-demand concurrency quota is account-wide and shared with other consumers, so
// this job must not consume it alone. Latency cost is negligible because esMcp.ts
// memoises the queries — most resolutions are cache hits with no network call.
const LINK_RESOLUTION_CONCURRENCY = Number(process.env.LINK_RESOLUTION_CONCURRENCY || 3);

// Deterministic source selection — no LLM judgment call. `todaysPostCountForPage`
// and `newsletterCountForPage` are real counts read from the posted log by the
// caller, so the 70/30 ratio is enforced against actual history, not a coin flip.
export function shouldSourceFromNewsletter(newsletterCountSoFar: number, totalCountSoFar: number): boolean {
  if (totalCountSoFar === 0) return true; // first post of the day defaults to newsletter
  const currentRatio = newsletterCountSoFar / totalCountSoFar;
  return currentRatio < NEWSLETTER_MIX_TARGET;
}

export async function sourceFromNewsletter(page: PageConfig): Promise<Candidate | null> {
  const pubId = page.threads?.beehiiv_publication_id;
  if (!pubId) return null;
  const post = await latestConfirmedPost(pubId);
  if (!post) return null;

  // ⛔ OPERATOR FIX (2026-08-15, real live incident, severe): `subject` used
  // to be hardcoded to the page's OWN name — every text-relevance check in
  // checks.ts (entityOrSportMatch, realRegisteredEntityMatches, etc.) scans
  // `subject` as part of what the story is "about", so a page whose name
  // contains one of its own registered keywords (e.g. Detroit Lions
  // Community's page_name contains its "detroit lions" keyword) made EVERY
  // newsletter candidate self-match regardless of what the actual edition
  // covered — confirmed live: this page posted 5 straight off-team NFL
  // newsletter items (49ers, Steelers, Chiefs...) with zero Lions
  // connection, all silently passing the entity gate this way. `subject`
  // should describe the STORY, not echo back the page it's being
  // considered for — use the post's own real title, same as everywhere
  // else a newsletter candidate's real content is represented.
  const candidate: Candidate = {
    source: "beehiiv_newsletter",
    key: post.id,
    subject: post.title,
    headline: post.title,
    link: post.web_url,
    publishedAt: new Date(post.publish_date * 1000).toISOString(),
    thumbnailUrl: post.thumbnail_url,
    rawText: post.subject_line,
  };

  if (!isFreshEnough(candidate, NEWSLETTER_MAX_AGE_HOURS)) return null; // stale edition — let the caller fall back
  return candidate;
}

// ⛔ OPERATOR BROADENING (2026-08-10): "very very comprehensive so that
// nothing is ever short of things." sourceFromNewsletter above only ever
// looks at the SINGLE latest edition (needed for the exact 70/30 mix ratio);
// this is the general-purpose newsletter tier — scans the last several
// editions and returns every real one, letting the standard entity/sport
// match + accuracy gate downstream decide which are actually usable, same
// as every other tier here. Never fabricates content: these are real,
// already-sent Beehiiv editions with real titles and real links.
export async function sourceFromNewsletterBroad(page: PageConfig): Promise<Candidate[]> {
  const pubId = page.threads?.beehiiv_publication_id;
  if (!pubId) return [];
  const posts = await recentConfirmedPosts(pubId, 10).catch((e) => {
    console.error(`sourceFromNewsletterBroad: recentConfirmedPosts failed for ${page.page_id}: ${(e as Error).message}`);
    return [];
  });
  return posts
    .map((post): Candidate => ({
      source: "beehiiv_newsletter",
      key: post.id,
      subject: post.title, // see sourceFromNewsletter's comment — never the page's own name
      headline: post.title,
      link: post.web_url,
      publishedAt: new Date(post.publish_date * 1000).toISOString(),
      thumbnailUrl: post.thumbnail_url,
      rawText: post.subject_line,
    }))
    .filter((c) => isFreshEnough(c, NEWSLETTER_MAX_AGE_HOURS));
}

// ⛔ OPERATOR FIX (2026-08-18, real live incident): "2 editions go out
// daily, each has a few stories, no relevant news from that also is taken."
// sourceFromNewsletter/sourceFromNewsletterBroad above both only ever
// compare a page's entities against the EDITION's own title (e.g. "Rogan
// Clears Stance on WNBA Trans Debate") — a multi-story digest can carry a
// real, individually-linked ES article for an entirely different page
// buried inside it, and it was never being looked at. This reads the
// edition's full HTML (beehiiv.ts's getPostContent) and splits it into its
// real per-story sections so each one gets checked against this page's
// entities individually, same as any other real ES article.
const NON_STORY_HEADING_RE = /did you enjoy this edition|subscribe|share this|advertise with us|follow us/i;

// Beehiiv's real-HTML links carry a per-recipient merge tag
// (`email_hash={{subscriber_email_hash_sha256}}`) that only resolves when
// the email is actually sent — posting that literal placeholder as a public
// link would be broken. Strip it (and any other `{{...}}` merge var) along
// with the newsletter's own attribution UTM, since this link is now being
// used as a Threads reply link, not a newsletter click-through.
function sanitizeBeehiivLink(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/\{\{.*\}\}/.test(u.searchParams.get(key) || "")) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return url;
  }
}

const HTML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&", "&#39;": "'", "&apos;": "'", "&quot;": '"', "&nbsp;": " ", "&lt;": "<", "&gt;": ">",
};
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(amp|#39|apos|quot|nbsp|lt|gt);/g, (m) => HTML_ENTITY_MAP[m] || m);
}

interface NewsletterStory {
  heading: string;
  paragraph: string;
  link: string | null;
}

function extractNewsletterStories(html: string): NewsletterStory[] {
  const segments = html.split(/(?=<h[1-4][^>]*>)/i);
  const stories: NewsletterStory[] = [];
  for (const segment of segments) {
    const headingMatch = segment.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i);
    if (!headingMatch) continue;
    const heading = decodeHtmlEntities(headingMatch[1].replace(/<[^>]+>/g, "")).trim();
    if (!heading || NON_STORY_HEADING_RE.test(heading)) continue;

    const rest = segment.slice(headingMatch.index! + headingMatch[0].length);
    const linkMatch = rest.match(/<a[^>]+href=["']([^"']*essentiallysports\.com[^"']*)["']/i);
    const link = linkMatch ? sanitizeBeehiivLink(linkMatch[1]) : null;

    const paraMatch = rest.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const paragraph = paraMatch ? decodeHtmlEntities(paraMatch[1].replace(/<[^>]+>/g, "")).trim() : "";

    stories.push({ heading, paragraph, link });
  }
  return stories;
}

const NEWSLETTER_STORY_EDITIONS = 4; // ~2 days of editions at 2/day — matches the newsletter tiers' own recency tolerance

export async function sourceFromNewsletterStories(page: PageConfig): Promise<Candidate[]> {
  const pubId = page.threads?.beehiiv_publication_id;
  if (!pubId) return [];

  const posts = await recentConfirmedPosts(pubId, NEWSLETTER_STORY_EDITIONS).catch((e) => {
    console.error(`sourceFromNewsletterStories: failed to list editions for ${page.page_id}: ${(e as Error).message}`);
    return [];
  });
  if (posts.length === 0) return [];

  const entityNames = page.entities.map((e) => e.name.toLowerCase());
  const sportGroups = page.sport_groups.map((s) => s.toLowerCase());

  const perEdition = await Promise.all(
    posts.map(async (post) => {
      const html = await getPostContent(pubId, post.id).catch((e) => {
        console.error(`sourceFromNewsletterStories: getPostContent failed for ${page.page_id} post=${post.id}: ${(e as Error).message}`);
        return null;
      });
      if (!html) return [] as Candidate[];
      const stories = extractNewsletterStories(html);
      const out: Candidate[] = [];
      for (const story of stories) {
        if (!story.link) continue; // only real, individually ES-linked stories — never fabricate a link for a headline-only section
        const text = `${story.heading} ${story.paragraph}`.toLowerCase();
        const matches = entityNames.some((n) => text.includes(n)) || sportGroups.some((s) => text.includes(s));
        if (!matches) continue;
        const slugMatch = story.link.match(/\/([^/]+)\/?(?:\?.*)?$/);
        out.push({
          source: "es_article", // a genuinely real ES article link, just discovered via the newsletter instead of ES-MCP — same trust tier
          key: slugMatch ? slugMatch[1] : story.link,
          subject: story.heading,
          headline: story.heading,
          link: story.link,
          publishedAt: new Date(post.publish_date * 1000).toISOString(),
          rawText: story.paragraph || story.heading,
        });
      }
      return out;
    })
  );

  return perEdition.flat();
}

const POLL_MAX_AGE_HOURS = 24 * 3; // a poll a few days old is still a real, genuine "our readers were just asked this" — matches the newsletter tier's own staleness tolerance philosophy, tighter since a poll reads as more time-sensitive than an edition recap.

// ⛔ OPERATOR DIRECTION (2026-08-12): "we would easily hit the floor even if
// we do post for all ES articles and beehiiv polls." Real, already-asked
// reader polls — zero fabrication risk, always genuinely debate-shaped,
// always real named entities. See beehiiv.ts's recentPublishedPolls for the
// full reasoning on why this only sources the question, not a fabricated
// or guessed result.
export async function sourceFromBeehiivPolls(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  const pubId = page.threads?.beehiiv_publication_id;
  if (!pubId) return [];
  const polls = await recentPublishedPolls(pubId, 10).catch((e) => {
    console.error(`sourceFromBeehiivPolls: failed for ${page.page_id}: ${(e as Error).message}`);
    return [];
  });
  return polls
    .map((poll): Candidate => {
      const choiceLabels = poll.poll_choices.map((c) => c.label.trim()).filter(Boolean);
      return {
        source: "beehiiv_poll",
        key: poll.id,
        subject: poll.name,
        headline: poll.question,
        link: "",
        publishedAt: new Date(poll.created_at * 1000).toISOString(),
        rawText: choiceLabels.length > 0 ? `Real poll options our readers were given: ${choiceLabels.join(" / ")}` : undefined,
      };
    })
    .filter((c) => isFreshEnough(c, POLL_MAX_AGE_HOURS));
}

// The shared T2 pool — the same file the Facebook pipeline's T_POST reads.
// Filtered to this page's own entities/sport_groups by the caller via
// runDeterministicChecks; this just returns real, unfiltered candidates.
export async function sourceFromSharedPool(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  // ⛔ OPERATOR FIX (2026-08-10/11): "make sure fallbacks don't become a
  // roadblocker" — this call sits inside the outer Promise.all of every
  // sourcing tier (sourceCandidatePoolForPage); unguarded, a single S3 read
  // failure here would reject that WHOLE Promise.all and discard every
  // other tier's real, successfully-fetched candidates for this page.
  const pool = await getSharedPool(dateISO).catch((e) => {
    console.error(`sourceFromSharedPool: failed for ${page.page_id}: ${(e as Error).message}`);
    return [];
  });
  return pool
    .map((s): Candidate | null => {
      const sourceUrl = (s.source_url || s.article_url) as string | undefined;
      const headline = s.headline as string | undefined;
      const storyId = s.source_story_id as string | undefined;
      const publishedAt = (s.source_published_at as string | undefined) || new Date().toISOString();
      if (!sourceUrl || !headline || !storyId) return null;
      return {
        source: "shared_pool" as const,
        key: storyId,
        subject: (s.subject as string) || headline,
        headline,
        link: sourceUrl,
        publishedAt,
        rawText: (s.caption as string) || headline,
      };
    })
    .filter((c): c is Candidate => !!c);
}

// ⛔ OPERATOR FIX (2026-08-07): "at least ES articles can serve as a source
// for the MCP, irrespective of whether T2 is live" — this is a genuinely
// independent tier: ES's own article_big_table (via ES-MCP's query_articles)
// is populated by the ES editorial/publishing pipeline directly, with no
// dependency on the separate Facebook T0-T2 job that populates the shared
// pool. Real headlines, real named subjects, real URLs — exactly what was
// missing on days the shared pool comes up empty (see esMcp.ts's own
// comment on why this call exists). Slug-derived key for stable dedup
// against the posted log, same contract as every other Candidate source.
// ⛔ OPERATOR BROADENING (2026-08-10): "Daily 150 ES articles are written at
// least they should be mapped to relevant pages and posted." Two real gaps
// fixed: (1) this only ever queried page.sport_groups[0] — a multi-sport
// page (p44: NFL/NBA/MLB/Golf/UFC&Boxing, p57: MMA/BOXING/COMBAT) never saw
// articles from any sport but its first, silently. Now queries every
// registered sport_group in parallel and merges. (2) the hardcoded limit=20
// per call could truncate a genuinely high-volume sport day; raised to 50.
// ⛔ OPERATOR FIX (2026-08-17, real live incident): "Apify [Twitter/Reddit]
// would be resolved in 3 days, use other sources and fulfill the quota" —
// this used to query ONLY by broad sport category (up to 50 sport-wide
// articles), which is exactly why 55% of a completed run's candidates were
// dying at NO_NAMED_ENTITY: a sport-wide query surfaces plenty of real ES
// articles, but most cover OTHER teams/players in that sport, not this
// page's own registered roster. queryArticlesByEntity already exists (used
// elsewhere for link-resolution) and hits the same real article_big_table
// with a genuine entity filter — querying it per registered entity for
// TODAY specifically finds on-topic ES-owned content directly, independent
// of Apify entirely, rather than hoping it survives in the top 50 of a
// broad sport-level result set.
// ⛔ OPERATOR FIX (2026-08-18, real live incident): "ES articles from past
// 72 hours can be used." Both queries here were scoped to a single day
// (dateISO to dateISO) — on a day where a page's own roster genuinely wasn't
// covered by ES *today*, this returned nothing even when a perfectly good,
// still-fresh (e.g. yesterday's) real ES article existed, pushing sourcing
// down to the far less trustworthy evergreen/web-search tiers instead.
// isFreshEnough's own accuracy-gate check (checks.ts) already tolerates
// content up to its page-specific maxAgeHours, so widening the *query*
// window to 72h doesn't bypass that gate — it just lets genuinely-fresh ES
// articles from the last 3 days be found at all before falling back further.
const ES_ARTICLE_LOOKBACK_HOURS = 72;

// query_articles' `publish_date_start`/`_end` filters the DB correctly
// across a multi-day range, but its response text only ever carries an
// "HH:MM" time-of-day (esMcp.ts's EsArticleResult.publishedTime), never a
// date — that was harmless when this tier only ever queried a single day
// (the implicit date), but querying a 72h range and still stamping every
// result with TODAY's date would silently recreate the exact
// fake-freshness bug just fixed in webSearch.ts (a 2-day-old article
// stamped as posted-today). So each day in the window is queried
// separately, tagging results with that day's own real date.
function lookbackDates(dateISO: string, hours: number): string[] {
  const days = Math.ceil(hours / 24) + 1;
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    dates.push(new Date(new Date(`${dateISO}T00:00:00Z`).getTime() - i * 24 * 3600 * 1000).toISOString().slice(0, 10));
  }
  return dates;
}

export async function sourceFromEsArticles(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  const sports = page.sport_groups.length > 0 ? page.sport_groups : [null];
  const entityNames = page.entities.map((e) => e.name);
  const dateStart = new Date(new Date(`${dateISO}T00:00:00Z`).getTime() - ES_ARTICLE_LOOKBACK_HOURS * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const days = lookbackDates(dateISO, ES_ARTICLE_LOOKBACK_HOURS);

  // ⛔ OPERATOR FIX (2026-08-23, real live incident): both catches below used
  // to swallow failures with no log at all, unlike every sibling tier in
  // this file (sourceFromSharedPool, sourceFromEvergreenBank,
  // sourceFromNewsletterStories all log on failure). With PAGE_CONCURRENCY=6
  // and a page like Golf Syndicate firing 35+ concurrent ES-MCP calls
  // (sport×day combos plus one per entity) against one static-bearer-token
  // endpoint, a rate-limit/timeout/5xx here was indistinguishable in logs
  // from "genuinely no articles today" — the most plausible concrete
  // explanation for "not all relevant ES articles used for posting."
  const sportDayPairs = sports.flatMap((sport) => days.map((day) => ({ sport, day })));
  // ⛔ OPERATOR FIX (2026-08-24, sharding rollout): was 4. Calibrated when a
  // single workflow execution was the only source of concurrent ES-MCP load;
  // now up to 6 shards can run this same fan-out concurrently, multiplying
  // the effective system-wide ceiling against ES-MCP's one shared endpoint.
  // Halved here to keep that combined ceiling in a similar real range,
  // pending live-log validation post-rollout (same posture as the original
  // 2026-08-23 fix this reduces).
  // ⛔ OPERATOR FIX (2026-08-31, real live incident — p44 "EssentiallySports
  // Media", 6 sport_groups vs every other page's 1-2): a flat 2 makes p44's
  // fan-out (sports.length x days.length combos) take 3x as many sequential
  // rounds as a normal page, and it was routinely blowing sourceCandidatePool's
  // 8-minute activity timeout as a result — zero posts for 44+ hours. Scale up
  // to this page's own sport_groups count (capped at 6, floored at the
  // existing 2) rather than raising the flat value for every page, so the
  // 2026-08-24 fleet-wide ceiling reasoning above still holds for every
  // normal 1-2-sport page; only a page that genuinely needs more concurrency
  // gets it. esMcp.ts's request memoisation (2026-08-31) also means much of
  // this fan-out now coalesces onto shared in-flight/cached calls rather than
  // hitting the warehouse 1:1, further limiting the real marginal load.
  const [perSportPerDay, perEntity] = await Promise.all([
    mapWithConcurrency(sportDayPairs, Math.min(6, Math.max(2, sports.length)), async ({ sport, day }) => ({
      day,
      articles: await queryRecentArticles(sport, day, 50).catch((e) => {
        console.error(`sourceFromEsArticles: queryRecentArticles failed for ${page.page_id} sport=${sport} day=${day}: ${(e as Error).message}`);
        return [];
      }),
    })),
    mapWithConcurrency(entityNames, 2, (entity) =>
      queryArticlesByEntity(entity, dateStart, dateISO, 20).catch((e) => {
        console.error(`sourceFromEsArticles: queryArticlesByEntity failed for ${page.page_id} entity="${entity}": ${(e as Error).message}`);
        return [];
      })
    ),
  ]);

  const seen = new Set<string>();
  const dayByUrl = new Map<string, string>();
  const articles: EsArticleResult[] = [];
  for (const { day, articles: dayArticles } of perSportPerDay) {
    for (const a of dayArticles) {
      if (seen.has(a.url)) continue;
      seen.add(a.url);
      dayByUrl.set(a.url, day);
      articles.push(a);
    }
  }
  // Entity-scoped results already span the full range server-side and carry
  // no per-day tag — fall back to dateISO for these (matches prior
  // same-day-only behavior; entity queries are a smaller, targeted set so
  // this residual imprecision is an acceptable trade for real coverage).
  for (const a of perEntity.flat()) {
    if (seen.has(a.url)) continue;
    seen.add(a.url);
    articles.push(a);
  }

  // ⛔ OPERATOR FIX (2026-08-19, real live incident): "if 65 [ES articles]
  // are relevant to our pages... we can directly create at least 100
  // posts from them." Every real article used to yield exactly ONE
  // candidate — once posted, its key was permanently excluded (see
  // postedKeys filtering in sourceCandidatePoolForPage), capping real
  // article-based volume at 1 post/article for good, regardless of unfilled
  // daily budget. Now emits a second candidate per article carrying an
  // alternate narrative angle (rotated deterministically by URL so the same
  // article always gets the same second angle, not a random one each run) —
  // same real link/facts, a genuinely different framing for the caption
  // writer (buildPrompt in narrativeCaption.ts) to pick up. Capped at 2
  // total per article (not all 4 angles) to keep growth proportionate
  // rather than quadrupling the candidate pool outright.
  const ANGLES: NonNullable<Candidate["angle"]>[] = ["stat", "debate", "comparison", "significance"];
  function pickAngle(url: string): NonNullable<Candidate["angle"]> {
    let hash = 0;
    for (let i = 0; i < url.length; i++) hash = (hash * 31 + url.charCodeAt(i)) >>> 0;
    return ANGLES[hash % ANGLES.length];
  }

  return articles.flatMap((a): Candidate[] => {
    const slugMatch = a.url.match(/\/([^/]+)\/?$/);
    const key = slugMatch ? slugMatch[1] : a.url;
    const day = dayByUrl.get(a.url) || dateISO;
    const publishedAt = a.publishedTime ? `${day}T${a.publishedTime}:00Z` : `${day}T12:00:00Z`;
    const base: Candidate = {
      source: "es_article",
      key,
      subject: a.title,
      headline: a.title,
      link: a.url,
      publishedAt,
      rawText: a.title,
    };
    const angled: Candidate = { ...base, key: `${key}:${pickAngle(a.url)}`, angle: pickAngle(a.url) };
    return [base, angled];
  });
}

// ⛔ OPERATOR FIX (2026-08-13): "if they are retrospective, ES also writes
// evergreen articles they can also be used along with other sources" / "in
// this case recent articles should not be a criteria, if an article is
// evergreen a bit older can also be used." sourceFromEsArticles above only
// ever queries TODAY (queryRecentArticles's publish_date_start/end are both
// dateISO) — a legends/nostalgia page's real, on-brand, ES-owned coverage of
// its own registered entities (a Kobe Bryant career piece, a Dale Earnhardt
// retrospective) was never being looked for, because it wasn't published
// today. This queries ES's own catalog by entity over a multi-year window
// instead of one day. query_articles never returns a full publish date for
// an older piece (esMcp.ts's EsArticleResult — time-of-day only, no date
// component), so publishedAt falls back to "now," same convention
// searchResultsToCandidates already uses for this exact source tag when a
// search result carries no date of its own — "evergreen_search" is
// deliberately exempt from every recency check downstream (see
// isTooRecentForRetrospectivePage in checks.ts), so an old article never
// gets mistaken for breaking news regardless of the timestamp on the
// candidate object. Not gated to only retrospective-themed pages — any
// page's registered entities can have real older ES coverage worth
// surfacing, and a page that already has plenty of fresh news simply won't
// end up using these once MIN_SAFE_CANDIDATES is already cleared.
async function sourceFromEsEvergreenArticles(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  const entityNames = page.entities.map((e) => e.name);
  if (entityNames.length === 0) return [];
  const dateStart = new Date(new Date(`${dateISO}T00:00:00Z`).getTime() - 5 * 365 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  // ⛔ OPERATOR FIX (2026-08-23, real live incident): this was the only one
  // of the three ES-article tiers still capped to the first 5 entities —
  // sourceFromEsArticles's own per-entity query and resolveExternalLink's
  // were both explicitly widened to query EVERY registered entity (see
  // resolveExternalLink's own comment citing Golf Syndicate's 15 entities).
  // A page with 6+ entities was silently getting zero evergreen/legacy
  // coverage for every entity past the 5th — confirmed on Golf Syndicate,
  // which loses coverage for 10 of its 15.
  // Halved from 4 (2026-08-24, sharding rollout) — see sourceFromEsArticles's
  // matching comment; up to 6 shards now run this fan-out concurrently.
  const perEntity = await mapWithConcurrency(entityNames, 2, (name) =>
    queryArticlesByEntity(name, dateStart, dateISO, 5).catch((e) => {
      console.error(`sourceFromEsEvergreenArticles: queryArticlesByEntity failed for ${page.page_id} entity="${name}": ${(e as Error).message}`);
      return [];
    })
  );
  const seen = new Set<string>();
  const articles = perEntity.flat().filter((a) => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
  return articles.map((a): Candidate => {
    const slugMatch = a.url.match(/\/([^/]+)\/?$/);
    const key = slugMatch ? slugMatch[1] : a.url;
    return {
      source: "evergreen_search",
      key,
      subject: a.title,
      headline: a.title,
      link: a.url,
      publishedAt: `${dateISO}T12:00:00Z`,
      rawText: a.title,
    };
  });
}

// ⛔ OPERATOR FIX (2026-08-07): "take the evergreen bank from the Facebook
// automation routine and add that too." The bank itself (config/
// evergreen_bank.json) is NOT ready-to-post content — every entry is an
// "angle" whose own schema says "verify_at_runtime: fetch the real, current
// fact... unfetchable → skip." Posting an angle's frame text directly would
// be exactly the fabrication risk the operator explicitly banned a few
// messages ago ("vague things should never go out, must contain proper
// names"). So this doesn't return angles as candidates — it uses a matching
// angle's `frame` as a real search query (via webSearch.ts's shared Claude/
// Grok search, same as every other tier — this used to call Tavily directly
// before the 2026-08-10 migration; comment corrected 2026-08-30, code
// already called webSearch() the whole time), then only real, actually-
// fetched search results (which still pass every downstream gate: named-
// entity, accuracy, link-resolve) become candidates. Matched by subject
// text overlap with this page's own entities/sport_groups, NOT by page_id —
// confirmed live the bank is keyed by Facebook page_ids (p02-p31) with zero
// overlap with Threads page_ids (p35-p61).
async function sourceFromEvergreenBank(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  if (!process.env.VERCEL_AI_GATEWAY_KEY) return [];

  // ⛔ OPERATOR FIX (2026-08-10/11): "make sure fallbacks don't become a
  // roadblocker" — same class of gap as sourceFromSharedPool: this call
  // sits inside sourceCandidatePoolForPage's outer Promise.all, unguarded,
  // so a single S3 read failure here would reject that WHOLE Promise.all
  // and discard every other tier's real, successfully-fetched candidates.
  const rawAngles = await getAllEvergreenAngles().catch((e) => {
    console.error(`sourceFromEvergreenBank: failed to load bank for ${page.page_id}: ${(e as Error).message}`);
    return [];
  });

  // Confirmed live (2026-08-07): the bank mixes at least 3 incompatible
  // shapes (this project's own {subject, frame, ...} angles; a nested
  // {angles: [...]} pre-written-caption format with no URL at all; and bare
  // {angle_id, subject, last_used} tracking stubs with no frame). Only the
  // shape this tier can turn into a real, link-carrying candidate is safe
  // to use — the others are silently skipped rather than crashing on a
  // missing field, same defensive posture as every other S3-read here.
  const angles = rawAngles.filter(
    (a): a is EvergreenAngle => typeof a?.subject === "string" && typeof a?.frame === "string"
  );
  const entityNames = page.entities.map((e) => e.name.toLowerCase());
  const sportGroups = page.sport_groups.map((s) => s.toLowerCase());
  const matching = angles.filter((a) => {
    const subject = a.subject.toLowerCase();
    return entityNames.some((n) => subject.includes(n)) || sportGroups.some((s) => subject.includes(s));
  });
  if (matching.length === 0) return [];

  // Cap at 2 angles per page — this is a supplemental last-resort tier, not
  // a reason to fan out a dozen real search calls for one page.
  const picked = matching.slice(0, 2);
  const resultsPerAngle = await Promise.all(
    picked.map((a) =>
      webSearch(a.frame).catch((e) => {
        console.error(`sourceFromEvergreenBank: query failed for ${page.page_id} (${a.angle_id}): ${(e as Error).message}`);
        return [];
      })
    )
  );
  return await searchResultsToCandidates(resultsPerAngle.flat(), "evergreen_search", dateISO);
}

// ⛔ OPERATOR FIX (2026-08-08, real incident during regeneration): matching
// an ES article by shared ENTITY NAME alone isn't enough to call it
// "same_story" — two NASCAR pages both got a real ES article about Denny
// Hamlin resolved as their "full story" link, but that article was about a
// completely different angle (a driver nickname bit) than their actual
// candidate (Iowa Corn 350 betting odds). Sharing a name is not sharing a
// story. Require real topic overlap — at least one substantial word shared
// between the two headlines, beyond the entity name itself — before an ES
// article counts as covering the SAME story, not just the same person.
//
// ⛔ SECOND FIX, same day: the first version of this check still matched
// "Iowa Corn 350... NASCAR Cup Odds" to the same Denny Hamlin/Zilisch
// article, because both headlines contain "NASCAR" — a word that appears in
// nearly every headline on a NASCAR page and carries zero topic-specific
// signal, exactly as generic as "news" or "update" in this context. A
// page's own sport_groups words (and common league names generally) must be
// excluded from the overlap check the same way the entity name already is,
// or the check silently degrades back into "mentions the same sport."
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "by",
  "for", "with", "from", "as", "is", "are", "was", "were", "his", "her",
  "its", "that", "this", "into", "over", "under", "after", "before", "amid",
  "during", "about", "vs", "news", "update", "says", "reveals",
  "nascar", "nfl", "nba", "mlb", "nhl", "ufc", "mma", "wnba", "cfb", "f1",
  "golf", "tennis", "boxing", "mlb", "college", "football", "basketball",
  "baseball", "cup", "series",
  // ⛔ FIX (2026-08-10, real live incident): generic sports-journalism
  // headline filler — "Islam Makhachev Reacts to Ian Garry's Recent
  // Interviews" got called the SAME STORY as "Islam Makhachev admitted he
  // took a lot from watching Ilia Topuria and Khamzat Chimaev lose" purely
  // because both headlines happen to share one of these boilerplate verbs.
  // None of these carry real topic-identifying signal — they show up in
  // nearly every headline about anyone, the same way "nascar"/"news" did.
  "reacts", "reveals", "admits", "admitted", "opens", "interview", "interviews",
  "recent", "recently", "responds", "reflects", "reflecting", "explains",
  "explained", "comments", "commenting", "speaks", "speaking", "talks",
  "talking", "shares", "sharing", "breaks", "breaking", "opens", "reaction",
]);

function significantWords(text: string, excludeNames: string[]): Set<string> {
  const excluded = new Set(excludeNames.flatMap((n) => n.toLowerCase().split(/\s+/)));
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w) && !excluded.has(w))
  );
}

// ⛔ FIX (2026-08-10, real live incident): a single shared significant word
// was enough to call two headlines about the same recurring named person
// "the same story" — real production incident where an unrelated ES article
// got linked in the reply as if it covered the exact story in the caption.
// Two real, DIFFERENT events about the same person will almost always share
// at least one incidental word; requiring two raises the bar to genuine
// topic overlap while still catching real matches (which typically share
// several: opponent names, event names, specific nouns).
const MIN_SHARED_WORDS_FOR_SAME_STORY = 2;

function sharesRealTopic(headlineA: string, headlineB: string, excludeTerms: string[]): boolean {
  const wordsA = significantWords(headlineA, excludeTerms);
  const wordsB = significantWords(headlineB, excludeTerms);
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared++;
  return shared >= MIN_SHARED_WORDS_FOR_SAME_STORY;
}

// ⛔ OPERATOR FIX (2026-08-12): "both should be absolutely related else do
// not do it... in other cases, put the newsletter subscribe link, not the
// news from a newsletter link." sharesRealTopic above is a cheap word-
// overlap heuristic — real, and already hardened once from a live
// incident, but a bag-of-words count can't actually confirm two headlines
// describe the SAME event rather than two different events that happen to
// share a couple of nouns. This is a hard verification gate on top of it,
// same "specificity only when verifiable" discipline as everywhere else in
// this pipeline: sharesRealTopic is kept as a cheap PRE-FILTER (bounds how
// often this real network/model call runs — only on candidates that
// already look plausible), and this is what actually decides whether the
// match is trusted enough to claim "same_story" in the caption. Defaults
// to false on ANY failure/uncertainty — a wrongly-claimed same-story link
// is worse than falling through to the newsletter subscribe fallback,
// which is always safe because it never claims to be this exact story.
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const SAME_STORY_MODEL = "anthropic/claude-sonnet-4-5";

async function isSameRealStory(headlineA: string, headlineB: string): Promise<boolean> {
  const apiKey = process.env.VERCEL_AI_GATEWAY_KEY;
  if (!apiKey) return false;
  const prompt = [
    `Are these two headlines reporting on the EXACT SAME specific real-world event, not just the same person/team/topic in general?`,
    `Headline A: ${headlineA}`,
    `Headline B: ${headlineB}`,
    `Two different real events about the same person/team (a different game, a different incident, a different statement, even if close in time) are NOT the same story — only answer true if they're clearly describing one single concrete event.`,
    `Output ONLY a JSON object: {"same_story": true} or {"same_story": false}. No markdown, no explanation.`,
  ].join("\n");
  try {
    const res = await fetchWithTimeout(
      GATEWAY_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: SAME_STORY_MODEL,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 30,
          temperature: 0,
        }),
      },
      20_000
    );
    if (!res.ok) return false;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") return false;
    const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(stripped);
    return parsed?.same_story === true;
  } catch (e) {
    console.error(`isSameRealStory: failed: ${(e as Error).message}`);
    return false;
  }
}

// Candidates whose own link is already ES-owned (newsletter, shared_pool,
// es_article) pass through untouched. Only the externally-sourced tiers
// (web_search/social_search/evergreen_search) need resolution — their real
// value is DISCOVERY (a genuinely fresh, real story), never the link itself.
export async function resolveExternalLink(candidate: Candidate, page: PageConfig, dateISO: string): Promise<Candidate | null> {
  // ⛔ OPERATOR FIX (2026-08-13): "make sure most posts use ES articles" —
  // a beehiiv.com URL counts as ES-owned (correct — it's ES's own branded
  // newsletter), so a `beehiiv_newsletter` candidate's own web_url (the
  // EDITION page, not a specific article) always short-circuited this
  // function before it could even try finding a real matching ES article.
  // GA4 has no tracking installed on the Beehiiv-hosted edition pages at
  // all (confirmed live), so every one of these clicks is invisible to us —
  // while a direct essentiallysports.com article link is fully measurable
  // and already proven to convert (Baltimore Ravens: 311 autopost sessions
  // in 2 days). `beehiiv_poll` candidates already skip this bypass (their
  // own link starts as "", not a valid URL) and correctly try a real
  // article match first — this brings newsletter-edition candidates in
  // line with that same, already-proven priority order.
  if (candidate.source !== "beehiiv_newsletter" && isEsOwnedLink(candidate.link)) return candidate;

  // ⛔ OPERATOR FIX (2026-08-08, real production regression): the accuracy
  // gate fetches `link` to verify the claim is real — but once `link` gets
  // swapped to an ES-owned URL below, that's no longer where the fact came
  // from. A page's generic newsletter (the "subscribe" fallback) was NEVER
  // going to mention this specific story, so every subscribe-resolved
  // candidate started failing SOURCE_DOES_NOT_MENTION_SUBJECT — this was the
  // single largest cause of dropped candidates the morning after this
  // shipped (82 of ~200 individual candidate failures in one run alone).
  // `sourceLink` preserves the ORIGINAL discovery URL so the accuracy gate
  // keeps verifying against where the claim actually came from, while
  // `link` (what actually gets posted) stays ES-owned either way.
  const sourceLink = candidate.link;

  // ⛔ OPERATOR FIX (2026-08-18, explicit operator directive: "we still need
  // to get 1k+ sessions anyhow"): this used to only try the page's first 3
  // registered entities — the same class of gap already fixed in
  // sourceFromWebSearch and sourceFromEsArticles. A page with more than 3
  // entities (Golf Syndicate has 15) silently never got a real-article
  // match attempt for the rest, falling through to the generic
  // "subscribe" homepage link instead — a specific "read the full story"
  // link is the one lever already proven to convert (Baltimore Ravens: 311
  // autopost sessions in 2 days, per the comment above), so under-trying
  // it directly costs real clicks. Now fetches all entities' matches in
  // parallel, still checked in the page's own registered priority order so
  // behavior for pages with ≤3 entities is unchanged.
  const entityNames = page.entities.map((e) => e.name);
  const dateStart = new Date(new Date(`${dateISO}T00:00:00Z`).getTime() - 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  // ⛔ OPERATOR FIX (2026-08-23, real live incident): unlike the two other
  // ES-article call sites, this one runs per-CANDIDATE (not just per-page-
  // per-run), making it likely the single largest contributor to ES-MCP's
  // real load spike — also added logging (was a bare swallow) and bounded
  // concurrency for the same reason as sourceFromEsArticles/
  // sourceFromEsEvergreenArticles above.
  // Halved from 4 (2026-08-24, sharding rollout) — this call site runs per-
  // CANDIDATE (the comment above already flags it as the largest single
  // contributor to ES-MCP load), so it's the most sensitive of the three to
  // shards now multiplying concurrent workflow executions system-wide.
  const matchesByEntity = await mapWithConcurrency(entityNames, 2, (name) =>
    queryArticlesByEntity(name, dateStart, dateISO, 5).catch((e) => {
      console.error(`resolveExternalLink: queryArticlesByEntity failed for entity="${name}": ${(e as Error).message}`);
      return [];
    })
  );
  for (let i = 0; i < entityNames.length; i++) {
    const name = entityNames[i];
    const plausibleMatches = matchesByEntity[i].filter((m) => sharesRealTopic(candidate.headline, m.title, [name, ...page.sport_groups]));
    for (const m of plausibleMatches) {
      if (await isSameRealStory(candidate.headline, m.title)) {
        return { ...candidate, link: m.url, linkContext: "same_story", sourceLink };
      }
    }
  }

  // ⛔ OPERATOR FIX (2026-08-15, real live incident, severe): confirmed live
  // — a "subscribe" candidate's link was the SPECIFIC edition's own URL,
  // and Threads renders that edition's REAL headline as the reply's link
  // preview card. A caption about Zay Flowers/Ravens got a reply card
  // reading "49ers QB Rushed to Hospital at Camp" — the same mismatched
  // newsletter edition reused verbatim across Derrick Henry, Zay Flowers,
  // and Lamar Jackson posts on the same page, since "latest edition" never
  // changes topic to match whatever story the caption is actually about.
  // A reader who just read the caption sees a jarring, unrelated headline
  // staring back — exactly the bait-and-switch feel that suppresses clicks,
  // and never a problem manual posting hits since none of its studied posts
  // carried a link at all. The publication's own bare homepage (origin
  // only, no /p/{edition} path) has no single story's headline to clash
  // with — it reads as a real newsletter site, not a random wrong story.
  function toPublicationHomepage(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }

  // ⛔ OPERATOR FIX (2026-08-13): a `beehiiv_newsletter` candidate already
  // carries its OWN real, non-stale edition link (sourceFromNewsletterBroad
  // already checked its freshness) — re-fetching "the latest edition" here
  // instead would wrongly DROP this candidate if that latest edition
  // happens to be stale/missing, even though the candidate's own link is
  // perfectly fine. Only external-sourced candidates (web_search/
  // social_search/evergreen_search, whose own link was never ES-owned to
  // begin with) need this re-fetch — for a newsletter-edition candidate
  // that found no better article match, its own link IS the subscribe
  // fallback already.
  if (candidate.source === "beehiiv_newsletter") {
    return { ...candidate, link: toPublicationHomepage(candidate.link), linkContext: "subscribe", sourceLink };
  }

  // The "subscribe" fallback still needs a REAL, non-placeholder newsletter
  // edition — confirmed live that at least one page's "latest" newsletter is
  // itself seeded test content ("Star Fighter's Brother's..."); framing a
  // link to that as "subscribe for more like this" is just as broken as
  // claiming it's the full story, since the destination is nonsense either way.
  const newsletter = await sourceFromNewsletter(page).catch((e) => {
    console.error(`resolveExternalLink: sourceFromNewsletter fallback failed for ${page.page_id}: ${(e as Error).message}`);
    return null;
  });
  if (newsletter && !isTestMarkerContent(newsletter)) {
    return { ...candidate, link: toPublicationHomepage(newsletter.link), linkContext: "subscribe", sourceLink };
  }

  // ⛔ OPERATOR FIX (2026-08-24, real live incident audit): this is the
  // TERMINAL fallback — returning null here silently drops the candidate
  // with zero trace anywhere, not even a reason code in the run's
  // attemptFailures, unlike every real gate failure elsewhere in the
  // pipeline. Logging the reason (no newsletter fallback available, or the
  // one available was itself seeded test content) at least leaves a
  // findable trace for why a candidate that got this far still vanished.
  console.error(`resolveExternalLink: no genuine ES-owned link available for candidate key=${candidate.key} on ${page.page_id} — dropping`);
  return null; // no genuine ES-owned link available anywhere — this candidate can't post
}

// ⛔ OPERATOR FIX (2026-08-07): replaces the old "pick exactly one candidate,
// drop the page if it fails a gate" flow. The real threads-automation skill
// file's own Step 1 pseudocode sources a whole pool per page and never lets
// a single bad candidate zero out a page's run — dailyRunWorkflow.ts now
// walks this ordered list trying the NEXT candidate whenever one fails a
// deterministic check, so a dead link / no-entity-match / stale-source
// candidate gets swapped out for a better one from the same page's own pool
// instead of the whole page going dark for the run. Order matches the
// existing 70/30 newsletter/shared-pool preference; within the shared pool,
// newest-first is a real-data proxy for the reference pipeline's own
// decay/scoring `best_of()` (which needs the Facebook T0-T2 scoring this
// project doesn't have direct access to).
export async function sourceCandidatePoolForPage(page: PageConfig, dateISO: string, postedLog: PostedLogEntry[]): Promise<Candidate[]> {
  const todaysEntries = postedLog.filter((p) => (p.posted_at || "").startsWith(dateISO));
  const newsletterCount = todaysEntries.filter((p) => p.reply_url?.includes("utm_content=reply_link")).length;
  const preferNewsletter = shouldSourceFromNewsletter(newsletterCount, todaysEntries.length);

  // ⛔ OPERATOR FIX (2026-08-10/11): "we have fallbacks for almost all of
  // them, make sure they don't become a roadblocker." This call ran
  // unguarded, BEFORE the Promise.all of every other tier below — a single
  // Beehiiv API failure here would throw the ENTIRE function immediately,
  // discarding every other tier's real, already-fetched results before
  // they were even requested. A missing/slow newsletter is exactly the
  // kind of single-tier failure the other 6 tiers exist to cover for.
  const newsletterCandidate = await sourceFromNewsletter(page).catch((e) => {
    console.error(`sourceCandidatePoolForPage: newsletter tier failed for ${page.page_id}: ${(e as Error).message}`);
    return null;
  });

  // ⛔ OPERATOR BROADENING (2026-08-10): "make Apify so broad that each
  // tier — ES-MCP, Apify, all — can exist as individual tiers too... very
  // very comprehensive so that nothing is ever short of things." Every
  // sourcing tier below now runs unconditionally, every time, for every
  // page — not gated behind a "the other tiers left this page thin"
  // threshold. Real content from ANY tier is real content; there's no
  // reason to withhold a genuine Twitter/Reddit/evergreen/extra-newsletter
  // candidate just because the always-on tiers already found a few. Cost
  // is bounded the same way it always was: each tier still returns [] fast
  // when it has nothing (no API key, no match, no query), so an empty tier
  // costs one skipped network call, not extra latency.
  // ⛔ OPERATOR REVERSAL (2026-08-12): "apart from ES articles all are high
  // quality, at least we write 100 of them daily... I am ready to bring
  // down the floor to 7 but then quality must be at par with manual
  // posting, no errors allowed." This directly reverses the 2026-08-10
  // "run every tier unconditionally" directive above — every real
  // quality/accuracy incident traced this session (bare-fragment
  // fabrication, low-engagement junk, reply-tweets ripped from threads,
  // betting-picks leaks, off-language content) came from web_search or
  // social_search (Twitter/Reddit). es_article and beehiiv_poll produced
  // zero incidents, matching the real manual/SocialPilot posting pattern
  // for these same accounts (100% real curated news, zero raw social
  // scraping). Twitter/Reddit/Grok-search are no longer run unconditionally
  // — they're a genuine LAST RESORT, only invoked when the safe tiers
  // combined don't clear a real minimum, not an equal-weight alternative
  // source run every time regardless of need.
  const MIN_SAFE_CANDIDATES = 3;

  const [poolCandidates, articleCandidates, newsletterStoryCandidates, pollCandidates, newsletterBroadCandidates, esEvergreenCandidates] =
    await Promise.all([
      sourceFromSharedPool(page, dateISO),
      sourceFromEsArticles(page, dateISO),
      sourceFromNewsletterStories(page).catch((e) => {
        console.error(`sourceCandidatePoolForPage: newsletter-story tier failed for ${page.page_id}: ${(e as Error).message}`);
        return [];
      }),
      sourceFromBeehiivPolls(page, dateISO),
      sourceFromNewsletterBroad(page),
      sourceFromEsEvergreenArticles(page, dateISO),
    ]);

  const postedKeys = new Set(postedLog.map((p) => p.key));
  const safeCandidates = [
    ...poolCandidates,
    ...articleCandidates,
    ...newsletterStoryCandidates,
    ...pollCandidates,
    ...newsletterBroadCandidates,
    ...esEvergreenCandidates,
  ].filter((c) => !postedKeys.has(c.key) && entityOrSportMatch(c, page));

  // ⛔ OPERATOR FIX (2026-08-15, real live incident): "get more from Female
  // Fighters and Baltimore Ravens." Confirmed live for p55 (Fearless Female
  // Fighters, 7 named fighters): its safe candidate pool was consistently
  // FULL of same-sport-but-wrong-subject es_article noise (Mike Tyson,
  // Khabib, Islam Makhachev, Conor McGregor — real MMA news, zero mention
  // of any of p55's actual roster), because entityOrSportMatch's sport-level
  // fallback happily counts these toward MIN_SAFE_CANDIDATES. That silently
  // skipped the web_search/social_search fallback below every single run —
  // the one tier actually capable of finding real, on-topic coverage of
  // Shevchenko/Harrison/Dern/etc. (verified live: a Claude web search for
  // this exact roster returns real, current, on-topic results) — and left
  // requiresNamedEntity to reject all the noise downstream, so the page
  // just went dark instead of ever trying the tier that could have helped.
  // For any page with its own registered named entities, only a candidate
  // that genuinely matches one of THOSE entities (not just the page's
  // broader sport/league) should count toward "safe enough, skip the risky
  // tiers" — noise still stays in the final candidate list as low-priority
  // filler, it just can't mask a real content shortage anymore.
  const genuinelyRelevantCount =
    page.entities.length > 0
      ? safeCandidates.filter((c) => realRegisteredEntityMatches(c, page).length > 0).length
      : safeCandidates.length;

  let riskyCandidates: Candidate[] = [];
  if (genuinelyRelevantCount < MIN_SAFE_CANDIDATES) {
    const [webCandidates, twitterCandidates, redditCandidates] = await Promise.all([
      sourceFromWebSearch(page, dateISO),
      sourceFromTwitter(page, dateISO),
      sourceFromReddit(page, dateISO),
    ]);
    riskyCandidates = [...webCandidates, ...twitterCandidates, ...redditCandidates].filter(
      (c) => !postedKeys.has(c.key) && entityOrSportMatch(c, page)
    );
  }

  // ⛔ OPERATOR FIX (2026-08-27, real live incident, editorial complaint):
  // "10 Funniest Joe Rogan Quotes" / "10 Most Memorable Post Fight
  // Interviews" went live, sourced from evergreen_search — both
  // sourceFromEvergreenBank and sourceFromEvergreenWebSearch ultimately call
  // the same unrestricted webSearch() across the open internet (confirmed by
  // reading both), which surfaced third-party listicle-farm content
  // (thesportster.com) instead of real ES coverage. These two used to sit in
  // the ALWAYS-ON safe tier above, run unconditionally alongside genuinely
  // trustworthy tiers like sourceFromEsArticles — meaning listicle filler
  // could win a slot even when real sport-wide news (sourceFromWebSearch,
  // the RISKY tier right above) was never even tried. Operator directive:
  // "in [the entity's] absence, posts are made on the particular athlete/
  // entity's SPORT'S news, not such rubbish pieces" — i.e. evergreen search
  // must be strictly subordinate to real current news, not an equal-weight
  // peer. Now gated behind safe+risky STILL not clearing the bar, a second,
  // stricter last-resort check — the same MIN_SAFE_CANDIDATES pattern
  // already used to gate the risky tier itself, just re-applied one tier
  // deeper. isListicleFillerContent (checks.ts) stays in place regardless as
  // a defense-in-depth backstop for the rare case this tier still fires.
  let evergreenCandidates: Candidate[] = [];
  const combinedSoFar = [...safeCandidates, ...riskyCandidates];
  const genuinelyRelevantCountAfterRisky =
    page.entities.length > 0
      ? combinedSoFar.filter((c) => realRegisteredEntityMatches(c, page).length > 0).length
      : combinedSoFar.length;
  if (genuinelyRelevantCountAfterRisky < MIN_SAFE_CANDIDATES) {
    const [evergreenBankCandidates, evergreenWebCandidates] = await Promise.all([
      sourceFromEvergreenBank(page, dateISO),
      sourceFromEvergreenWebSearch(page, dateISO),
    ]);
    evergreenCandidates = [...evergreenBankCandidates, ...evergreenWebCandidates].filter(
      (c) => !postedKeys.has(c.key) && entityOrSportMatch(c, page)
    );
  }

  let unposted = [...safeCandidates, ...riskyCandidates, ...evergreenCandidates];

  // ⛔ OPERATOR FIX (2026-08-08): "the source may not be an ES link, but if
  // you find a similar ES article you can use that link, or connect it to
  // the newsletter with a subscribe-style CTA — such posts can go." Every
  // externally-sourced candidate (web_search/social_search/evergreen_search)
  // gets its link resolved to something ES-owned before it's eligible to
  // post — a real ES article about the same subject if one exists, else the
  // page's own newsletter (with linkContext flagging which one, so the
  // caption writer never claims the newsletter covers a story it doesn't).
  // A candidate that resolves to neither is dropped here rather than left to
  // fail LINK_NOT_ES_OWNED downstream with no alternative tried.
  // Bounded rather than an unbounded Promise.all: each resolution issues up to 3
  // warehouse queries, so a page with many external candidates could otherwise
  // open enough simultaneous queries to exhaust the shared account quota. Because
  // resolveExternalLink catches its own query failures, a quota rejection is
  // indistinguishable from "no matching ES article" and the candidate silently
  // falls back to the generic subscribe CTA — so capping concurrency protects
  // output quality as well as spend. Total work and ordering are unchanged.
  unposted = (
    await mapWithConcurrency(unposted, LINK_RESOLUTION_CONCURRENCY, (c) => resolveExternalLink(c, page, dateISO))
  ).filter((c): c is Candidate => c !== null);

  // ⛔ OPERATOR FIX (2026-08-10): "there shouldn't be any ES article left on
  // which we have not created a post" — es_article candidates now sort
  // ahead of every other tier (still newest-first within each group), so a
  // page's own real ES articles get first claim on its limited per-run
  // slots instead of being crowded out by web/social candidates that merely
  // arrived with a later timestamp.
  // ⛔ OPERATOR DIRECTION (2026-08-12): "we would easily hit the floor even
  // if we do post for all ES articles and beehiiv polls — these 2 alone
  // across pages would give us 100 good posts easily." Every single
  // quality/safety incident traced this session came from web_search/
  // social_search — es_article and beehiiv_poll never produced one. Both
  // now rank as the two top-priority tiers (poll just below article, since
  // an article is still real reported news and a poll is a real-but-lighter
  // engagement device), well ahead of every riskier tier, so a page only
  // reaches for Twitter/Reddit/web_search when its two safest, always-real
  // sources are genuinely exhausted for the run — not as an equal-weight
  // alternative to them.
  // ⛔ OPERATOR FIX (2026-08-11): "story selection can be made much much
  // better... some sort of curiosity gap is always needed." A flat
  // numbers-dump candidate (a standings/rankings list) is real and
  // on-topic but has no narrative underneath it for the caption to work
  // with — deprioritize it below a narrative-rich candidate in the SAME
  // pool, without excluding it (it still gets tried if it's genuinely the
  // only content available for a page this run).
  const tierRank = (c: Candidate): number => {
    if (c.source === "es_article") return 2;
    if (c.source === "beehiiv_poll") return 1;
    return 0;
  };
  // ⛔ OPERATOR FIX (2026-08-19, real live incident): "this isn't modest,
  // this is way too low." Confirmed live: the SAME generic, page-agnostic
  // sport-wide es_article (e.g. a Raiders/Chiefs story) was showing up as
  // the ONLY candidate tried for five completely unrelated team pages
  // (Lions, Cowboys, Ravens, Eagles, EssentiallySports Media), all failing
  // NO_NAMED_ENTITY — a real, correct rejection (that story doesn't name
  // any of THEIR roster), but it strongly suggested each page's own
  // genuinely-matching article never got a chance to be TRIED at all.
  // Root cause: this sort only ever ranked by source-tier then recency —
  // sourceFromEsArticles' broad per-sport query returns up to 50 candidates
  // (dominated by whatever's biggest news that sport-wide today), which
  // can easily crowd out an older-but-actually-relevant, page-specific
  // article once MAX_CANDIDATES_PER_PAGE truncates the pool. A candidate
  // that already names one of THIS page's own registered entities is
  // real, specific signal that it's far more likely to actually pass
  // requiresNamedEntity — it must survive the cap ahead of generic
  // same-sport noise, not just whatever happened to publish most recently.
  const hasRealEntityMatch = (c: Candidate): number => (realRegisteredEntityMatches(c, page).length > 0 ? 1 : 0);
  unposted = unposted.sort((a, b) => {
    const entityDiff = hasRealEntityMatch(b) - hasRealEntityMatch(a);
    if (entityDiff !== 0) return entityDiff;
    const rankDiff = tierRank(b) - tierRank(a);
    if (rankDiff !== 0) return rankDiff;
    const aFlat = isFlatStatDump(a) ? 0 : 1;
    const bFlat = isFlatStatDump(b) ? 0 : 1;
    if (aFlat !== bFlat) return bFlat - aFlat;
    return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  });

  // ⛔ OPERATOR FIX (2026-08-13): this candidate is spliced in AFTER
  // `unposted` above already went through resolveExternalLink — without
  // this, the one candidate DESIGNED to win its slot most often
  // (preferNewsletter's 70/30 mix) would always link straight to the
  // unmeasurable Beehiiv edition page, never getting a chance at a real,
  // trackable ES-article match the same way every other tier does.
  const resolvedNewsletterCandidate = newsletterCandidate ? await resolveExternalLink(newsletterCandidate, page, dateISO) : null;
  // ⛔ OPERATOR FIX (2026-08-14): "we need to drive clicks, and more article
  // clicks than newsletter ones." The 70/30 mix above forced the newsletter
  // candidate into the winning slot regardless of what it actually links
  // to — and per the note above this, GA4 has ZERO tracking on Beehiiv
  // edition pages, so a "subscribe" fallback newsletter candidate wins its
  // slot and then generates a click nobody can ever count. A genuine
  // es_article candidate (already top-ranked within `unposted` via
  // tierRank) links to a real, fully-tracked essentiallysports.com page
  // that's already proven to convert. The newsletter candidate still leads
  // when it resolved to a real same-story ES article itself (that's a real
  // trackable article click too, just sourced from this tier), or when no
  // trackable es_article alternative exists this run at all — otherwise a
  // real trackable article wins over an invisible newsletter click.
  const hasTrackableEsArticle = unposted.some((c) => c.source === "es_article" || c.linkContext === "same_story");
  const newsletterIsTrackable = resolvedNewsletterCandidate?.linkContext === "same_story";
  const forceNewsletterFirst = preferNewsletter && (newsletterIsTrackable || !hasTrackableEsArticle);
  const ordered = forceNewsletterFirst ? [resolvedNewsletterCandidate, ...unposted] : [...unposted, resolvedNewsletterCandidate];

  const seen = new Set<string>();
  const deduped = ordered.filter((c): c is Candidate => {
    if (!c || seen.has(c.key)) return false;
    seen.add(c.key);
    return true;
  });

  // ⛔ OPERATOR FIX (2026-08-19, real live incident): sourceCandidatePool's
  // return value is a Temporal ACTIVITY RESULT — it gets serialized into
  // the workflow's own execution history in full, once per page per pass.
  // With today's own additions (multi-angle doubling every ES article,
  // per-story newsletter candidates, wider ES-article date range, several
  // more sourcing tiers) an unbounded pool can genuinely run into the
  // dozens per page — confirmed live this was a real, direct contributor
  // to hitting the run's own history-size safety cap (see
  // MAX_HISTORY_SIZE_BYTES in dailyRunWorkflow.ts) after barely any pages
  // had been processed. `deduped` is already sorted best-first (tierRank,
  // narrative-richness, recency) — real posts overwhelmingly come from the
  // first few candidates anyway; a page genuinely needing its 15th-ranked
  // candidate to find a passing one is the rare case this cap trades away,
  // never the common one, and it directly bounds per-page payload size
  // regardless of how many tiers or angle-variants run in the future.
  const MAX_CANDIDATES_PER_PAGE = 20;
  return deduped.slice(0, MAX_CANDIDATES_PER_PAGE);
}
