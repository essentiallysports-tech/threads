// Temporal activities — the ONLY place real I/O happens. Workflow code
// (src/workflows/*) must stay deterministic/replayable, so every network
// call, S3 read/write, and non-deterministic operation (Date.now(), random)
// is wrapped here and invoked from the workflow via proxyActivities.

import { PageConfig, Candidate, PostedLogEntry, PageRunResult, TemplateId } from "../lib/types";
import { loadActiveThreadsPages, getPostedLog, appendPostedLog, writeDryRunResult } from "../lib/s3registry";
import { sourceFromNewsletter, sourceFromSharedPool, shouldSourceFromNewsletter, sourceCandidatePoolForPage } from "../lib/sourcing";
import {
  runDeterministicChecks,
  linkResolves,
  hasUtm,
  accuracyGate as accuracyGateCheck,
  AccuracyGateResult,
  templatesUsedToday,
  topicFrequencyCheck,
  dominantNarrativeCheck,
  matchedSportGroup,
  FrequencyCheckResult,
} from "../lib/checks";
import { buildReplyLink, buildTopicHashtag } from "../lib/caption";
import { buildNarrativeCaptionText } from "../lib/narrativeCaption";
import { scheduleThreadsPost, stripHashtagFromPost, hashtagStripVerified } from "../lib/postiz";
import { searchImages } from "../lib/esMcp";
import { pickPhoto, cropTo } from "../lib/cloudinary";
import { renderCardViaAi } from "../lib/renderChain";
import { RenderSpec } from "../lib/renderSpec";
import { verifyCardText } from "../lib/cardTextQC";

// Card dimensions match the render spec's 3:4 portrait — kept here (not in
// cardRegistry, which was Orshot-specific and is no longer part of the
// render path) since photo cropping still needs a target size.
export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1440;

// Wide enough to give a full-bleed hero real context (not a stretched
// mugshot); tight enough that a busy crowd shot still reads as one subject.
const HERO_FACE_MULTIPLIER = 12;
// Head-to-waist framing for the small circular inset.
const INSET_FACE_MULTIPLIER = 6;

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
  comparison: "00B2A9", // teal — head-to-head, VS mark takes the visual drama instead of color
  quote: "00B2A9", // teal — quote mark + attribution, photo stays untouched
};

// Kicker vocabulary keyed to what the story actually is, not a hardcoded
// "BREAKING" default — mirrors the playbook's power-word bank (Section 7):
// different real triggers get a different, specific kicker word.
function chooseKicker(candidate: Candidate, layout: TemplateId): string {
  const h = candidate.headline;
  if (/trade/i.test(h)) return "TRADE RUMORS";
  if (/fired|suspended|banned|benched|cut\b/i.test(h)) return "BREAKING";
  if (/record|milestone|career|retire|hall of fame|history|legend/i.test(h)) return "MILESTONE";
  if (layout === "comparison") return "HEAD-TO-HEAD";
  if (layout === "dramatic_news") return "BREAKING";
  return "UPDATE"; // standard editorial default — not every story is "breaking"
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
    const last = words[end - 1].replace(/[^a-zA-Z']/g, "").toLowerCase();
    const endsInPunctuation = /[:;,]$/.test(words[end - 1]);
    if (!TRAILING_STOPWORDS.has(last) && !endsInPunctuation) break;
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

function chooseAccentWord(headline: string): string | null {
  const match = headline.match(POWER_WORD_RE);
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
export async function checkAccuracy(candidate: Candidate, primaryEntityName: string | null, maxAgeHours: number): Promise<AccuracyGateResult> {
  return accuracyGateCheck(candidate, primaryEntityName, maxAgeHours);
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
  return topicFrequencyCheck(primaryEntityName, sportGroup, postedLog);
}

export async function checkDominantNarrative(primaryEntityName: string | null, postedLog: PostedLogEntry[]): Promise<FrequencyCheckResult> {
  return dominantNarrativeCheck(primaryEntityName, postedLog);
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
async function searchAndPick(term: string, faceHeightMultiplier: number) {
  const results = await searchImages(term, "agency", 12);
  if (results.length === 0) return null;
  return pickPhoto(results.map((r) => r.url), CARD_WIDTH, CARD_HEIGHT, faceHeightMultiplier);
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

function chooseTemplate(candidate: Candidate, subjectCount: number, hasRealQuote: boolean, postedLog: PostedLogEntry[], dateISO: string): TemplateId {
  const eligible: TemplateId[] =
    subjectCount >= 2
      ? ["comparison", "quote"]
      : /trade|fired|suspended|banned|benched|cut\b/i.test(candidate.headline)
      ? ["dramatic_news", "standard_editorial"]
      : /record|milestone|career|retire|hall of fame|history|legend/i.test(candidate.headline)
      ? ["hero", "standard_editorial"]
      : ["standard_editorial", "dramatic_news", "hero"];

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
  return best;
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
}

// ⛔ OPERATOR FIX (2026-08-08, real live incident): a card rendered "DEION
// SANDERS TOOK HIS COLORADO BUFFALOES" — text this pipeline never computed
// or sent, meaning the AI image model itself paraphrased/garbled the
// on-image text independent of anything in our own headline/accent/quote
// logic. No amount of fixing OUR text computation catches that class of
// failure — only actually looking at the rendered pixels does. Real
// vision-model check (cardTextQC.ts) after every render; one regenerate
// attempt on failure, then treat as no card — matches the reference skill
// file's own "MANDATORY TEXT-QC... regenerate → retry → DROP" rule, which
// existed only as a slide of rendered card_url before this.
async function renderAndVerifyText(spec: RenderSpec, pageId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await renderCardViaAi(spec);
    if (!outcome.card_url) {
      console.error(`renderAndVerifyText: attempt ${attempt + 1} produced no card for ${pageId}: ${JSON.stringify(outcome.render_attempts)}`);
      continue;
    }
    const qc = await verifyCardText(outcome.card_url, spec.is_quote ? spec.quote_text || "" : spec.headline, spec.kicker, spec.accent);
    if (qc.pass) return outcome.card_url;
    console.error(`renderAndVerifyText: attempt ${attempt + 1} failed text-QC for ${pageId}: ${qc.reason}`);
  }
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
const PROPER_NOUN_RE = /\b([A-Z][a-z']+(?:\s+[A-Z][a-z']+){1,2})\b/g;
const HEADLINE_LEAD_WORDS = new Set(["the", "a", "an", "is", "was", "how", "why", "what", "when"]);

function extractProperNounFallback(headline: string): string | null {
  const matches = [...headline.matchAll(PROPER_NOUN_RE)].map((m) => m[1]);
  const real = matches.find((m) => !HEADLINE_LEAD_WORDS.has(m.split(/\s+/)[0].toLowerCase()));
  return real || matches[0] || null;
}

export async function renderCard(
  candidate: Candidate,
  page: PageConfig,
  athleteNames: string[],
  postedLog: PostedLogEntry[],
  dateISO: string
): Promise<RenderCardResult> {
  const headlineFallback = extractProperNounFallback(candidate.headline);
  const searchTerms =
    athleteNames.length > 0 ? athleteNames : [headlineFallback || page.page_theme.split(/[.,—-]/)[0].trim()];
  const isTradeStory = /trade/i.test(candidate.headline);
  const hasRealQuote = extractQuotedPhrase(candidate.headline) !== null;
  const template = chooseTemplate(candidate, searchTerms.length, hasRealQuote, postedLog, dateISO);
  const kicker = chooseKicker(candidate, template);
  const accentHex = isTradeStory ? ACCENT_HEX_TRADE : PALETTE_BY_LAYOUT[template];

  if ((template === "comparison" || template === "quote") && searchTerms.length >= 2) {
    const [subjectPhoto, speakerPhoto] = await Promise.all([
      searchAndPick(searchTerms[0], HERO_FACE_MULTIPLIER),
      searchAndPick(searchTerms[1], INSET_FACE_MULTIPLIER),
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
      const spec: RenderSpec = {
        page_id: page.page_id,
        headline: shortHeadline(candidate.headline),
        accent: chooseAccentWord(candidate.headline),
        kicker,
        story_type: isQuote ? "quote exchange" : "head-to-head comparison",
        layout: isQuote ? "quote" : "comparison",
        accent_hex: accentHex,
        photo_subjects: [searchTerms[0], searchTerms[1]],
        reference_photo_url: cropTo(subjectPhoto, CARD_WIDTH, CARD_HEIGHT, HERO_FACE_MULTIPLIER).url,
        is_quote: isQuote,
        quote_text: isQuote ? quotedPhrase : null,
        quote_attribution: isQuote ? searchTerms[1] : null,
      };
      const cardUrl = await renderAndVerifyText(spec, page.page_id);
      if (cardUrl) return { cardUrl, template: spec.layout };
    }
    // Fell through to single-entity spec below if either search failed, or
    // every render path failed — never post a two-person layout with an
    // unrelated/missing second photo.
  }

  const photo = await searchAndPick(searchTerms[0], HERO_FACE_MULTIPLIER);
  if (!photo) return { cardUrl: null, template: null }; // no real photo found for this candidate — never fabricate one

  // Recompute kicker/accent when the two-subject layout fell back here (its
  // photo search failed) — a card that's now single-subject standard
  // editorial shouldn't still carry a "HEAD-TO-HEAD" kicker from the layout
  // it didn't end up using.
  const singleLayout: TemplateId = template === "comparison" || template === "quote" ? "standard_editorial" : template;
  const singleKicker = singleLayout === template ? kicker : chooseKicker(candidate, singleLayout);
  const singleAccentHex = isTradeStory ? ACCENT_HEX_TRADE : PALETTE_BY_LAYOUT[singleLayout];
  const spec: RenderSpec = {
    page_id: page.page_id,
    headline: shortHeadline(candidate.headline),
    accent: chooseAccentWord(candidate.headline),
    kicker: singleKicker,
    story_type: isTradeStory ? "trade rumor" : singleLayout.replace(/_/g, " "),
    layout: singleLayout,
    accent_hex: singleAccentHex,
    photo_subjects: [searchTerms[0]],
    reference_photo_url: cropTo(photo, CARD_WIDTH, CARD_HEIGHT, HERO_FACE_MULTIPLIER).url,
    is_quote: false,
    quote_text: null,
    quote_attribution: null,
  };

  const cardUrl = await renderAndVerifyText(spec, page.page_id);
  if (!cardUrl) return { cardUrl: null, template: null };
  return { cardUrl, template: singleLayout };
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

  // ⛔ LEARNING PORTED (2026-08-08, ES_Threads_Automation_Playbook.md Section
  // 8) — only attempt the write-then-delete pattern when BOTH this page opts
  // in (real registry data: every page currently has hashtag_logic:
  // "write_then_delete", topic_registration:true) AND the strip step's schema
  // has been explicitly confirmed live (see postiz.ts's hashtagStripVerified).
  // Until then this is fully inert — no hashtag gets appended at all, since
  // leaving one stuck permanently visible would be worse than not trying.
  const wantsHashtagRegistration = page.threads?.topic_registration && page.threads?.hashtag_logic === "write_then_delete";
  const hashtag = wantsHashtagRegistration ? buildTopicHashtag(primaryEntity ? [primaryEntity] : [], sportGroup) : null;
  const canStrip = hashtag && hashtagStripVerified();
  const postHtml = canStrip ? `${mainPostHtml} ${hashtag}` : mainPostHtml;

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
