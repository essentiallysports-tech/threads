import { PageConfig, Candidate, PostedLogEntry } from "./types";
import { latestConfirmedPost, recentConfirmedPosts, recentPublishedPolls } from "./beehiiv";
import { isFreshEnough, entityOrSportMatch, isEsOwnedLink, isTestMarkerContent, isFlatStatDump } from "./checks";
import { getSharedPool, getAllEvergreenAngles, EvergreenAngle } from "./s3registry";
import { queryRecentArticles, queryArticlesByEntity } from "./esMcp";
import { sourceFromWebSearch, grokWebSearch, searchResultsToCandidates } from "./webSearch";
import { sourceFromTwitter, sourceFromReddit } from "./socialSearch";
import { fetchWithTimeout, mapWithConcurrency } from "./httpUtil";

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
  const posts = await recentConfirmedPosts(pubId, 10).catch(() => []);
  return posts
    .map((post): Candidate => ({
      source: "beehiiv_newsletter",
      key: post.id,
      subject: page.page_name,
      headline: post.title,
      link: post.web_url,
      publishedAt: new Date(post.publish_date * 1000).toISOString(),
      thumbnailUrl: post.thumbnail_url,
      rawText: post.subject_line,
    }))
    .filter((c) => isFreshEnough(c, NEWSLETTER_MAX_AGE_HOURS));
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
export async function sourceFromEsArticles(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  const sports = page.sport_groups.length > 0 ? page.sport_groups : [null];
  const perSport = await Promise.all(
    sports.map((sport) => queryRecentArticles(sport, dateISO, 50).catch(() => []))
  );
  const seen = new Set<string>();
  const articles = perSport.flat().filter((a) => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
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
      grokWebSearch(a.frame).catch((e) => {
        console.error(`sourceFromEvergreenBank: query failed for ${page.page_id} (${a.angle_id}): ${(e as Error).message}`);
        return [];
      })
    )
  );
  return searchResultsToCandidates(resultsPerAngle.flat(), "evergreen_search", dateISO);
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
    const plausibleMatches = matches.filter((m) => sharesRealTopic(candidate.headline, m.title, [name, ...page.sport_groups]));
    for (const m of plausibleMatches) {
      if (await isSameRealStory(candidate.headline, m.title)) {
        return { ...candidate, link: m.url, linkContext: "same_story", sourceLink };
      }
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

  const [poolCandidates, articleCandidates, pollCandidates, newsletterBroadCandidates, evergreenCandidates] = await Promise.all([
    sourceFromSharedPool(page, dateISO),
    sourceFromEsArticles(page, dateISO),
    sourceFromBeehiivPolls(page, dateISO),
    sourceFromNewsletterBroad(page),
    sourceFromEvergreenBank(page, dateISO),
  ]);

  const postedKeys = new Set(postedLog.map((p) => p.key));
  const safeCandidates = [
    ...poolCandidates,
    ...articleCandidates,
    ...pollCandidates,
    ...newsletterBroadCandidates,
    ...evergreenCandidates,
  ].filter((c) => !postedKeys.has(c.key) && entityOrSportMatch(c, page));

  let riskyCandidates: Candidate[] = [];
  if (safeCandidates.length < MIN_SAFE_CANDIDATES) {
    const [webCandidates, twitterCandidates, redditCandidates] = await Promise.all([
      sourceFromWebSearch(page, dateISO),
      sourceFromTwitter(page, dateISO),
      sourceFromReddit(page, dateISO),
    ]);
    riskyCandidates = [...webCandidates, ...twitterCandidates, ...redditCandidates].filter(
      (c) => !postedKeys.has(c.key) && entityOrSportMatch(c, page)
    );
  }

  let unposted = [...safeCandidates, ...riskyCandidates];

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
  unposted = unposted.sort((a, b) => {
    const rankDiff = tierRank(b) - tierRank(a);
    if (rankDiff !== 0) return rankDiff;
    const aFlat = isFlatStatDump(a) ? 0 : 1;
    const bFlat = isFlatStatDump(b) ? 0 : 1;
    if (aFlat !== bFlat) return bFlat - aFlat;
    return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  });

  const ordered = preferNewsletter ? [newsletterCandidate, ...unposted] : [...unposted, newsletterCandidate];

  const seen = new Set<string>();
  return ordered.filter((c): c is Candidate => {
    if (!c || seen.has(c.key)) return false;
    seen.add(c.key);
    return true;
  });
}
