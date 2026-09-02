// Temporal activities — the ONLY place real I/O happens. Workflow code
// (src/workflows/*) must stay deterministic/replayable, so every network
// call, S3 read/write, and non-deterministic operation (Date.now(), random)
// is wrapped here and invoked from the workflow via proxyActivities.

import { PageConfig, Candidate, PostedLogEntry, PageRunResult, TemplateId } from "../lib/types";
import { loadActiveThreadsPages, getPostedLog, appendPostedLog, writeDryRunResult } from "../lib/s3registry";
import { sourceFromNewsletter, sourceFromSharedPool, shouldSourceFromNewsletter, sourceCandidatePoolForPage } from "../lib/sourcing";
import { factCheckClaim } from "../lib/webSearch";
import {
  runDeterministicChecks,
  linkResolves,
  hasUtm,
  accuracyGate as accuracyGateCheck,
  AccuracyGateResult,
  templatesUsedToday,
  topicFrequencyCheck,
  dominantNarrativeCheck,
  duplicateStoryCheck,
  DuplicateStoryCheckResult,
  matchedSportGroup,
  matchedEntityNames,
  realRegisteredEntityMatches,
  extractSimilarPlayerName,
  extractNameFromArticle,
  isGenericFramingText,
  FrequencyCheckResult,
  classifyCaptionAgeTone,
} from "../lib/checks";
import { buildReplyLink, buildTopicHashtag } from "../lib/caption";
import { buildNarrativeCaptionText } from "../lib/narrativeCaption";
import { buildNarrativeRenderCopy, chooseLayoutViaAI, isGenuineComparisonViaAI, isCoherentHeadlineViaAI, factsFor } from "../lib/narrativeRenderSpec";
import { scheduleThreadsPost, stripHashtagFromPost, hashtagStripVerified } from "../lib/postiz";
import { searchImages, metadataMatchesSubject } from "../lib/esMcp";
import { fetchWithTimeout } from "../lib/httpUtil";
import { renderCardViaAi } from "../lib/renderChain";
import { RenderSpec } from "../lib/renderSpec";
import { verifyCardText } from "../lib/cardTextQC";
import { extractEntitiesViaAI } from "../lib/entityResolution";

// Card dimensions match the render spec's 3:4 portrait — kept here (not in
// cardRegistry, which was Orshot-specific and is no longer part of the
// render path); other modules (composite.ts, cardRegistry.ts) still need
// this target size.
export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1440;

// ⛔ OPERATOR FIX (2026-08-07): "why the same blue and white breaking
// template — in the threads routine templates were so goated." Root cause:
// kicker/accent were only ever branched on isTradeStory — every other story,
// regardless of which of the 5 layouts chooseTemplate picked, rendered the
// same "BREAKING" kicker in the same blue. Palette below is lifted from the
// real ES-LIC-Playbook-2026 Canva spec (Section 11 — Ink/Teal/Red/Gold is
// the actual brand system, not a guess), mapped one-to-one onto layout so a
// hero/milestone card, a dramatic-news card, and a standard editorial card
// are visibly different cards, not the same card with different words.
const ACCENT_HEX_TRADE = "E10600"; // red — urgency, matches trade-rumor drama
const PALETTE_BY_LAYOUT: Record<TemplateId, string> = {
  hero: "C8A24B", // gold — milestone/record/hero, matches the playbook's tribute/list gold
  dramatic_news: "E10600", // red — urgency, single-subject breaking drama
  standard_editorial: "00B2A9", // teal — the default brand accent, not an urgency color
  // Reuses hero's gold rather than inventing a new hex — the playbook (cited
  // above) only defines Ink/Teal/Red/Gold, and gold is already the
  // tribute/legacy-coded color in this system; retro/nostalgia content is
  // the same coding, not a genuinely new visual category.
  retro: "C8A24B",
  comparison: "00B2A9", // teal — head-to-head, VS mark takes the visual drama instead of color
  quote: "00B2A9", // teal — quote mark + attribution, photo stays untouched
};

// ⛔ OPERATOR FIX (2026-08-10, real live incident — screenshot of a p-nba
// post): "rather than UPDATE or anything in the strip below, all posts must
// contain full detail in reply / subscribe newsletter below — the post's CTA
// should also be there in the strip." The kicker bar used to carry a story-
// category label (TRADE RUMORS/BREAKING/MILESTONE/UPDATE) that told the
// reader nothing actionable and, worse, didn't match what the caption
// actually promises. The kicker bar now ALWAYS carries the real CTA — the
// exact same promise the caption's own closing line makes (see caption.ts/
// narrativeCaption.ts's `linkContext === "subscribe"` branch) — so the
// on-image strip and the caption's CTA are never two different claims. This
// is deterministic, not AI-reasoned (see narrativeRenderSpec.ts): a CTA is
// the same fixed message every time, not something that benefits from
// per-story reasoning the way the headline/accent word do.
// ⛔ OPERATOR FIX (2026-08-12): "rather than SUBSCRIBE FOR MORE it should
// have 'Join our Golf Newsletter, Link Below' or 'Join our MMA Newsletter,
// link below.'" ⛔ OPERATOR CORRECTION (same day): "not derived from the
// page's own sport but newsletter name" — the label names the actual
// NEWSLETTER'S subject, not the page's registered sport_group (a page and
// its shared newsletter can genuinely differ — e.g. Boxing Bulletin's own
// focus is boxing, but the shared newsletter across all 4 combat pages is
// branded "Essentially MMA"). Keyed by the real Beehiiv publication_id
// (confirmed live against the actual publication list + operator
// confirmation per-newsletter, 2026-08-12) rather than guessed from the
// newsletter's own name text, since several ("Lucky Dog on Track,"
// "Buckeye Daily," "Essentially Dunk," "Essentially W") don't parse to a
// sport name programmatically at all.
const NEWSLETTER_SPORT_LABELS: Record<string, string> = {
  "pub_a85e9aab-5fc5-4008-bdc3-bc5391a29908": "Golf", // Essentially Golf
  "pub_60817e5f-dfe8-4612-8b99-4c9c32f5afa9": "MMA", // Essentially MMA
  "pub_637cd589-a9aa-4e46-b886-a830b9ab6a6e": "College Football", // Essentially CFB
  "pub_a6e7942b-ad94-4396-b72a-81beecc3f321": "NFL", // The Huddle
  "pub_7c3e742b-f222-4e7c-ac6e-ca3b1a6b59fa": "MLB", // Essentially Dugout
  "pub_3af5e2b3-fd36-4b8b-b63f-453e7ac1c579": "NASCAR", // Lucky Dog on Track
  "pub_3451ca03-fb01-4e74-adcf-3cd802a94d48": "College Football", // Buckeye Daily
  "pub_c1c47f34-85aa-4498-aa12-2784789f3ad0": "NBA", // Essentially Dunk
  "pub_0a9d3b9e-3f42-4067-8fe3-8943c200fdd8": "WNBA", // Essentially W
  // pub_902529ab (EssentiallySports Daily) deliberately omitted — genuinely
  // cross-sport, gets the "Daily" phrasing below instead of a sport name.
};
const DAILY_NEWSLETTER_PUB_ID = "pub_902529ab-962e-41b8-b981-e9a33d055a65";

function chooseKicker(candidate: Candidate, page: PageConfig): string {
  if (candidate.linkContext !== "subscribe") return "FULL STORY IN REPLY";
  const pubId = page.threads?.beehiiv_publication_id;
  if (pubId === DAILY_NEWSLETTER_PUB_ID) return "JOIN OUR DAILY NEWSLETTER, LINK BELOW";
  const sport = pubId ? NEWSLETTER_SPORT_LABELS[pubId] : undefined;
  return sport ? `JOIN OUR ${sport.toUpperCase()} NEWSLETTER, LINK BELOW` : "SUBSCRIBE FOR MORE";
}

// ⛔ OPERATOR FIX (2026-08-07, real live incidents): blindly truncating a
// headline at 6 words cut mid-quote twice on real posts — "Not as
// Formidable as I Once Thought" → card showed "NOT AS FORMIDABLE AS I ONCE"
// (lost "THOUGHT"), and "We Don't Get to Live in the Past" → card showed
// "WE DON'T GET TO LIVE IN" (lost "THE PAST"). A headline built around a
// quote is a genuinely different case: cutting it produces a sentence
// fragment that reads as broken, not just shorter — completeness matters
// more than the 6-word convention for these. Detect and prefer the full
// quoted phrase; only apply the hard word cap to non-quote headlines.
const QUOTED_PHRASE_RE = /["“]([^"”]{8,90})["”]/;

function extractQuotedPhrase(headline: string): string | null {
  const match = headline.match(QUOTED_PHRASE_RE);
  return match ? match[1].trim() : null;
}

// ⛔ OPERATOR FIX (2026-08-08, real live incidents): the quote fix above
// only covered headlines with a literal quoted phrase — every OTHER
// headline was still blindly cut at 6 raw words, which produced dangling
// fragments on real posts just as broken as the quote cases: "Deion
// Sanders Takes Colorado On The" (cut right before "Road"), "Could
// Shaquille O'Neal Staying With the" (ends on a bare article), "2026 Iowa
// Corn 350 Betting Odds:" (ends on a colon with nothing after it). A
// 6-word count with no regard for where the words actually break produces
// nonsense about as often as it produces something readable — checked
// against the 11 real headlines from this run, 9 of 11 were broken this
// way. Three real fixes, applied in order:
const LABEL_PREFIX_RE = /^([A-Za-z0-9 .]{2,20}):\s+/; // "ESPN: ...", "Iowa Corn 350 2026: ..." — a short source/date label, not part of the actual headline
const CLAUSE_SPLIT_RE = /\s+[—–-]\s+/; // em/en-dash or " - " splitting a complete main clause from a subhead
const TRAILING_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "by",
  "for", "with", "from", "as", "is", "are", "was", "were", "his", "her",
  "its", "that", "this", "into", "over", "under", "after", "before",
  "amid", "during", "about", "vs", "vs.",
]);
// ⛔ OPERATOR FIX (2026-08-15, real live incident): a real card shipped
// "Vrabel Refuses to Give Up Major" — the truncated headline ends on
// "major," a dangling adjective that needs a noun after it ("Major"
// WHAT?). TRAILING_STOPWORDS only ever covered articles/prepositions/
// conjunctions; it has no concept of an adjective/intensifier that reads
// as unfinished without whatever noun it was modifying. This is a curated
// list of the same failure mode with a different part of speech — common
// escalating/intensifying words that appear right before a noun in this
// pipeline's real headlines, never a coherent way to end one.
const DANGLING_MODIFIERS = new Set([
  "major", "massive", "huge", "biggest", "big", "key", "critical", "new",
  "next", "final", "latest", "surprise", "historic", "significant",
  "record-breaking", "shocking", "stunning", "official", "important",
  "exclusive", "breaking", "first", "last", "top", "worst", "best",
]);

function stripLabelPrefix(headline: string): string {
  const match = headline.match(LABEL_PREFIX_RE);
  return match ? headline.slice(match[0].length) : headline;
}

// Never returns a string ending on a dangling article/preposition/etc. —
// extends word-by-word past maxWords (up to a hard ceiling) until it lands
// on a real content word, or exhausts the headline. A slightly longer,
// coherent line beats a shorter, broken one.
function truncateAtWordBoundary(text: string, maxWords: number, hardCeiling: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  let end = maxWords;
  while (end < words.length && end < hardCeiling) {
    const last = words[end - 1].replace(/[^a-zA-Z'-]/g, "").toLowerCase();
    const endsInPunctuation = /[:;,]$/.test(words[end - 1]);
    if (!TRAILING_STOPWORDS.has(last) && !DANGLING_MODIFIERS.has(last) && !endsInPunctuation) break;
    end++;
  }
  return words.slice(0, end).join(" ").replace(/[:;,]+$/, "");
}

function shortHeadline(headline: string, maxWords = 6): string {
  const quoted = extractQuotedPhrase(headline);
  if (quoted) return quoted; // complete quote, never truncated — a cut quote is worse than a longer one

  const withoutLabel = stripLabelPrefix(headline);

  const clauseParts = withoutLabel.split(CLAUSE_SPLIT_RE);
  if (clauseParts.length > 1 && clauseParts[0].trim().split(/\s+/).length <= maxWords + 4) {
    // The main clause before the dash is already a complete, reasonably
    // short thought (e.g. "Ohio State has a difficult 2026 schedule") —
    // use it whole rather than cutting into it or the subhead after it.
    return clauseParts[0].trim();
  }

  return truncateAtWordBoundary(withoutLabel, maxWords, maxWords + 6);
}

// ⛔ OPERATOR FIX (2026-08-07, same incidents): `accent` was the last word of
// the athlete's own name ("Jalen Hurts" -> "Hurts", "Aaron Judge" -> "Judge")
// — a coincidental real word that, rendered right under a truncated quote,
// read as if it were the sentence's own final word ("...LIVE IN HURTS",
// "...ONCE JUDGE"). An accent word must never come from a person's name.
// ⛔ OPERATOR FIX (2026-08-07, second live incident): the fallback used to
// be the kicker word itself — which meant a card with no genuine power word
// rendered "UPDATE" twice (once as the "accent word", once as the kicker
// bar), reading as a rendering glitch. Pulls a genuine power word from the
// headline (same vocabulary the real LIC playbook uses — Section 7's power-
// word bank) when the story actually has one; returns null otherwise, so
// renderSpec.ts omits the accent-word line entirely rather than duplicate
// the kicker.
const POWER_WORD_RE =
  /\b(blasts?|slams?|fires? back|clash(?:es)?|feud|no mercy|calls? out|robbed|snubbed|betrayed|stripped|denied|chaos|mayhem|stunning|erupts?|explodes?|hospitalized|injured|scary|collapses?|confirmed|exposed|banned|suspended|retires?|done|over|fine|slashed|jackpot)\b/i;

// ⛔ OPERATOR FIX (2026-08-11, real live incident): "LAKERS FACE LUKA DONCIC
// EXIT WARNING" rendered a redundant standalone "WARNING" above a headline
// that already ends in "...EXIT WARNING" — because this used to scan the
// RAW candidate.headline for a power word while the card's actual headline
// text is the separately-truncated shortHeadline() output; the matched
// word could survive truncation (fine) or not (silent mismatch) with
// nothing checking either way. Must be called with the EXACT text that
// will render as the headline, so any match is a literal word already
// inside it by construction — never a word found somewhere else in the
// original headline that then gets rendered as if it were part of this
// shortened one.
function chooseAccentWord(renderedHeadline: string): string | null {
  const match = renderedHeadline.match(POWER_WORD_RE);
  return match ? match[0].toUpperCase() : null;
}

export async function loadPages(): Promise<PageConfig[]> {
  return loadActiveThreadsPages();
}

export async function loadPostedLog(pageId: string): Promise<PostedLogEntry[]> {
  return getPostedLog(pageId);
}

// Picks ONE candidate for this page per the 70/30 newsletter/shared-pool mix,
// falling back to shared pool if the newsletter edition is missing/stale.
export async function sourceOneCandidate(page: PageConfig, dateISO: string, postedLog: PostedLogEntry[]): Promise<Candidate | null> {
  // Confirmed live: real posted-log entries can be missing `posted_at`
  // entirely — defend the same way dailyRunWorkflow.ts does.
  const todaysEntries = postedLog.filter((p) => (p.posted_at || "").startsWith(dateISO));
  const newsletterCount = todaysEntries.filter((p) => p.reply_url?.includes("utm_content=reply_link")).length; // best-effort tag
  const preferNewsletter = shouldSourceFromNewsletter(newsletterCount, todaysEntries.length);

  if (preferNewsletter) {
    const fromNewsletter = await sourceFromNewsletter(page);
    if (fromNewsletter) return fromNewsletter;
  }

  const pool = await sourceFromSharedPool(page, dateISO);
  if (pool.length > 0) return pool[0];

  // Newsletter was the preferred tier and had nothing usable — still try it
  // as a fallback before giving up entirely.
  if (!preferNewsletter) {
    const fromNewsletter = await sourceFromNewsletter(page);
    if (fromNewsletter) return fromNewsletter;
  }

  return null;
}

// ⛔ OPERATOR FIX (2026-08-07): the ordered replacement for sourceOneCandidate
// in the actual run loop — see sourcing.ts's sourceCandidatePoolForPage for
// why a single candidate per page could zero out the whole page on one bad
// gate. sourceOneCandidate above is kept only because nothing else still
// calls it; new call sites should use this.
export async function sourceCandidatePool(page: PageConfig, dateISO: string, postedLog: PostedLogEntry[]): Promise<Candidate[]> {
  return sourceCandidatePoolForPage(page, dateISO, postedLog);
}

export interface CheckedCandidate {
  candidate: Candidate;
  pass: boolean;
  reason: string | null;
}

// Runs every deterministic check EXCEPT the cross-run mass-duplicate one
// (that needs a Map shared across the whole run, which can't cross the
// activity/workflow boundary — see workflows/dailyRunWorkflow.ts, which
// enforces it as a run-level hard stop, not a per-candidate drop).
export async function checkCandidate(candidate: Candidate, page: PageConfig, postedLog: PostedLogEntry[]): Promise<CheckedCandidate> {
  const result = runDeterministicChecks(candidate, page, postedLog);
  return { candidate, ...result };
}

// Deterministic accuracy-gate approximation (see checks.ts's own comment on
// why this isn't full per-claim LLM fact-checking) — freshness + "does the
// linked source's fetched text actually mention the matched subject."
//
// ⛔ OPERATOR FIX (2026-08-18, real live incident): "facetcheck using grok
// websearch so that nothing poor goes out." The deterministic checks above
// never verify the CLAIM itself — only that a link resolves and mentions a
// name. Added a genuine live re-verification (webSearch.ts's
// factCheckClaim) for web_search/evergreen_search specifically — the two
// tiers with no inherent ES editorial trust, and the exact tiers every real
// accuracy incident this session traced back to. es_article/beehiiv_* are
// ES's own real content and skip this (same trust boundary the rest of the
// pipeline already draws).
export async function checkAccuracy(candidate: Candidate, primaryEntityName: string | null, maxAgeHours: number): Promise<AccuracyGateResult> {
  const deterministic = await accuracyGateCheck(candidate, primaryEntityName, maxAgeHours);
  if (!deterministic.pass) return deterministic;

  if (candidate.source === "web_search" || candidate.source === "evergreen_search") {
    const factCheck = await factCheckClaim(candidate);
    if (!factCheck.verified) {
      return { pass: false, reason: `FACT_CHECK_FAILED:${factCheck.reason}` };
    }
  }
  return deterministic;
}

// ⛔ OPERATOR FIX (2026-08-08): "do what is left" — topic-frequency and
// dominant-narrative caps from the reference skill file, never built until
// now. Both are pure functions over the posted log (see checks.ts), wrapped
// as activities only because proxyActivities is how workflow code calls
// into lib/ here — no real I/O in either.
export async function checkTopicFrequency(
  candidate: Candidate,
  page: PageConfig,
  primaryEntityName: string | null,
  postedLog: PostedLogEntry[]
): Promise<FrequencyCheckResult> {
  const sportGroup = matchedSportGroup(candidate, page);
  // ⛔ OPERATOR FIX (2026-08-23): with N entities, a perfectly EVEN split
  // still gives each a 1/N share — dominantNarrativeCheck's >25% threshold
  // is unsatisfiable until N>=4, so a 2 or 3-entity page is just as
  // structurally guaranteed to fail as a literal single-entity one. Same
  // reasoning for the sport-group league cap on a single-sport-group page.
  return topicFrequencyCheck(primaryEntityName, sportGroup, postedLog, page.entities.length <= 3, page.sport_groups.length <= 1);
}

export async function checkDominantNarrative(primaryEntityName: string | null, postedLog: PostedLogEntry[], page: PageConfig): Promise<FrequencyCheckResult> {
  return dominantNarrativeCheck(primaryEntityName, postedLog, page.entities.length <= 3);
}

// ⛔ OPERATOR FIX (2026-08-24, real live incident, severe): see
// checks.ts's duplicateStoryCheck for the full incident — the SAME page
// posting the SAME real-world event twice within hours, reworded, uncaught
// by any link-based dedup because the links/sources genuinely differ. A
// real activity (not local) because it makes a real AI-gateway call.
export async function checkDuplicateStory(
  candidate: Candidate,
  primaryEntityName: string | null,
  postedLog: PostedLogEntry[]
): Promise<DuplicateStoryCheckResult> {
  return duplicateStoryCheck(candidate, primaryEntityName, postedLog);
}

export interface LinkVerification {
  finalLink: string | null; // null means UTM_MISSING — caller must drop the candidate, never post a bare link
  resolves: boolean;
  hasUtmTag: boolean;
}

export async function verifyAndTagLink(candidate: Candidate, page: PageConfig): Promise<LinkVerification> {
  const link = buildReplyLink(candidate, page); // null if this page has no registered utm_string — a real, expected outcome, not an error
  if (!link) return { finalLink: null, resolves: false, hasUtmTag: false };
  const resolves = await linkResolves(candidate.link); // verify the underlying article/edition, not the UTM'd copy
  return { finalLink: link, resolves, hasUtmTag: hasUtm(link) };
}

// ⛔ OPERATOR FIX (2026-08-07): "captions should be descriptive and cause
// intrigue... captions should narrate the story," not restate the headline
// in 3-4 generic lines. Real narrative writing needs a real model call — see
// narrativeCaption.ts for the full rationale and the deterministic policy
// checks its output must pass before use. Falls back to the old templated
// buildCaption on any failure; never blocks a post over this.
export async function buildCaptionText(candidate: Candidate, page: PageConfig, athleteNames: string[]): Promise<string> {
  const result = await buildNarrativeCaptionText(candidate, page, athleteNames);
  if (result.usedFallback) {
    console.error(`buildCaptionText: fell back to templated caption for ${page.page_id} (${result.violation})`);
  }
  return result.text;
}

// Renders a card fully within this worker — ES-MCP search -> Cloudinary
// crop -> Orshot render. Confirmed live (2026-08-06) that all three have
// genuine portable REST access (ES-MCP via a static bearer token from its
// own self-serve endpoint, Orshot via its documented API key), closing the
// architectural gap that previously forced a separate MCP-only Routine +
// S3 job-queue handoff (see git history / README "Known gaps" for that
// retired design). No MCP session, no polling, no separate Routine.
//
// `athleteNames` is computed deterministically by the WORKFLOW (via
// checks.matchedEntityNames) before this is called — which athlete/team
// photo(s) to search for is a decided fact by the time this activity runs,
// never this function's own judgment call.
//
// Hard rule (mirrors the old Facebook skill's rule #22, "every post needs
// BOTH a real photo AND real on-image text — one half only is a hard
// fail"): if ES-MCP has no photo for ANY of the given names, this returns
// null — never substitutes a generic/unrelated stock image.
// Several ranked candidates per term (not just the top result) — confirmed
// live 2026-08-06 that ES-MCP's #1 result is sometimes a "moment" shot
// (handshake, sideline conversation) with two people's faces similarly
// sized, which no crop math can cleanly resolve to one subject; trying
// candidates in ES-MCP's own ranked order (via pickPhoto) skips those.
// Pool size bumped 5 -> 12 (2026-08-07): the stricter face-containment
// check in pickPhoto now rejects more candidates (any photo whose subject
// is too close to the source photo's own edge to give a full-face crop),
// so a shallow pool can run out of good options and fall through to a
// much worse-fit candidate further down ES-MCP's ranking (confirmed live:
// a "Micah Parsons trade rumors" card fell back to an old Penn State
// family portrait once the top action shots got rejected). More
// candidates per term means more chances to find one that's BOTH
// correctly-ranked AND passes the face-visibility requirement.
// `sportHint` (the page's own primary sport_group) is appended to the
// ES-MCP QUERY only — never to the name used for metadataMatchesSubject's
// verification below. Mirrors webSearch.ts's existing, already-proven fix
// for the exact same risk on the text-search tier ("a bare name search...
// can surface an unrelated same-named person; adding the page's own sport
// keeps results scoped to what this page is actually about") — ES-MCP's
// photo search had the identical bare-name-collision exposure and was
// simply never given the same guard.
// ⛔ OPERATOR FIX (2026-08-25, real live incident): a page's own registered
// entity keywords already encode its expected team/context (e.g. Shohei
// Ohtani's keywords include "dodgers") — this just looks it up by name so
// searchAndPick can pass it to metadataMatchesSubject's conflicting-team
// check. Returns [] (not a guess) when no confident entity match is found,
// which correctly leaves the extra check disabled for that call rather
// than risk a false "expected nothing" rejection.
function expectedTeamKeywordsFor(name: string, page: PageConfig): string[] {
  const lower = name.toLowerCase();
  const entity = page.entities.find((e) => e.name.toLowerCase() === lower || e.keywords.some((k) => k.toLowerCase() === lower));
  return entity ? entity.keywords : [];
}

// ⛔ OPERATOR CHANGE (2026-08-29): Cloudinary preprocessing removed from the
// render path per operator direction — ES-MCP photos now go straight to
// OpenArt's image2image call. This drops Cloudinary's face-detection-based
// checks (rejecting group/zero-face photos, guaranteeing the face isn't
// clipped, reserving headline space) — ES-MCP's own relevance ranking is
// the only remaining signal for "is this the right photo," same trust
// pickPhoto's own 2026-08-06 revert already placed in that ranking for
// SUBJECT correctness. This still HEAD-checks each candidate in ranked
// order (mirrors esMcp.ts's searchOneImage) so an unreachable URL doesn't
// reach OpenArt, but no longer verifies face count, framing, or crop safety.
// ⛔ OPERATOR FIX (2026-08-29, real live incident): confirmed live via a real
// user report (coloradoprimetime_) — the same Deion Sanders photo used
// across many consecutive posts despite ES-MCP returning several real
// alternatives. Root cause: this always returned the FIRST reachable
// candidate in ES-MCP's own ranked order, and nothing anywhere tracked
// "already used this on this page recently" — a clean, always-reachable
// top-ranked photo wins every single time, forever. Rolling window (last
// RECENT_PHOTO_WINDOW posts, not calendar days — same reasoning as
// isQuoteQuotaDue's rolling window) so cadence-heavy pages don't need a
// bigger window than slow ones. Still prefers a repeat over nothing: if
// every real candidate has recently been used, the least-bad option is a
// repeat photo, not a dropped post.
const RECENT_PHOTO_WINDOW = 15;

function recentlyUsedPhotoUrls(postedLog: PostedLogEntry[]): Set<string> {
  return new Set(
    [...postedLog]
      .filter((p) => p.posted_at && p.source_photo_url)
      .sort((a, b) => new Date(b.posted_at!).getTime() - new Date(a.posted_at!).getTime())
      .slice(0, RECENT_PHOTO_WINDOW)
      .map((p) => p.source_photo_url!)
  );
}

async function pickReachableUrl(candidateUrls: string[], recentlyUsed: Set<string> = new Set()): Promise<string | null> {
  const reachableButRecentlyUsed: string[] = [];
  for (const url of candidateUrls) {
    try {
      const head = await fetchWithTimeout(url, { method: "HEAD" }, 10_000);
      if (!head.ok) continue;
      if (!recentlyUsed.has(url)) return url;
      reachableButRecentlyUsed.push(url);
    } catch {
      // unreachable — try the next ranked candidate
    }
  }
  // ⛔ OPERATOR FIX (2026-08-31, real live incident — p61 Colorado Prime
  // Time, the "Deion Sanders" search): every fresh candidate was
  // unreachable/exhausted — a repeat beats no photo at all, but always
  // falling back to the SAME first-ranked stale candidate reproduced one
  // photo over and over once a page's real usable photo pool (after HEAD
  // checks + recency filtering) was smaller than its post cadence needed —
  // search ranking for a fixed query is stable, so "first reachable stale
  // one" was the same URL almost every call. Rotate through the whole
  // stale-but-reachable set instead of always index 0 — same fix shape
  // already proven on the sibling Facebook pipeline's image dedup (see
  // [[es-image-dedup-v2]]: "no rotation... picks result #1... same photo").
  // Date.now() is fine here — this is activity code, not workflow code, so
  // it isn't subject to Temporal's replay-determinism requirement.
  if (reachableButRecentlyUsed.length === 0) return null;
  return reachableButRecentlyUsed[Date.now() % reachableButRecentlyUsed.length];
}

async function searchAndPick(term: string, recentlyUsed: Set<string>, sportHint?: string, expectedTeamKeywords?: string[]) {
  const query = sportHint ? `${term} ${sportHint}` : term;
  const results = await searchImages(query, "agency", 12);
  if (results.length === 0) return null;
  // Drop candidates whose own title/caption clearly names a different
  // subject than what we searched for (see metadataMatchesSubject's
  // 2026-08-11 comment) — ES-MCP's ranking still decides ORDER among
  // whatever survives this filter. The team-conflict check (2026-08-25) only
  // engages when we have real, confident expected-team keywords to check
  // against — never turns into a positive requirement for pages/entities
  // where none were found.
  const teamCheck = expectedTeamKeywords?.length ? { sportGroup: sportHint, expectedTeamKeywords } : undefined;
  const verified = results.filter((r) => metadataMatchesSubject(r, term, teamCheck));
  if (verified.length === 0) return null; // every candidate's own metadata contradicts the subject we searched for
  return pickReachableUrl(verified.map((r) => r.url), recentlyUsed);
}

// ⛔ OPERATOR FIX (2026-08-07): "MANDATORY TEMPLATE VARIETY — rotate through
// the full approved set, don't default to the same one or two" (ported from
// ES-Threads-Automation-Skill-v1.md), because every prior live post picked
// the same binary quote/breaking layout regardless of story shape. Eligible
// templates are chosen from the story's own shape (two matched entities vs
// one, trade/suspension-style drama vs milestone-style vs plain news); among
// those eligible, the one used LEAST today for this page wins — identical
// no-repeat-until-exhausted logic to the reference skill file's rule.
// ⛔ OPERATOR FIX (2026-08-08): "do what is left" — the reference skill
// file's quote quota ("at least 1 in 8 posts uses the QUOTE template when a
// real quote exists") was never enforced, only made possible. Checked
// against the page's last 8 posted entries REGARDLESS of date (a rolling
// window, not a daily one — the rule is about consistency over the last 8
// posts, not "today"). Only forces quote when this candidate can actually
// support it (2+ subjects AND a genuine quoted phrase) — never fabricates
// a quote card out of a story that doesn't have one.
function isQuoteQuotaDue(postedLog: PostedLogEntry[]): boolean {
  const lastEight = [...postedLog]
    .filter((p) => p.posted_at)
    .sort((a, b) => new Date(b.posted_at!).getTime() - new Date(a.posted_at!).getTime())
    .slice(0, 8);
  if (lastEight.length < 8) return false; // not enough history yet to say the quota's been missed
  return !lastEight.some((p) => p.template === "quote");
}

// ⛔ OPERATOR ARCHITECTURE CHANGE (2026-08-12): "give template selection to
// Claude as well." Two real, verified names (headlineNames — the
// structural gate stays deterministic, since a comparison card physically
// needs two real photos) used to be an automatic green light for
// comparison/quote regardless of whether the STORY itself is actually
// about their rivalry — see isGenuineComparisonViaAI's own comment for
// the two real incidents this closes. Only asks the question when there
// genuinely are 2+ verified names to ask about; a single-subject story
// never pays for this call.
async function chooseTemplate(
  candidate: Candidate,
  page: PageConfig,
  headlineNames: string[],
  hasRealQuote: boolean,
  postedLog: PostedLogEntry[],
  dateISO: string
): Promise<TemplateId> {
  const genuineComparison =
    headlineNames.length >= 2 ? await isGenuineComparisonViaAI(candidate, page, headlineNames[0], headlineNames[1]) : false;
  // ⛔ OPERATOR FIX (2026-08-31, policy): "dramatic_news" is this pipeline's
  // urgency layout — red accent, high-drama lighting, built for "firings/
  // suspensions/trades/controversy" (see narrativeRenderSpec.ts's own
  // description of it). It was being selected by headline keyword alone,
  // with no check on whether the story was actually current — a resurfaced
  // months-old trade rumor got the identical breaking-news visual treatment
  // as a live one. Only offer it when classifyCaptionAgeTone says this is
  // genuinely current (<=48h, or unconfirmed-but-recent); otherwise fall
  // back to the already-neutral standard_editorial/hero layouts.
  const ageTone = classifyCaptionAgeTone(candidate);
  const isCurrent = ageTone === "current";
  const eligible: TemplateId[] =
    genuineComparison
      ? ["comparison", "quote"]
      // ⛔ OPERATOR ADD (2026-08-31, policy): genuinely old content (6+
      // months, or evergreen archive content of unconfirmed age) now gets
      // its own visual treatment, not just a neutral fallback layout — see
      // renderSpec.ts/narrativeRenderSpec.ts's "retro" entries. Forced as
      // the ONLY eligible option (no AI layout-pick call needed) so retro
      // content always renders retro, no ambiguity.
      : ageTone === "retro"
      ? ["retro"]
      : /trade|fired|suspended|banned|benched|cut\b/i.test(candidate.headline) && isCurrent
      ? ["dramatic_news", "standard_editorial"]
      : /record|milestone|career|retire|hall of fame|history|legend/i.test(candidate.headline)
      ? ["hero", "standard_editorial"]
      : isCurrent
      ? ["standard_editorial", "dramatic_news", "hero"]
      : ["standard_editorial", "hero"];

  if (eligible.includes("quote") && hasRealQuote && isQuoteQuotaDue(postedLog)) return "quote";

  const counts = new Map<string, number>();
  for (const t of templatesUsedToday(postedLog, dateISO)) counts.set(t, (counts.get(t) || 0) + 1);

  let best = eligible[0];
  let bestCount = counts.get(best) ?? 0;
  for (const t of eligible.slice(1)) {
    const c = counts.get(t) ?? 0;
    if (c < bestCount) {
      best = t;
      bestCount = c;
    }
  }

  if (eligible.length <= 1) return best;
  const countsObj: Record<string, number> = {};
  for (const [k, v] of counts) countsObj[k] = v;
  return chooseLayoutViaAI(candidate, page, eligible, countsObj, best);
}

// ⛔ OPERATOR OVERRIDE (2026-08-07): Orshot is REMOVED from this pipeline
// entirely — the render chain is OpenArt -> OpenAI -> Gemini (renderChain.ts),
// matching the sibling es-automation-engine-backend repo's own explicit rule
// ("Pillow and Orshot are banned as card builders"). "The threads templates"
// referenced here means renderSpec.ts's deterministic PROMPT template, not
// any Orshot visual template.
//
// The two-entity "quote" spec only makes sense when the story genuinely HAS
// two distinct entities — most candidates are plain single-subject news
// with nobody to put in that role. Hero/speaker (or the single subject)
// each get their OWN Cloudinary upload+crop — never reuse one entity's
// tight face-crop as another entity's full-bleed background (confirmed
// live: that stretched a tiny cropped region to fill the whole canvas and
// rendered as blur/black mush).
export interface RenderCardResult {
  cardUrl: string | null;
  template: TemplateId | null;
  sourcePhotoUrl?: string | null;
  // ⛔ OPERATOR FIX (2026-08-12, real live incident): "still the same errors
  // repeating" — the AI-priority entity fix only corrected the PHOTO search
  // term inside this function. The workflow's own `primaryEntity` (used for
  // topic-frequency/dominant-narrative capping AND the entity field written
  // to the posted log) is computed separately, upstream, from the OLD
  // regex-fallback-inclusive `matchedEntityNames` — never touched by that
  // fix, so garbage entities ("Forced To," "Bold Ian") kept getting logged
  // and kept feeding frequency caps even after the photo itself was fixed.
  // Exposing the SAME correctly-resolved value computed inside this
  // function lets the workflow use it for logging too, without a second
  // AI call or a workflow-level activity restructure.
  resolvedEntity: string | null;
}

// ⛔ OPERATOR FIX (2026-08-08, real live incident): a card rendered "DEION
// SANDERS TOOK HIS COLORADO BUFFALOES" — text this pipeline never computed
// or sent, meaning the AI image model itself paraphrased/garbled the
// on-image text independent of anything in our own headline/accent/quote
// logic. No amount of fixing OUR text computation catches that class of
// failure — only actually looking at the rendered pixels does. Real
// vision-model check (cardTextQC.ts) after every render.
// ⛔ OPERATOR FIX (2026-08-16, real live incident, explicit operator
// directive): this used to retry with a second full render attempt on a
// text-QC failure. Per-post budget is a fixed 7 credits — no do-overs.
// Combined with the render-chain's own now-removed per-path rerolls
// (renderChain.ts), this outer x2 loop stacked into up to ~10 real
// generation attempts for a single post, confirmed live via OpenArt's
// creation history. Now a single render, a single QC check — pass posts,
// fail drops the candidate (caller moves to the next one in the pool).
// The render deadline still bounds that one attempt so a slow/hanging call
// can't stall the run for pages queued behind it.
const RENDER_DEADLINE_MS = 3 * 60_000;

async function renderAndVerifyText(spec: RenderSpec, pageId: string): Promise<string | null> {
  const deadline = Date.now() + RENDER_DEADLINE_MS;
  const outcome = await renderCardViaAi(spec, deadline);
  if (!outcome.card_url) {
    console.error(`renderAndVerifyText: produced no card for ${pageId}: ${JSON.stringify(outcome.render_attempts)}`);
    return null;
  }
  const qc = await verifyCardText(outcome.card_url, spec.is_quote ? spec.quote_text || "" : spec.headline, spec.kicker, spec.accent, spec.photo_subjects);
  if (qc.pass) return outcome.card_url;
  console.error(`renderAndVerifyText: failed text-QC for ${pageId}: ${qc.reason}`);
  return null;
}

// ⛔ OPERATOR FIX (2026-08-08, activating p44 "EssentiallySports Media"): a
// "national" roundup page has no registered athlete/team list to match
// against (see checks.ts's requiresNamedEntity exemption), so athleteNames
// is always empty for it — falling back to page_theme text ("General
// multi-sport ES-branded coverage...") as the photo search term would
// search ES-MCP for that literal phrase instead of a real person, returning
// garbage or nothing. The story's own headline almost always names a real
// person/team (that's what NO_NAMED_ENTITY-adjacent gates elsewhere already
// lean on) — a simple consecutive-capitalized-words heuristic pulls that
// out directly from the text actually being posted about, which is a far
// better search term than the page's own static theme description.
export async function renderCard(
  candidate: Candidate,
  page: PageConfig,
  athleteNames: string[],
  postedLog: PostedLogEntry[],
  dateISO: string
): Promise<RenderCardResult> {
  // ⛔ OPERATOR FIX (2026-08-12, real live incident): "when I told entity to
  // be determined by Anthropic only, why do such issues still occur?" Root
  // cause: this AI gate used to check `athleteNames.length === 0` — but
  // `athleteNames` is `matchedEntityNames`'s result, which ALREADY includes
  // its own regex-guess fallback (extractSimilarPlayerName) baked in. Every
  // time that regex guessed something — right OR wrong ("Bold Ian",
  // "Forced To") — athleteNames.length was NOT 0, so the AI check below
  // never ran at all. The AI was only ever consulted when the regex found
  // literally nothing, never when it found something wrong — the opposite
  // of "AI determines the entity." `realRegisteredEntityMatches` is the
  // OTHER signal: real, guaranteed hits against this page's own registered
  // roster, with NO regex-guess fallback mixed in. The AI now runs whenever
  // there's no guaranteed-real match, regardless of what the regex fallback
  // guessed — matching the actual operator directive.
  const realMatches = realRegisteredEntityMatches(candidate, page, { includeRawText: false });
  const hasRealEntityMatch = realMatches.length > 0;
  // ⛔ OPERATOR ARCHITECTURE CHANGE (2026-08-11): "deterministic code isn't
  // able to choose which entity to pick from... claude has full context so
  // that can easily pick up what entity is needed." Tried BEFORE the regex
  // heuristics below since a model reading the whole story is exactly what
  // catches the class of mistake regex can't ("He Is", "Sophie Targets"
  // both read as plausible names to a pattern-matcher, never to something
  // that actually understands the sentence). See entityResolution.ts for
  // the hallucination-safety verification this result is put through
  // before ever reaching here.
  // ⛔ OPERATOR FIX (2026-08-13, real live incident): "why is fight between
  // still picked up as entity when entity was being picked by Anthropic?"
  // The single-entity extraction below used to be the ONLY AI call here —
  // any story that turned out to need TWO subjects (a comparison/quote
  // card) fell straight to the pure-regex `matchedEntityNames` path further
  // down, which the AI never touched at all. `extractEntitiesViaAI` returns
  // up to 2 verified names so the SAME AI judgment now drives both the
  // single-subject search term AND `headlineNames` (comparison/quote
  // entity resolution) below — closing that gap at the source instead of
  // patching another regex stopword.
  const aiEntitiesResult = !hasRealEntityMatch
    ? await extractEntitiesViaAI(candidate, page).catch((e) => {
        console.error(`renderCard: extractEntitiesViaAI failed for ${page.page_id}: ${(e as Error).message}`);
        return undefined;
      })
    : undefined;
  const aiEntities = Array.isArray(aiEntitiesResult) && aiEntitiesResult.length > 0 ? aiEntitiesResult : null;
  // ⛔ OPERATOR FIX (2026-08-12, real live incident): "MLB Pro Ejected
  // Without Even Playing" — a story that genuinely never names who was
  // ejected — got "Pro Ejected" invented as a fake name by the regex
  // fallback below anyway, because a real AI "no entity" judgment was
  // indistinguishable from "AI didn't run" and so got second-guessed by a
  // less reliable heuristic. An empty (but defined) array means the AI DID
  // run and confirmed there's no real depictable subject — that must be
  // trusted, never overridden by regex.
  const aiConfirmedNoEntity = !hasRealEntityMatch && Array.isArray(aiEntitiesResult) && aiEntitiesResult.length === 0;
  const headlineFallback = aiEntities || aiConfirmedNoEntity ? null : extractSimilarPlayerName(candidate);
  // ⛔ OPERATOR FIX (2026-08-10, real live incident): "5x NBA Champion Dies
  // at 86" — a real newsletter title with no name in it at all — left
  // headlineFallback null, which used to fall straight to the page's
  // generic theme text as the photo search term. The linked article
  // itself almost always names the actual person even when the teaser
  // headline doesn't; only fetched when genuinely needed (the registered-
  // entity match, the AI extraction, AND the headline heuristic all came up
  // empty — and only when the AI never actually ruled out a subject).
  const articleFallback =
    !hasRealEntityMatch && !aiEntities && !aiConfirmedNoEntity && !headlineFallback ? await extractNameFromArticle(candidate) : null;
  // When the AI has actively confirmed no real subject exists, searchTerms
  // stays empty on purpose — never fall back to the page's generic theme
  // text either, which would just repeat the same mistake with a
  // different fake query. An empty searchTerms flows into the "no person
  // depicted, clean typographic card" path renderSpec.ts already supports.
  // Priority: a real registered-roster match (free, reliable) wins outright;
  // otherwise the AI's judgment wins over the regex guess, not the other
  // way around — the whole point of this fix.
  const searchTerms = aiConfirmedNoEntity
    ? []
    : hasRealEntityMatch
    ? athleteNames
    : [aiEntities?.[0] || headlineFallback || articleFallback || page.page_theme.split(/[.,—-]/)[0].trim()];
  const isTradeStory = /trade/i.test(candidate.headline);
  const hasRealQuote = extractQuotedPhrase(candidate.headline) !== null;
  // ⛔ OPERATOR FIX (2026-08-10, real live incidents): an Islam Makhachev
  // post about HIM watching Topuria/Chimaev lose rendered a VS card against
  // Khabib, and a Chase Elliott post about a NASCAR broadcast deal rendered
  // a VS card against an unrelated driver — neither story is actually a
  // comparison. Root cause: `athleteNames`/`searchTerms` (broad, includes
  // names only mentioned in the fetched article body) fed `subjectCount`,
  // so any second registered name dropped anywhere in rawText made the
  // comparison/quote layout structurally "eligible." Whether this is
  // GENUINELY a two-subject story must be judged from the headline alone —
  // the actual claim being made — not from incidental body-text mentions.
  // Same priority order as searchTerms above: a real registered-roster
  // match wins outright; otherwise the AI's judgment (which can identify
  // TWO real subjects for a genuine head-to-head) wins over the pure-regex
  // guess; regex is the last resort only when the AI never ran at all (no
  // gateway key, infra failure) — never when it ran and found nothing.
  const headlineNames = hasRealEntityMatch
    ? realMatches
    : aiEntities
    ? aiEntities
    : aiConfirmedNoEntity
    ? []
    : matchedEntityNames(candidate, page, { includeRawText: false });
  const template = await chooseTemplate(candidate, page, headlineNames, hasRealQuote, postedLog, dateISO);
  const kicker = chooseKicker(candidate, page);
  // ⛔ OPERATOR FIX (2026-08-31, policy): isTradeStory is a pure headline
  // keyword check, independent of chooseTemplate's age-aware layout pick —
  // without this guard, a retro-toned trade throwback would still get
  // slammed with the urgent red trade color on top of the sepia/vintage
  // "retro" template, an internally contradictory card.
  const accentHex = isTradeStory && template !== "retro" ? ACCENT_HEX_TRADE : PALETTE_BY_LAYOUT[template];

  const recentPhotos = recentlyUsedPhotoUrls(postedLog);

  if ((template === "comparison" || template === "quote") && headlineNames.length >= 2) {
    const [subjectPhoto, speakerPhoto] = await Promise.all([
      searchAndPick(headlineNames[0], recentPhotos, page.sport_groups[0], expectedTeamKeywordsFor(headlineNames[0], page)),
      searchAndPick(headlineNames[1], recentPhotos, page.sport_groups[0], expectedTeamKeywordsFor(headlineNames[1], page)),
    ]);
    if (subjectPhoto && speakerPhoto) {
      // ⛔ OPERATOR FIX (2026-08-08, real live incident): quote_text used to
      // be the ENTIRE raw headline (e.g. '"I don't pay women off" –
      // Shaquille O'Neal denied Kobe Bryant's hush-money claim to police'),
      // not just the quoted words — so the card rendered the full run-on
      // sentence as "the quote" AND repeated the speaker's name again in
      // the attribution line below it. quote_text must be ONLY the actual
      // quoted phrase. If the headline has no real quoted phrase at all,
      // this was never a genuine quote story — downgrade to the comparison
      // layout instead of forcing a quote card with nothing to quote.
      const quotedPhrase = extractQuotedPhrase(candidate.headline);
      const isQuote = template === "quote" && quotedPhrase !== null;
      // A quote card's own prompt (renderSpec.ts) never reads headline/
      // accent/kicker at all — only quote_text/quote_attribution, which stay
      // deterministic (extracted verbatim, never AI-paraphrased). Only the
      // comparison layout's copy is worth a real reasoning pass.
      const comparisonHeadline = shortHeadline(candidate.headline);
      const copy = isQuote
        ? { headline: comparisonHeadline, accent: chooseAccentWord(comparisonHeadline), kicker, story_type: "quote exchange" }
        : await buildNarrativeRenderCopy(candidate, page, athleteNames, "comparison", {
            headline: comparisonHeadline,
            accent: chooseAccentWord(comparisonHeadline),
            kicker,
            story_type: "head-to-head comparison",
          });
      const spec: RenderSpec = {
        page_id: page.page_id,
        headline: copy.headline,
        accent: copy.accent,
        kicker: copy.kicker,
        story_type: copy.story_type,
        layout: isQuote ? "quote" : "comparison",
        accent_hex: accentHex,
        photo_subjects: [headlineNames[0], headlineNames[1]],
        reference_photo_url: subjectPhoto,
        is_quote: isQuote,
        quote_text: isQuote ? quotedPhrase : null,
        quote_attribution: isQuote ? headlineNames[1] : null,
      };
      // ⛔ OPERATOR FIX (2026-08-20, real live incident): last-resort safety
      // net — narrativeRenderSpec.ts's own retry loop already rejects this
      // shape, but a real story can still land here via the deterministic
      // isQuote branch above (never AI-checked) or after the AI's retries
      // are exhausted. Never render a card whose actual on-image headline
      // is a generic aggregator-title label — fall through to the single-
      // entity path below exactly like a failed photo search would.
      // ⛔ OPERATOR FIX (2026-08-20, real live incident): same reasoning as
      // the generic-framing check above — a headline that reads as two
      // unrelated facts stitched together can also reach here via the
      // deterministic isQuote branch (never AI-checked) or after
      // buildNarrativeRenderCopy's own retries are exhausted.
      if (!isGenericFramingText(spec.headline) && (await isCoherentHeadlineViaAI(spec.headline, factsFor(candidate, headlineNames)))) {
        const cardUrl = await renderAndVerifyText(spec, page.page_id);
        if (cardUrl) return { cardUrl, template: spec.layout, resolvedEntity: headlineNames[0] || null, sourcePhotoUrl: subjectPhoto };
      } else {
        console.error(`renderCard: headline QC failed on comparison spec for ${page.page_id}: "${spec.headline}"`);
      }
    }
    // Fell through to single-entity spec below if either search failed, or
    // every render path failed — never post a two-person layout with an
    // unrelated/missing second photo.
  }

  // searchTerms is empty ONLY when the AI already confirmed no real
  // depictable subject exists — never attempt a photo search on nothing
  // (that's how "Pro Ejected" got invented in the first place). A story
  // with a genuine subject but a failed photo search is still dropped
  // below, same as before — this only skips the search itself when there
  // was never a real subject to search for.
  const photo =
    searchTerms.length > 0
      ? await searchAndPick(searchTerms[0], recentPhotos, page.sport_groups[0], expectedTeamKeywordsFor(searchTerms[0], page))
      : null;
  if (searchTerms.length > 0 && !photo) return { cardUrl: null, template: null, resolvedEntity: null }; // no real photo found for this candidate — never fabricate one

  // ⛔ OPERATOR FIX (2026-08-12): "use the MLB sport image or the team logo
  // rather than fabricating an image." When there's genuinely no person to
  // depict, ground the card in a real league logo/generic sport image
  // instead of an AI-invented scene.
  // ⛔ OPERATOR FIX (2026-08-12, same day): "the audience is fans — a wrong
  // image gets reported straight away." This path shipped without the
  // same metadata verification every player-photo search already has —
  // filter candidates the exact same way searchAndPick does before
  // accepting one, so a mislabeled or wrong-league logo can't slip through
  // just because nothing here was checking.
  const genericSearchTerm = page.sport_groups[0] || page.page_theme;
  const genericPhoto =
    searchTerms.length === 0
      ? await searchImages(`${genericSearchTerm} logo`, "all", 8)
          .then((results) => results.filter((r) => metadataMatchesSubject(r, genericSearchTerm)))
          .then((verified) => pickReachableUrl(verified.map((r) => r.url), recentPhotos))
          .catch((e) => {
            console.error(`renderCard: generic logo search failed for ${page.page_id}: ${(e as Error).message}`);
            return null;
          })
      : null;

  // The layout may fall back here (its photo search failed) — no kicker
  // recompute needed since the kicker is now the CTA (chooseKicker above),
  // never a layout-dependent story-category label.
  const singleLayout: TemplateId = template === "comparison" || template === "quote" ? "standard_editorial" : template;
  const singleAccentHex = isTradeStory && singleLayout !== "retro" ? ACCENT_HEX_TRADE : PALETTE_BY_LAYOUT[singleLayout];
  const singleHeadline = shortHeadline(candidate.headline);
  const singleCopy = await buildNarrativeRenderCopy(candidate, page, athleteNames, singleLayout, {
    headline: singleHeadline,
    accent: chooseAccentWord(singleHeadline),
    kicker,
    story_type: isTradeStory ? "trade rumor" : singleLayout.replace(/_/g, " "),
  });
  const spec: RenderSpec = {
    page_id: page.page_id,
    headline: singleCopy.headline,
    accent: singleCopy.accent,
    kicker: singleCopy.kicker,
    story_type: singleCopy.story_type,
    layout: singleLayout,
    accent_hex: singleAccentHex,
    photo_subjects: searchTerms.length > 0 ? [searchTerms[0]] : [],
    reference_photo_url: photo || genericPhoto || null,
    is_quote: false,
    quote_text: null,
    quote_attribution: null,
  };

  // ⛔ OPERATOR FIX (2026-08-20, real live incidents): "Dallas Goedert News &
  // Updates", "Penei Sewell Stats, News and Video" — the on-image headline
  // independently regressed to a generic aggregator-title label even though
  // the real story/caption was fine. This is the terminal path (no further
  // fallback after this) — never render and post a card whose only reason
  // for existing is to announce that content about this person exists,
  // same "never post garbage" standard as NO_CARD_RENDER_FAILED.
  if (isGenericFramingText(spec.headline)) {
    console.error(`renderCard: GENERIC_HEADLINE_FRAMING on single-entity spec for ${page.page_id}: "${spec.headline}"`);
    return { cardUrl: null, template: null, resolvedEntity: null };
  }
  // ⛔ OPERATOR FIX (2026-08-20, real live incident): "NFL Stars Defy HC,
  // Tennis Prodigy" — an incoherent headline that reached this terminal
  // path (no further fallback after this). Same "never post garbage"
  // standard as the generic-framing check above.
  if (!(await isCoherentHeadlineViaAI(spec.headline, factsFor(candidate, searchTerms)))) {
    console.error(`renderCard: INCOHERENT_HEADLINE on single-entity spec for ${page.page_id}: "${spec.headline}"`);
    return { cardUrl: null, template: null, resolvedEntity: null };
  }

  const cardUrl = await renderAndVerifyText(spec, page.page_id);
  if (!cardUrl) return { cardUrl: null, template: null, resolvedEntity: null };
  return { cardUrl, template: singleLayout, resolvedEntity: searchTerms[0] || null, sourcePhotoUrl: photo || genericPhoto || null };
}

export async function postToThreads(
  page: PageConfig,
  mainPostHtml: string,
  cardUrl: string | null,
  replyLinkHtml: string,
  postTimeUtc: string,
  primaryEntity: string | null,
  sportGroup: string | null
): Promise<{ id: string }> {
  if (process.env.LIVE_POSTING !== "true") {
    throw new Error("postToThreads called while LIVE_POSTING is not 'true' — this should never happen, the workflow must gate this itself");
  }
  const integrationId = page.threads!.postiz_integration_id;

  // ⛔ OPERATOR FIX (2026-08-20, real live incident — see postToThreads
  // history): the write-then-delete design previously left the hashtag OFF
  // entirely unless the unverified strip endpoint was confirmed, on the
  // theory that "a hashtag stuck visible would be worse than not trying."
  // That assumption is now disproven by direct live comparison against real
  // manual SocialPilot posts on the SAME Threads account: every manual post
  // carries 2-4 visible hashtags (#Ravens #RavensNation #RavensFlock) and
  // drew ~13 likes, while our hashtag-less automated posts in the same
  // window drew 1 like each — and this account has only 184 followers, so a
  // hashtag-less post has no discovery path beyond that tiny follower base.
  // A visible hashtag is not a cosmetic defect; it's the actual Threads
  // discovery surface. Always append it when available; only attempt the
  // (still-unverified) strip cleanup afterward, never gate appending on it.
  const wantsHashtagRegistration = page.threads?.topic_registration && page.threads?.hashtag_logic === "write_then_delete";
  const hashtag = wantsHashtagRegistration ? buildTopicHashtag(primaryEntity ? [primaryEntity] : [], sportGroup) : null;
  // ⛔ OPERATOR FIX (2026-08-24, real live incident audit): confirmed live —
  // manual posts on this page's own account (Ohio State Wireline) carry a
  // fixed, repeated branded set on every post ("#GoBucks #BuckeyeNation
  // #ohiostatefootball"), building an accumulating community/brand signal.
  // Our per-story hashtag above is real and does matter (see the comment
  // just above this one), but it's a DIFFERENT tag every post — never
  // repeats, never builds that same signal. Append the page's own confirmed
  // branded set alongside it; falls back to just the per-story tag (existing
  // behavior) if the combined string doesn't fit the char limit below.
  const brandedTags = page.threads?.branded_hashtags?.length ? page.threads.branded_hashtags.join(" ") : null;
  const fullHashtags = [hashtag, brandedTags].filter(Boolean).join(" ") || null;
  const withHashtag = fullHashtags ? `${mainPostHtml} ${fullHashtags}` : mainPostHtml;

  // ⛔ OPERATOR FIX (2026-08-23, real live incident): confirmed live —
  // narrativeCaption.ts's trimToFit already fills mainPostHtml as tightly as
  // possible up to the page's own char_limit (deliberately, to maximize
  // substance per post), then the 2026-08-20 "always append the hashtag"
  // fix above adds another 15-20+ chars with ZERO re-check against the real
  // limit — confirmed root cause of a live Postiz 400 on p48 (Baltimore
  // Ravens): "post is too long, please fix it". The caption pipeline's own
  // length guarantee was real at the point it was made; this call site
  // silently invalidated it. Re-validate the ACTUAL final post text right
  // before it's sent, and drop the hashtag (not the caption body — the real
  // content is what matters) if appending it would overflow the limit.
  // Threads' own real hard cap is 500; a page's configured char_limit is
  // never higher than that, so it's the correct ceiling to check against.
  const hardLimit = page.threads?.char_limit ?? 500;
  // Three-tier fallback so a too-long branded set never costs the per-story
  // hashtag too: full (per-story + branded) -> per-story only -> none.
  const dynamicOnly = hashtag ? `${mainPostHtml} ${hashtag}` : mainPostHtml;
  let postHtml = withHashtag;
  if (postHtml.length > hardLimit) postHtml = dynamicOnly;
  if (postHtml.length > hardLimit) postHtml = mainPostHtml;
  if (postHtml !== withHashtag) {
    console.error(
      `postToThreads: dropped ${postHtml === dynamicOnly ? "branded hashtags" : "all hashtags"} for ${page.page_id} — "${withHashtag}" was ${withHashtag.length} chars, over the ${hardLimit} limit`
    );
  }
  const canStrip = postHtml === withHashtag && hashtag && hashtagStripVerified();

  const posted = await scheduleThreadsPost(integrationId, postHtml, cardUrl, replyLinkHtml, new Date(postTimeUtc));

  if (canStrip) {
    try {
      await stripHashtagFromPost(posted.id, integrationId, mainPostHtml);
    } catch (e) {
      // Never fail the whole post over a cosmetic follow-up step — the
      // hashtag staying visible is a minor discoverability/cleanliness miss,
      // not a reason to lose an otherwise-successful post.
      console.error(`postToThreads: hashtag strip failed for ${page.page_id} (post ${posted.id}): ${(e as Error).message}`);
    }
  }

  return posted;
}

export async function recordPosted(pageId: string, entry: PostedLogEntry): Promise<void> {
  await appendPostedLog(pageId, entry);
}

export async function saveDryRunResults(dateISO: string, results: PageRunResult[]): Promise<void> {
  await writeDryRunResult(dateISO, results);
}
