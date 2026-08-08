import { PageConfig, Candidate, PostedLogEntry } from "./types";
import { latestConfirmedPost } from "./beehiiv";
import { isFreshEnough, entityOrSportMatch, isEsOwnedLink, isTestMarkerContent } from "./checks";
import { getSharedPool, getAllEvergreenAngles, EvergreenAngle } from "./s3registry";
import { queryRecentArticles, queryArticlesByEntity } from "./esMcp";
import { sourceFromWebSearch, tavilySearch, tavilyResultsToCandidates } from "./webSearch";
import { sourceFromTwitter, sourceFromReddit } from "./socialSearch";

// ⛔ OPERATOR THROUGHPUT PUSH (2026-08-08): "make sure 150 posts a day is
// hit" — raised from 2 to 4 so the Apify/evergreen last-resort tier fires
// for more pages, not fewer. Still a genuine content-quality lever, not an
// integrity one: this widens how many REAL candidates get sourced per page,
// never loosens what counts as a valid one (named entity, ES-owned link,
// accuracy-verified — none of that changed).
const THIN_POOL_THRESHOLD = 4;

const NEWSLETTER_MIX_TARGET = 0.7; // 70% of posts sourced directly from the newsletter, per operator directive
const NEWSLETTER_MAX_AGE_HOURS = 24 * 5; // a 5-day-old "latest" edition is still a real, usable source; older falls back

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

  const candidate: Candidate = {
    source: "beehiiv_newsletter",
    key: post.id,
    subject: page.page_name,
    headline: post.title,
    link: post.web_url,
    publishedAt: new Date(post.publish_date * 1000).toISOString(),
    thumbnailUrl: post.thumbnail_url,
    rawText: post.subject_line,
  };

  if (!isFreshEnough(candidate, NEWSLETTER_MAX_AGE_HOURS)) return null; // stale edition — let the caller fall back
  return candidate;
}

// The shared T2 pool — the same file the Facebook pipeline's T_POST reads.
// Filtered to this page's own entities/sport_groups by the caller via
// runDeterministicChecks; this just returns real, unfiltered candidates.
export async function sourceFromSharedPool(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  const pool = await getSharedPool(dateISO);
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
export async function sourceFromEsArticles(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  const sport = page.sport_groups[0] || null;
  const articles = await queryRecentArticles(sport, dateISO, 20).catch(() => []);
  return articles.map((a): Candidate => {
    const slugMatch = a.url.match(/\/([^/]+)\/?$/);
    const key = slugMatch ? slugMatch[1] : a.url;
    const publishedAt = a.publishedTime ? `${dateISO}T${a.publishedTime}:00Z` : `${dateISO}T12:00:00Z`;
    return {
      source: "es_article",
      key,
      subject: a.title,
      headline: a.title,
      link: a.url,
      publishedAt,
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
// angle's `frame` as a real Tavily search query, then only real, actually-
// fetched search results (which still pass every downstream gate: named-
// entity, accuracy, link-resolve) become candidates. Matched by subject
// text overlap with this page's own entities/sport_groups, NOT by page_id —
// confirmed live the bank is keyed by Facebook page_ids (p02-p31) with zero
// overlap with Threads page_ids (p35-p61).
async function sourceFromEvergreenBank(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];

  // Confirmed live (2026-08-07): the bank mixes at least 3 incompatible
  // shapes (this project's own {subject, frame, ...} angles; a nested
  // {angles: [...]} pre-written-caption format with no URL at all; and bare
  // {angle_id, subject, last_used} tracking stubs with no frame). Only the
  // shape this tier can turn into a real, link-carrying candidate is safe
  // to use — the others are silently skipped rather than crashing on a
  // missing field, same defensive posture as every other S3-read here.
  const angles = (await getAllEvergreenAngles()).filter(
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
      tavilySearch(a.frame, apiKey).catch((e) => {
        console.error(`sourceFromEvergreenBank: query failed for ${page.page_id} (${a.angle_id}): ${(e as Error).message}`);
        return [];
      })
    )
  );
  return tavilyResultsToCandidates(resultsPerAngle.flat(), "evergreen_search", dateISO);
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

function sharesRealTopic(headlineA: string, headlineB: string, excludeTerms: string[]): boolean {
  const wordsA = significantWords(headlineA, excludeTerms);
  const wordsB = significantWords(headlineB, excludeTerms);
  for (const w of wordsA) if (wordsB.has(w)) return true;
  return false;
}

// Candidates whose own link is already ES-owned (newsletter, shared_pool,
// es_article) pass through untouched. Only the externally-sourced tiers
// (web_search/social_search/evergreen_search) need resolution — their real
// value is DISCOVERY (a genuinely fresh, real story), never the link itself.
export async function resolveExternalLink(candidate: Candidate, page: PageConfig, dateISO: string): Promise<Candidate | null> {
  if (isEsOwnedLink(candidate.link)) return candidate;

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

  const entityNames = page.entities.map((e) => e.name);
  const dateStart = new Date(new Date(`${dateISO}T00:00:00Z`).getTime() - 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  for (const name of entityNames.slice(0, 3)) {
    const matches = await queryArticlesByEntity(name, dateStart, dateISO, 5).catch(() => []);
    const realMatch = matches.find((m) => sharesRealTopic(candidate.headline, m.title, [name, ...page.sport_groups]));
    if (realMatch) {
      return { ...candidate, link: realMatch.url, linkContext: "same_story", sourceLink };
    }
  }

  // The "subscribe" fallback still needs a REAL, non-placeholder newsletter
  // edition — confirmed live that at least one page's "latest" newsletter is
  // itself seeded test content ("Star Fighter's Brother's..."); framing a
  // link to that as "subscribe for more like this" is just as broken as
  // claiming it's the full story, since the destination is nonsense either way.
  const newsletter = await sourceFromNewsletter(page).catch(() => null);
  if (newsletter && !isTestMarkerContent(newsletter)) {
    return { ...candidate, link: newsletter.link, linkContext: "subscribe", sourceLink };
  }

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

  const newsletterCandidate = await sourceFromNewsletter(page);
  // All three tried unconditionally, in parallel — none of these tiers
  // waits on or depends on whether the shared pool actually has anything.
  const [poolCandidates, articleCandidates, webCandidates] = await Promise.all([
    sourceFromSharedPool(page, dateISO),
    sourceFromEsArticles(page, dateISO),
    sourceFromWebSearch(page, dateISO),
  ]);

  const postedKeys = new Set(postedLog.map((p) => p.key));
  let unposted = [...poolCandidates, ...articleCandidates, ...webCandidates].filter(
    (c) => !postedKeys.has(c.key) && entityOrSportMatch(c, page)
  );

  // ⛔ OPERATOR FIX (2026-08-07): "add Apify for Reddit/Twitter if more new
  // stories are needed" — a real scrape job, not called unconditionally.
  // Only reached for when the three always-on tiers left this page thin.
  if (unposted.length < THIN_POOL_THRESHOLD) {
    const [twitterCandidates, redditCandidates, evergreenCandidates] = await Promise.all([
      sourceFromTwitter(page, dateISO),
      sourceFromReddit(page, dateISO),
      sourceFromEvergreenBank(page, dateISO),
    ]);
    unposted = [...unposted, ...twitterCandidates, ...redditCandidates, ...evergreenCandidates].filter(
      (c) => !postedKeys.has(c.key) && entityOrSportMatch(c, page)
    );
  }

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
  unposted = (await Promise.all(unposted.map((c) => resolveExternalLink(c, page, dateISO)))).filter(
    (c): c is Candidate => c !== null
  );

  unposted = unposted.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  const ordered = preferNewsletter ? [newsletterCandidate, ...unposted] : [...unposted, newsletterCandidate];

  const seen = new Set<string>();
  return ordered.filter((c): c is Candidate => {
    if (!c || seen.has(c.key)) return false;
    seen.add(c.key);
    return true;
  });
}
