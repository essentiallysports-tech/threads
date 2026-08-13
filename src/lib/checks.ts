// Deterministic, code-enforced checks — the entire reason this service
// exists instead of the old prose skill file. Every function here is a pure
// function or a real HTTP call; nothing here is "ask the model to remember
// to check this."

import { Candidate, PageConfig, PostedLogEntry } from "./types";
import { fetchWithTimeout } from "./httpUtil";
import { isCategoryPlaceholder } from "./renderSpec";

// ⛔ OPERATOR FIX (2026-08-08, real live incident): a post's reply linked to
// a random x.com tweet URL instead of ES's own content — "only ES article
// link/ES newsletter link... is allowed in the reply, no random links,
// hardcode this." This is a hard ALLOWLIST, replacing the old competitor-
// site blocklist entirely (anything on that old list necessarily fails this
// too, so keeping both was dead weight) — the reply link must be
// essentiallysports.com (the real article) or a *.beehiiv.com subdomain
// (one of the real ES newsletter publications), full stop. The
// web_search/social_search/evergreen_search sourcing tiers (sourcing.ts) are
// genuinely useful for DISCOVERING what's newsworthy right now, but their
// own result URL (an external site, a tweet) must never become the actual
// reply target — this check is what actually enforces that, applied to
// every candidate regardless of which tier found it.
export function isEsOwnedLink(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "essentiallysports.com" || host.endsWith(".beehiiv.com");
  } catch {
    return false;
  }
}

// A candidate's subject/headline text must plausibly connect to this page's
// own registered entities or sport_groups — the deterministic version of the
// old skill file's `entity_or_sport_match`, and the exact check that would
// have stopped the WNBA/boxing incident that started this whole rewrite.
export function entityOrSportMatch(candidate: Candidate, page: PageConfig): boolean {
  // ⛔ OPERATOR BROADENING (2026-08-10): "Daily 150 ES articles... should be
  // mapped to relevant pages and posted." sourcing.ts's sourceFromEsArticles
  // already queries ES-MCP's query_articles tool scoped to this exact
  // page's own sport_groups (real editorial classification, not a guess) —
  // re-requiring the literal sport/league word to ALSO appear in the
  // headline text was dropping real, already-scoped ES articles just
  // because a single-player headline ("Dak Prescott Offers Support...")
  // never says "NFL." Trust the tier's own server-side scoping instead of
  // re-checking it with a much blunter local text match.
  const haystack = `${candidate.subject} ${candidate.headline} ${candidate.rawText || ""}`.toLowerCase();
  const sportGroups = page.sport_groups.map((s) => s.toLowerCase());

  // ⛔ OPERATOR FIX (2026-08-12, real live incident, confirmed at severe
  // scale): a real ES article about WNBA commissioner Cathy Engelbert and
  // Caitlin Clark's biographer posted on an NBA page ("ES NBA Newsroom").
  // Root cause, confirmed live: "WNBA" contains "NBA" as a literal
  // substring, so ES-MCP's own sport="NBA" filter returns WNBA-tagged
  // articles too — tested live, 19 of 31 ("61%") "NBA"-filtered results
  // were actually WNBA stories. The es_article bypass below trusts that
  // upstream scoping unconditionally, with nothing downstream able to
  // catch a leak this large. This hard veto overrides that trust in ONE
  // specific, unambiguous direction: an NBA-only page (not also registered
  // for WNBA) seeing explicit "WNBA" content is never correct, regardless
  // of source or sport_group match — a real, different, sibling league,
  // not a substring coincidence like the promo-code/LPGA incidents this
  // same pattern already covers elsewhere. Deliberately NOT symmetric (a
  // WNBA page covering a genuine NBA crossover story can be legitimate) —
  // only this one confirmed-wrong direction is blocked.
  if (sportGroups.includes("nba") && !sportGroups.includes("wnba") && /\bwnba\b/i.test(haystack)) {
    return false;
  }

  // ⛔ OPERATOR FIX (2026-08-13, real live incident): "Dallas Wings' Azzi
  // Fudd Decision Leads Jose Fernandez to Address Her Health Before Game
  // vs Toronto" posted on a Lakers page — the headline text NEVER contains
  // the literal word "WNBA" (only the team name "Dallas Wings"), so the
  // text-scanning veto above never fired. But ES's own URL slug for this
  // real article is "wnba-basketball-news-dallas-wings-azzi-fudd..." — ES's
  // OWN editorial category tag, baked into the URL, correctly identifying
  // this as WNBA content regardless of whether the headline prose ever
  // says the league's name. This is a far more reliable signal than
  // scanning free text for a word that often just isn't there (most real
  // WNBA headlines reference a team/player, not the league initials). Only
  // meaningful for es_article candidates, whose `key` IS the real URL slug
  // (see sourcing.ts's sourceFromEsArticles).
  if (candidate.source === "es_article") {
    const slug = candidate.key.toLowerCase();
    if (sportGroups.includes("nba") && !sportGroups.includes("wnba") && /^wnba-/.test(slug)) {
      return false;
    }
    if (sportGroups.includes("wnba") && !sportGroups.includes("nba") && /^nba-/.test(slug)) {
      return false;
    }
  }

  if (candidate.source === "es_article") return true;
  const entityNames = page.entities.map((e) => e.name.toLowerCase());
  const entityKeywords = page.entities.flatMap((e) => e.keywords.map((k) => k.toLowerCase()));
  const all = [...entityNames, ...entityKeywords, ...sportGroups];
  if (all.length === 0) return true; // nothing registered to check against — don't block

  // A genuine registered name/team actually mentioned is trusted fully,
  // same as before — this is real, specific signal nothing else can fake.
  const realEntityMatch = [...entityNames, ...entityKeywords].some((term) => term.length > 2 && haystack.includes(term));
  if (realEntityMatch) return true;

  const sportGroupMatch = sportGroups.some((term) => term.length > 2 && haystack.includes(term));
  if (!sportGroupMatch) return false;

  // ⛔ OPERATOR FIX (2026-08-11, real live incident, severe): an MLB
  // player-prop betting-picks promo ("8/11/26 MLB DEMON CARD... Brandon
  // Lowe O 1.5 TB... 25% OFF CODE: NFL") got posted on the Baltimore Ravens
  // page — ZERO real Ravens entity (Lamar Jackson, Derrick Henry, etc.)
  // anywhere in it, sourced from that page's OWN configured newsletter
  // (which the sourcing pipeline trusts by construction). It only passed
  // this check because the literal promo code "CODE: NFL" contains the
  // substring "nfl", the page's own sport_group. A sport_group hit with NO
  // real entity match, sitting alongside an EXPLICIT different major
  // sport's own name in plain text, is a strong sign the page's keyword is
  // incidental (a promo code, hashtag, unrelated aside) — not real
  // evidence this content is actually about this page's sport. This is the
  // single largest-blast-radius gap found so far: it applies to every
  // sourcing tier, including the "trusted" newsletter tier that otherwise
  // skips relevance re-checking.
  const OTHER_SPORT_TOKENS = [
    "nfl", "nba", "mlb", "nhl", "wnba", "ncaa", "mma", "ufc", "nascar", "f1",
    "golf", "tennis", "soccer", "boxing", "pickleball",
  ];
  const conflictingSport = OTHER_SPORT_TOKENS.find((s) => !sportGroups.includes(s) && haystack.includes(s));
  if (conflictingSport) return false;

  return true;
}

// Which of this page's registered entities (athletes/teams) actually matched
// this candidate — the deterministic source of "which athlete images to pull
// from ES-MCP" for the infographic render step. Returns real EntitySlot
// display names (e.g. "LeBron James"), not raw keywords, so they're directly
// usable as an ES-MCP search_images query. Deliberately separate from
// entityOrSportMatch (a boolean pass/fail) — this is about WHICH entity, not
// whether one matched, per the operator's explicit choice (2026-08-06) to
// keep athlete identification deterministic/code-driven rather than leaving
// it to the render Routine's own judgment.
// Same idea as matchedEntityNames, but for sport_groups — which real league
// this candidate is actually about, for the topic-frequency league cap.
export function matchedSportGroup(candidate: Candidate, page: PageConfig): string | null {
  const haystack = `${candidate.subject} ${candidate.headline} ${candidate.rawText || ""}`.toLowerCase();
  return page.sport_groups.find((s) => haystack.includes(s.toLowerCase())) || null;
}

// ⛔ OPERATOR FIX (2026-08-08, real live incident): confirmed live that
// several pages' `EntitySlot.name` is a COMMA-JOINED list of multiple real
// people ("A'ja Wilson, Caitlin Clark", "Angel Reese, Paige Bueckers,
// Breanna Stewart" — p42 Essentially WNBA) rather than one display name;
// `keywords` holds the actual individual names in the same slot. Returning
// the whole compound `name` string as the "primary entity" handed
// accuracyGate a string that can never appear verbatim in any real article
// ("does the body contain 'A'ja Wilson, Caitlin Clark'?" — never true) —
// this silently and permanently failed SOURCE_DOES_NOT_MENTION_SUBJECT on
// every single candidate for any page with a compound-name slot, which is
// exactly why p42 hadn't posted in 2+ days despite having plenty of real,
// on-topic candidates pass every earlier gate. Returns the SPECIFIC
// individual keyword(s) that actually matched instead, falling back to the
// whole `name` only for slots that are genuinely one single name with no
// keywords array (team-name slots like "Los Angeles Lakers" are unaffected
// either way, since that IS the real, searchable, article-usable string).
// Same consecutive-capitalized-words heuristic already proven for entity-
// less "national" pages (see activities/index.ts's old extractProperNounFallback,
// now consolidated here) — pulls a real person/team name straight out of the
// candidate's own headline. Never fabricates: the name has to already be in
// the real, sourced text, and accuracyGate below still verifies it's really
// said in the fetched source article.
// ⛔ FIX (2026-08-10): the original 1-3-word version's greedy match picked up
// a trailing capitalized common word in Title-Case headlines ("Chase
// Elliott Sounds Alarm..." matched as the 3-word "Chase Elliott Sounds",
// which then fails accuracyGate's verbatim substring check even though the
// real name "Chase Elliott" clearly appears). Try the standard 2-word
// Firstname-Lastname shape first; only fall back to 3 words when no 2-word
// match exists, since a real full name is the common case.
// ⛔ OPERATOR FIX (2026-08-12, real live incident): "UFC Legend Makes Bold
// Ian Garry Claim" extracted "Bold Ian" instead of the real name "Ian
// Garry" — a plain global regex match() is non-overlapping, so once "Bold
// Ian" consumed as a match, "Ian" is never available to pair with "Garry"
// right after it. Rather than adding "bold" to NON_NAME_WORDS (which only
// fixes THIS one clickbait adjective and needs a new patch for the next
// one — "Shocking", "Blunt", "Fiery", etc., the same whack-a-mole pattern
// already patched three times elsewhere in this file), the lookahead
// below makes matches OVERLAP: each capitalized word is checked paired
// with the word immediately after it, so "Ian Garry" is always a
// candidate match in its own right regardless of what precedes "Ian."
// isPlausibleName's stopword filter still does the real work of rejecting
// bad pairs ("Bold Ian" would still be tried, but so would "Ian Garry" —
// letting the real name win when the adjective-led pair doesn't clear it).
const PROPER_NOUN_RE_2 = /\b([A-Z][a-z']+)(?=\s+([A-Z][a-z']+)\b)/g;
const PROPER_NOUN_RE_3 = /\b([A-Z][a-z']+(?:\s+[A-Z][a-z']+){2})\b/g;
const PROPER_NOUN_LEAD_STOPWORDS = new Set(["the", "a", "an", "is", "was", "how", "why", "what", "when"]);

// ⛔ FIX (2026-08-10, real live incident): "5x NBA Champion Dies at 86" (a
// headline that never names the actual person — real source: a newsletter
// title) matched the 2-word pattern as "Champion Dies", a false positive
// that then got searched against ES-MCP's real photo library — which
// dutifully returned SOME real photo for that nonsense query, and the
// pipeline rendered it as if it were the actual deceased athlete. Two
// capitalized words in a row is not proof of a real name; both words must
// clear this stoplist of common headline nouns/verbs that produce exactly
// this false-positive shape ("Legend Retires", "Star Fired", "Coach
// Resigns") before a match is trusted as a real person's name.
// ⛔ OPERATOR FIX (2026-08-11, real live incident): "Lakers Face Luka Doncic
// Exit Warning" — a real card with a correct headline — still rendered a
// random unrelated player's photo, because the SOURCE headline actually
// read `"He Is Not Obligated to Stay": Lakers Face Luka Doncic Exit
// Warning...` and the 2-word regex matched the leading quoted clause's "He
// Is" before it ever reached "Luka Doncic". PROPER_NOUN_LEAD_STOPWORDS only
// screens the FIRST word of a match and never included pronouns at all;
// NON_NAME_WORDS (checked against every word via isPlausibleName) had no
// pronouns/auxiliary-verbs either, so "He Is" sailed through as a
// "plausible name" and got searched against ES-MCP as if it were a real
// person. Quoted clauses at the start of a headline routinely lead with a
// capitalized pronoun + auxiliary verb ("He Is", "She Was", "They Are",
// "It Is") — these must be rejected same as "Champion Dies" was.
const NON_NAME_WORDS = new Set([
  "champion", "champions", "legend", "legends", "star", "stars", "coach",
  "player", "players", "team", "rookie", "veteran", "icon", "hero", "owner",
  "manager", "captain", "winner", "winners", "loser", "fan", "fans",
  "report", "reports", "update", "breaking", "source", "sources",
  "dies", "died", "wins", "won", "loses", "lost", "retires", "retired",
  // ⛔ OPERATOR FIX (2026-08-11, real live incident): a headline reading
  // just "Sophie" for the real subject's first name (no last name at all)
  // — "Sophie Targets 7 Figure Deal Outside WNBA" — matched the 2-word
  // regex as "Sophie Targets", with "targets" (a common headline verb,
  // same category as "signs"/"reveals"/"admits" below) never in this list.
  // The bad fallback name got searched against ES-MCP, which returned an
  // unrelated agency photo of two different real WNBA stars for a story
  // that was never about either of them.
  "targets", "target", "eyes", "eyeing", "seeks", "seeking", "chases",
  "chasing", "lands", "landing", "nears", "nearing", "weighs", "weighing",
  "mulls", "mulling", "considers", "considering", "teases", "teasing",
  "hints", "hinting", "hosts", "hosting", "faces", "facing",
  "he", "she", "it", "they", "we", "you", "i", "him", "her", "them", "his",
  "hers", "their", "this", "that", "these", "those", "who", "which",
  "is", "was", "are", "were", "am", "be", "been", "being",
  "do", "does", "did", "has", "have", "had", "will", "would", "can",
  "could", "should", "shall", "must", "may", "might", "not",
  "signs", "signed", "named", "says", "said", "reveals", "revealed",
  "admits", "admitted", "passes", "passed", "announces", "announced",
  "confirms", "confirmed", "denies", "denied", "responds", "responded",
  "reacts", "reacted", "speaks", "spoke", "talks", "talked", "breaks",
  "opens", "opened", "shares", "shared", "blasts", "slams", "fires",
  "fired", "suspended", "banned", "returns", "returned", "joins",
  "joined", "leaves", "left", "trades", "traded", "released", "drafted",
  "injured", "sidelined", "cut",
  // ⛔ OPERATOR FIX (2026-08-11): same false-positive shape as "He Is" but
  // from generic sports-cliche phrases instead of pronouns — "Western
  // Conference", "This Season", "Last Night" etc. are two capitalized
  // words that clear every other check and read exactly like a real name
  // to the regex. Added proactively (not from a confirmed live incident
  // yet) precisely because this class of bug has now recurred twice from
  // two different word categories — better to close the obvious next ones
  // than wait for a third screenshot.
  "western", "eastern", "northern", "southern", "conference", "division",
  "final", "finals", "bowl", "series", "championship", "championships",
  "season", "seasons", "week", "weeks", "night", "nights", "day", "days",
  "month", "months", "year", "years", "today", "yesterday", "tomorrow",
  "next", "last", "this", "morning", "afternoon", "evening", "game",
  "games", "match", "matches", "tournament", "playoff", "playoffs",
  "deadline", "deadlines", "agency", "draft", "media",
  // ⛔ OPERATOR FIX (2026-08-12, real live incident): "UFC Legend Makes
  // Bold Ian Garry Claim" — with the overlapping-match fix above, "Ian
  // Garry" is now a candidate match, but "Legend Makes"/"Makes Bold"/"Bold
  // Ian" all still had to be filtered out FIRST (the picker returns the
  // first surviving match, not the best one) for the real name to win.
  // "makes"/"claim"/"bold" are the same class of clickbait headline
  // filler this list already covers — added here rather than treated as
  // a one-off.
  "makes", "make", "claim", "claims", "bold", "brutal", "shocking", "wild",
  "blunt", "honest", "fiery", "harsh", "major", "huge",
  // ⛔ OPERATOR FIX (2026-08-12, real live incident, fourth occurrence of
  // this exact bug class): "SVG's Former Team Forced To Apologize To
  // Stakeholders" extracted "Forced To" as the entity — on a vintage-
  // legends-only page (Petty/Earnhardt/Allison/Pearson/Yarborough) that has
  // no business posting current-driver news at all. ES's title-case
  // headline convention capitalizes short connector words ("To", "Of",
  // "In"...) the same as real names, and a bare 2-capitalized-words check
  // can't tell them apart. Unlike "makes"/"bold" (still headline-specific
  // adjectives/verbs), THESE words are near-universally never part of a
  // real 2-3 word person name regardless of headline style — a broad,
  // durable, low-risk category to close all at once rather than one
  // more single-word patch next time a different connector shows up.
  "to", "of", "in", "for", "with", "and", "or", "on", "at", "by", "from",
  "as", "into", "onto", "over", "under", "after", "before", "despite",
  "amid", "amidst", "without", "within", "about", "against", "toward",
  "towards", "per", "via",
  // ⛔ OPERATOR FIX (2026-08-13, real live incident): "Who Wins an MMA
  // Fight Between Max Holloway and Usman Nurmagomedov?" extracted "Fight
  // Between" — "who"/"wins"/"an" already filtered, "MMA" doesn't match the
  // name regex (all-caps), but "fight" and "between" both survived and won
  // as the first 2-word match, ahead of the real name "Max Holloway".
  // "between" is the same durable connector-word category as "to"/"of"
  // above; "fight" is a generic combat-sports headline noun, same class as
  // "claim"/"bold" — added together since both were needed for this exact
  // headline to resolve correctly.
  "between", "fight", "fights",
  // Same durable category as the connectors above — negations/determiners
  // ("No Fault", "Own" in "Despite No Fault Of Their Own") that ES's
  // title-case convention capitalizes just like real names.
  "no", "not", "none", "own", "every", "each", "any", "all", "some",
  "another", "other", "such", "same",
]);

// Real headline metadata reliably wraps a proper noun in punctuation a
// bare word-boundary set-lookup misses ("Coach's", "Team's," "Rookie:") —
// strip leading/trailing non-letter characters per word before checking
// against NON_NAME_WORDS, so a possessive/trailing-comma variant of an
// already-known non-name word doesn't silently bypass this filter.
function isPlausibleName(match: string): boolean {
  const words = match.toLowerCase().split(/\s+/).map((w) => w.replace(/^[^a-z]+|[^a-z]+$/g, ""));
  return words.every((w) => !NON_NAME_WORDS.has(w));
}

// ⛔ OPERATOR FIX (2026-08-12, real live incident, third occurrence of this
// exact bug class): a real ES article headline — `"Terrible Job": Caitlin
// Clark's Biographer Blasts Cathy Engelbert Over WNBA's Trans Athlete Task
// Force` — matched "Terrible Job" as the extracted "entity," which then
// got searched as a photo subject and produced a totally unrelated random
// photo. This is the SAME shape as the two earlier fixes below ("Champion
// Dies", "He Is") — ES's own headline convention is consistently `"<quote>":
// <real subject sentence>`, and the quoted lead-in is NEVER a real name.
// The previous two fixes each patched this by adding specific words to
// NON_NAME_WORDS/PROPER_NOUN_LEAD_STOPWORDS — a whack-a-mole approach that
// needs a new patch for every new quote ("Terrible Job" today, something
// else tomorrow). This is the structural fix: strip the leading quoted
// clause before scanning for names at all, so no quote — no matter its
// wording — ever reaches the regex in the first place.
function stripLeadingQuotedClause(text: string): string {
  return text.replace(/^\s*["“'‘][^"”'’]*["”'’]\s*:\s*/, "");
}

// Trailing possessive ("Clark's") is a photo-search term, not a display
// name — strip it so the search query is the clean name, not the name plus
// an apostrophe-s that can hurt match quality against ES-MCP/photo search.
function stripTrailingPossessive(name: string): string {
  return name.replace(/'s$/i, "");
}

// PROPER_NOUN_RE_2 is lookahead-based (see its own comment) so its second
// word arrives as a separate capture group, never consumed by the match
// itself — PROPER_NOUN_RE_3 is still a plain single-group match. This
// normalizes both into the same "the real matched text" string.
function matchedText(m: RegExpMatchArray): string {
  return m[2] ? `${m[1]} ${m[2]}` : m[1];
}

export function extractSimilarPlayerName(candidate: Candidate): string | null {
  const text = stripLeadingQuotedClause(`${candidate.headline} ${candidate.subject}`);
  const pickReal = (re: RegExp) => {
    const matches = [...text.matchAll(re)].map(matchedText).filter(isPlausibleName);
    return matches.find((m) => !PROPER_NOUN_LEAD_STOPWORDS.has(m.split(/\s+/)[0].toLowerCase())) || matches[0] || null;
  };
  const found = pickReal(PROPER_NOUN_RE_2) || pickReal(PROPER_NOUN_RE_3);
  return found ? stripTrailingPossessive(found) : null;
}

// ⛔ OPERATOR FIX (2026-08-10): "at least check the article for the name if
// such a case ever happens" — the real "5x NBA Champion Dies at 86"
// incident had NO name in the headline/subject at all, so
// extractSimilarPlayerName correctly returned null. But the linked article
// almost always DOES name the actual person, even when the teaser
// headline doesn't. A real name that matters to the story repeats several
// times across a full article; counting occurrences (not just taking the
// first match) is real signal that a candidate title-cased phrase is
// actually a person's name, not an incidental one-off capitalized pair.
export function extractNameFromArticleText(bodyText: string): string | null {
  const counts = new Map<string, number>();
  for (const re of [PROPER_NOUN_RE_2, PROPER_NOUN_RE_3]) {
    for (const m of bodyText.matchAll(re)) {
      const match = matchedText(m);
      if (!isPlausibleName(match)) continue;
      counts.set(match, (counts.get(match) || 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    // A 2-word match is a strict prefix of some 3-word match on the same
    // person ("Chase Elliott" inside "Chase Elliott Sounds") — that's
    // double-counting the same mention, not two separate signals. Only
    // compare distinct name candidates, not substrings of each other.
    const isSubstringOfAnother = [...counts.keys()].some((other) => other !== name && other.includes(name));
    if (isSubstringOfAnother) continue;
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return bestCount >= 2 ? best : null; // require at least 2 real mentions — a single incidental match isn't enough signal
}

async function fetchArticleText(url: string): Promise<string | null> {
  try {
    const res = await fetchWithRetry(url, { redirect: "follow" });
    if (!res.ok) return null;
    const body = await res.text();
    // ⛔ FIX (2026-08-10): confirmed live against a real Beehiiv page —
    // stripping only the <tag> markers left every <style> block's CSS
    // TEXT behind ("font-family: 'Open Sans', sans-serif;" repeated across
    // many rules), and "Open Sans" — a real two-word capitalized pair —
    // won on frequency over the real athlete's actual name. Script/style
    // block CONTENTS must be removed entirely, not just their tags.
    return body
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return null;
  }
}

// Only called when the headline/subject genuinely had no extractable name
// — a real network fetch, so it's used as a last resort, not on every
// candidate.
export async function extractNameFromArticle(candidate: Candidate): Promise<string | null> {
  const url = candidate.sourceLink || candidate.link;
  if (!url) return null;
  const text = await fetchArticleText(url);
  if (!text) return null;
  return extractNameFromArticleText(text);
}

// ⛔ FIX (2026-08-10, real live incident): a "comparison" card about Canelo
// rendered Terence Crawford as the HERO photo instead — because matched
// names used to come back in page.entities' own static registration order
// (Crawford is registered before Canelo on p57), not in the order the real
// story actually mentions them. renderCard treats searchTerms[0] as the
// hero/subject and searchTerms[1] as the secondary face — that assignment
// must follow who the STORY is actually about, not this page's roster
// ordering. Sorting matches by their first real occurrence in the
// headline/subject text fixes this: whoever the story leads with becomes
// the hero photo.
function firstOccurrenceIndex(haystack: string, name: string): number {
  const idx = haystack.indexOf(name.toLowerCase());
  return idx === -1 ? Infinity : idx;
}

// ⛔ OPERATOR FIX (2026-08-10, real live incidents): an Islam Makhachev post
// (headline: "...watching Ilia Topuria and Khamzat Chimaev both suffer
// shocking losses" — no mention of Khabib anywhere) rendered a VS card
// against KHABIB, and a Chase Elliott post about NASCAR's broadcast partner
// rendered a VS card against an unrelated second driver — neither story is
// actually a comparison between two people. Root cause: this function's
// default haystack includes `rawText` (up to 500 chars of fetched article
// body), which very often name-drops a second real, registered entity in
// passing (a mentor, a teammate, a rival referenced for context) with zero
// connection to what the headline is actually about. Every existing caller
// (relevance gating, caption enrichment) genuinely wants that broad net —
// only the render pipeline's "is this a genuine two-subject comparison
// story" decision needs the narrower, headline-only signal. `includeRawText`
// (default true, preserving every existing caller's behavior) lets that one
// decision opt out.
// Only the page's own registered entities/keywords, real substring hits —
// NEVER the regex-guess fallback below. Exported separately so callers that
// need to know "is this a GUARANTEED-real match, not a heuristic guess" can
// ask that question directly, without matchedEntityNames' fallback silently
// answering "yes" for a guess that turned out wrong.
export function realRegisteredEntityMatches(candidate: Candidate, page: PageConfig, opts: { includeRawText?: boolean } = {}): string[] {
  const includeRawText = opts.includeRawText ?? true;
  const orderingHaystack = `${candidate.headline} ${candidate.subject}`.toLowerCase();
  const haystack = `${candidate.subject} ${candidate.headline} ${includeRawText ? candidate.rawText || "" : ""}`.toLowerCase();
  const matched: string[] = [];
  for (const e of page.entities) {
    const individualNames = e.keywords.length > 0 ? e.keywords : [e.name];
    for (const name of individualNames) {
      // ⛔ OPERATOR FIX (2026-08-12, real live incident): a page's own
      // registered entity list had a slot named "PGA Tour, LPGA" with
      // keywords ["golf", "pga tour", "pga", "lpga"] — a generic tour/
      // league bucket registered as an "entity" the same way a real
      // player is. "LPGA" contains "pga" as a literal substring, so ONE
      // real mention of "LPGA" matched BOTH keywords — two "hits" from a
      // single event, counted as two distinct people. That wrongly
      // triggered the comparison/VS template and searched for photos of
      // "lpga" and "pga," neither a real depictable person — the same
      // generic golfer stock photo landed on both sides of the resulting
      // card. isCategoryPlaceholder (renderSpec.ts) already exists to
      // reject exactly this class of generic label; a page's own
      // registered keywords are not exempt from it.
      if (name.length > 2 && !isCategoryPlaceholder(name) && haystack.includes(name.toLowerCase())) matched.push(name);
    }
  }
  matched.sort((a, b) => firstOccurrenceIndex(orderingHaystack, a) - firstOccurrenceIndex(orderingHaystack, b));
  return matched;
}

export function matchedEntityNames(candidate: Candidate, page: PageConfig, opts: { includeRawText?: boolean } = {}): string[] {
  const matched = realRegisteredEntityMatches(candidate, page, opts);
  // ⛔ OPERATOR BROADENING (2026-08-10): "even on single entry build a more
  // comprehensive list of similar players playing same sport can go... more
  // output is needed." A narrow-roster page (one team, one fighter) already
  // passes entityOrSportMatch on sport_group alone for same-sport stories
  // about OTHER real players — but requiresNamedEntity was hard-blocking
  // those anyway because matchedNames came back empty. A real, different,
  // named player in the same sport is legitimate fan-page content, not
  // off-topic; extract that real name from the candidate's own headline
  // (never fabricated, never a hardcoded per-sport roster) so it can pass
  // and still get fact-verified downstream like every other candidate.
  if (matched.length === 0 && page.entities.length > 0) {
    const fallback = extractSimilarPlayerName(candidate);
    if (fallback) matched.push(fallback);
  }
  return matched;
}

// ⛔ OPERATOR FIX (2026-08-07, real live incident): a post about "Star
// Fighter's Brother's UFC Debut Canceled" went out live — that's not a
// caption-writing failure, it's SEEDED TEST/PLACEHOLDER content in the
// Beehiiv source (matches other observed test-labeled entries: "(low)",
// "(high - X core test)", "- test success") that nothing in the pipeline
// filtered out. Two distinct signals below, both checked deterministically
// before a candidate ever reaches captioning/rendering:
// ⛔ OPERATOR FIX (2026-08-08, real live incident): a seeded "Ex-UFC Champ
// Mourns Mother's Death (Test)" candidate passed every gate and reached the
// render step — none of the existing patterns catch a plain "(Test)"/"(test)"
// suffix, only the more specific "(low)"/"(high"/"core test" variants seen
// before. Added as its own pattern rather than broadening an existing one,
// since "(test)" alone is common enough test-content phrasing to risk false
// positives if merged into a looser existing rule.
const TEST_MARKER_PATTERNS = [/\(low\)/i, /\(high\b/i, /core\s+test/i, /-\s*test\s+success/i, /\btest\s+mode\b/i, /\(test\)/i];

export function isTestMarkerContent(candidate: Candidate): boolean {
  const text = `${candidate.subject} ${candidate.headline} ${candidate.rawText || ""}`;
  return TEST_MARKER_PATTERNS.some((re) => re.test(text));
}

// ⛔ OPERATOR FIX (2026-08-11, real live incident, severe): an MLB
// player-prop betting-picks promo ("8/11/26 MLB DEMON CARD... Brandon Lowe
// O 1.5 TB... 25% OFF CODE: NFL") posted on the Baltimore Ravens page, from
// that page's OWN configured newsletter. entityOrSportMatch's new
// conflicting-sport veto closes the specific mechanism that let THIS one
// through (a promo code that happened to contain the page's own sport
// keyword) — but that veto only fires when a DIFFERENT sport's name is
// also present. A same-sport betting promo (e.g. NFL player-prop picks on
// an NFL page) would say the right sport and still not be real editorial
// content. This is a direct, independent gate on the betting/promo SHAPE
// itself — same category of fix as isTestMarkerContent above, and it
// applies regardless of which sport is named, catching the case the
// sport-conflict veto structurally cannot.
// ⛔ OPERATOR FIX (2026-08-12, real live incident): two real betting-picks
// posts shipped ("NBA Most Bet Teams @DKSports... ML💰 PHI 76ers (vs LA
// Lakers)...", "MLB ML SCRIPT — 8/12... FAVORITE 3 🎯") — real sports
// betting content, but phrased differently from every pattern already
// here (no "demon card"/"parlay"/"promo code" wording). Added the actual
// shape these used: a "moneyline picks list" header (ML SCRIPT / Most Bet
// Teams / ML slate) is a distinct, common betting-content shape from the
// player-prop notation already covered.
const PROMO_BETTING_PATTERNS = [
  /\bdemon\s*card\b/i,
  /\bparlay\b/i,
  /\b(o|u|ov|und)\s*\d+(\.\d+)?\s*(tb|hr|so|rbi|k|pts|ast|reb)\b/i, // "O 1.5 TB", "U 6.5 K" — player-prop over/under notation
  /\b\d+%\s*off\s*code\b/i,
  /\bpromo\s*code\b/i,
  /\bbet\s*now\b/i,
  /\bfree\s*(pick|picks)\b/i,
  /\blocks?\s+of\s+the\s+(day|week)\b/i,
  /\bsubscribe\s+for\s+(picks|plays|props)\b/i,
  /\bml\s*(script|slate)\b/i,
  /\bmost\s+bet\s+teams\b/i,
  /\bfavorite\s*\d\s*🎯/i,
];

export function isPromoBettingContent(candidate: Candidate): boolean {
  const text = `${candidate.subject} ${candidate.headline} ${candidate.rawText || ""}`;
  return PROMO_BETTING_PATTERNS.some((re) => re.test(text));
}

// ⛔ OPERATOR FIX (2026-08-12, real live incident, high volume): at least a
// dozen posts in one day were literally someone else's @-reply ripped out
// of a Twitter conversation thread with zero surrounding context —
// "@vjeannek @Fear_Not_Ever Based on what you've said here, I would have
// voted guilty...", "@Brazo4444 help me out rite fast gang..." — real,
// on-topic-by-keyword, entity-matching text that every other gate correctly
// passed, but nonsensical as a standalone post since it's one side of a
// conversation the reader never sees. A tweet's own text starting with an
// @mention is a structural signal of "this is a reply," not an original
// standalone thought — a human curator would recognize this instantly and
// skip it; this is the deterministic equivalent.
export function isReplyTweetContent(candidate: Candidate): boolean {
  if (candidate.source !== "social_search") return false;
  return /^\s*@\w+/.test(candidate.headline || candidate.subject || "");
}

// ⛔ OPERATOR FIX (2026-08-11, real live incident, severe): a real card
// rendered entirely in Spanish ("TY GIBBS AGUANTÓ Y GANÓ EN IOWA... se
// defendió del ataque...") — and a separate candidate in the same page's
// pool was Czech ("Druhou stage vyhrál Christopher Bell"). Root cause:
// sourceFromTwitter/sourceFromReddit (socialSearch.ts) scrape real posts
// with zero language filtering — a Spanish-language NASCAR journalist's
// tweet is real, on-topic, correctly-entity-matched content by every OTHER
// check in this pipeline, so it sailed straight through. The AI copy/
// caption writers (narrativeCaption.ts, narrativeRenderSpec.ts) then just
// preserve whatever language the source facts are already in — nothing
// ever told them "this must be English," because nothing upstream ever
// flagged the input itself as non-English. No language-detection library
// is available here, so this is a deterministic heuristic: real English
// sports headlines essentially never contain Latin-script accented
// characters; Spanish/Portuguese/French/Czech/etc. text is saturated with
// them. Two-or-more is a low-false-positive-risk threshold — a single
// accented name (one mention of "Räikkönen") could false-positive only if
// that one name alone carries 2+ diacritics, a rare cost far smaller than
// posting a whole non-English card.
const NON_ENGLISH_DIACRITIC_RE = /[áéíóúñüàèìòùâêîôûçäöëïÁÉÍÓÚÑÜÀÈÌÒÙÂÊÎÔÛÇÄÖËÏ]/g;

// ⛔ OPERATOR FIX (2026-08-12): "the audience is fans — anything factually
// wrong or a wrong image gets reported straight away." The diacritic check
// above only catches Latin-script languages (Spanish/Portuguese/French/
// Czech); a source tweet in Chinese, Arabic, Cyrillic, Korean, Hindi, or
// Hebrew has zero Latin diacritics and would sail straight through as if
// it were English. Any character in these ranges is essentially NEVER
// legitimate English sports content — unlike a single accented Latin
// letter (which could be one accented name), so a single occurrence here
// is enough to reject, no threshold needed.
const NON_LATIN_SCRIPT_RE = /[一-鿿぀-ヿ가-힣؀-ۿЀ-ӿऀ-ॿ฀-๿֐-׿]/;

export function isNonEnglishContent(candidate: Candidate): boolean {
  const text = `${candidate.subject} ${candidate.headline} ${candidate.rawText || ""}`;
  if (NON_LATIN_SCRIPT_RE.test(text)) return true;
  const matches = text.match(NON_ENGLISH_DIACRITIC_RE);
  return (matches?.length || 0) >= 2;
}

// ⛔ OPERATOR FIX (2026-08-11): "story selection can be made much much
// better... why would anybody ever click subscribe to know more of such
// facts." A headline like "CUP SERIES STANDINGS AFTER IOWA\n1. Denny
// Hamlin\n2. Ty Gibbs\n3. Ryan Blaney..." is real, on-topic, and passes
// every existing gate — but it's a pure numbers dump with zero narrative
// tension, exactly the shape of candidate that produces an unclickable
// post no caption rewrite can fix (there's no real story underneath a
// ranked list, just the list itself). This is a DEPRIORITIZE signal for
// sourcing.ts's candidate ordering, never an exclusion — per this
// project's standing "quality over quota, never drop a page to zero over
// a preference" rule, a flat-dump candidate still gets tried when it's the
// only real content available, it just no longer wins a slot over a
// narrative-rich one that exists in the same pool.
export function isFlatStatDump(candidate: Candidate): boolean {
  const numberedLines = (candidate.headline.match(/(?:^|\n)\s*\d+[.)]\s+/gm) || []).length;
  return numberedLines >= 2;
}

// ⛔ OPERATOR FIX (2026-08-12, real live incident, severe): a p55 (Fearless
// Female Fighters) post fabricated an entire dramatic narrative ("someone
// out there is getting called both a woke MMA fan and an Israeli
// communist... the internet found a way to make those two things
// coexist") around a source tweet whose FULL, VERBATIM, ONLY content was:
// `"woke mma fan" "israeli communist"` — two quoted fragments with 2
// views, zero surrounding context, no narrator, no named actor, no
// described event. The caption prompt's "do not invent any detail beyond
// what's given" instruction did not hold once the given content was this
// thin — the model filled the vacuum with a plausible-sounding invented
// story instead of recognizing there was nothing to narrate. This is a
// hard, upstream candidate-eligibility gate, not a caption-prompt fix:
// content that is ENTIRELY bare quoted fragments with no real prose frame
// around them structurally cannot be narrated without inventing the frame,
// regardless of how the prompt is worded. A short tweet with real prose
// ("McGregor announces retirement") is fine and untouched by this — only
// content that's nothing BUT quotes gets caught.
export function isBareQuotedFragment(candidate: Candidate): boolean {
  const text = `${candidate.subject} ${candidate.headline}`.trim();
  const withoutQuotes = text.replace(/["'“”‘’][^"'“”‘’]*["'“”‘’]/g, " ").replace(/\s+/g, " ").trim();
  return withoutQuotes.length < 15;
}

// ⛔ OPERATOR FIX (2026-08-08): "do what is left" — two real guardrails the
// reference skill file specified (Section 8's topic-frequency limits,
// Section "Hard Caps"' dominant-narrative cap) but this project never built.
// Both need to know WHICH entity/league a PAST post covered — see
// PostedLogEntry.entity/.sportGroup, populated at post time.
export interface FrequencyCheckResult {
  pass: boolean;
  reason: string | null;
}

function withinHours(entry: PostedLogEntry, hours: number, now: number): boolean {
  const t = entry.posted_at ? new Date(entry.posted_at).getTime() : NaN;
  return !isNaN(t) && now - t <= hours * 3600 * 1000;
}

// Ported from ES-Threads-Automation-Skill-v1.md Section 8: 3 entity tags/24h,
// 5 league tags/24h between posts on the same page — this doesn't fight the
// throughput goal, it just stops one entity/league from crowding out
// everything else in a single day.
//
// ⛔ OPERATOR FIX (2026-08-08): the original min-gap here was 2 hours, ported
// verbatim from the reference skill file without checking it against THIS
// project's actual hourly firing cadence — with 26 pages and a strict 2h
// gap, any page that posted in hour N is unconditionally blocked in hour
// N+1, capping real per-run eligibility to roughly half the registry
// regardless of content quality (confirmed live: a run right after a
// high-volume hour dropped to 5/26 posted, nearly all blocked by this one
// check). Operator directive: shorten to 50 minutes — just under the hourly
// interval, so a page is eligible again by the very next firing rather than
// skipping every other one, while still preventing the same page from
// posting twice within a single hour if a run ever executes out of its
// normal cadence.
const MIN_GAP_MINUTES = 50;

export function topicFrequencyCheck(primaryEntityName: string | null, primarySportGroup: string | null, postedLog: PostedLogEntry[]): FrequencyCheckResult {
  const now = Date.now();
  const last24h = postedLog.filter((p) => withinHours(p, 24, now));

  const mostRecentPostTime = last24h.reduce((latest, p) => {
    const t = p.posted_at ? new Date(p.posted_at).getTime() : 0;
    return t > latest ? t : latest;
  }, 0);
  if (mostRecentPostTime > 0 && now - mostRecentPostTime < MIN_GAP_MINUTES * 60 * 1000) {
    return { pass: false, reason: `TOPIC_FREQUENCY_MIN_GAP_${MIN_GAP_MINUTES}M` };
  }

  if (primaryEntityName) {
    const entityCount = last24h.filter((p) => p.entity === primaryEntityName).length;
    if (entityCount >= 3) return { pass: false, reason: `TOPIC_FREQUENCY_ENTITY_CAP:${primaryEntityName}` };
  }
  if (primarySportGroup) {
    const sportCount = last24h.filter((p) => p.sportGroup === primarySportGroup).length;
    if (sportCount >= 5) return { pass: false, reason: `TOPIC_FREQUENCY_LEAGUE_CAP:${primarySportGroup}` };
  }
  return { pass: true, reason: null };
}

// Ported from the reference skill file's "DOMINANT-NARRATIVE CAP" — no
// single subject may account for more than ~25% of a page's posts in any
// rolling 7-day window (the real, twice-recurring DJ Moore/Bills incident
// that rule exists to stop). Exempt below a minimum sample (4 posts) since
// a ratio is meaningless — and misleadingly restrictive — over a tiny count.
export function dominantNarrativeCheck(primaryEntityName: string | null, postedLog: PostedLogEntry[]): FrequencyCheckResult {
  if (!primaryEntityName) return { pass: true, reason: null };
  const now = Date.now();
  const last7d = postedLog.filter((p) => withinHours(p, 24 * 7, now));
  if (last7d.length < 4) return { pass: true, reason: null };
  const entityCount = last7d.filter((p) => p.entity === primaryEntityName).length;
  if ((entityCount + 1) / (last7d.length + 1) > 0.25) {
    return { pass: false, reason: `DOMINANT_NARRATIVE_CAP:${primaryEntityName}` };
  }
  return { pass: true, reason: null };
}

// ⛔ OPERATOR FIX (2026-08-07): "vague things should never go out, it must
// contain proper names" — not just a pattern match on "star fighter"-style
// phrasing, a hard rule. If this page has ANY registered entities to check
// against (athletes or teams — matchedEntityNames covers both), a candidate
// that matches none of them by name has no real proper noun to build a
// specific post around, full stop. Pages with an EMPTY entities list (none
// registered) are exempt — entityOrSportMatch already treats that the same
// way (nothing registered to check against, don't block on it).
//
// ⛔ SECOND EXEMPTION (2026-08-08, activating p44 "EssentiallySports Media"):
// a "national" page_type is architecturally different — its `entities`
// array is a single generic placeholder ("Biggest cross-sport storylines of
// the week", keywords like "sports news"/"athlete news"), not a real
// athlete/team list, because national roundup pages are explicitly designed
// to cover whatever's biggest across sports that week, not track specific
// people. Applying the named-entity rule there would reject nearly
// everything it's supposed to post. `national_threshold` (not entity
// matching) is that page type's own real relevance gate.
// ⛔ OPERATOR FIX (2026-08-12, real live incident, severe): a real story
// about "UFC Stars Israel Adesanya and Rampage Jackson" — both men —
// posted on "Fearless Female Fighters," a page explicitly registered as a
// women's MMA fan page with an all-women roster (Shevchenko, Harrison,
// Dern, Weili, Nunes, Peña, Grasso). It passed `requiresNamedEntity`
// because `matchedEntityNames`'s own same-sport fallback ("a real,
// different, named player in the same sport is legitimate fan-page
// content" — added 2026-08-10 for narrow-roster pages like a single-driver
// NASCAR page) has no concept of gender divisions — Adesanya IS a real
// MMA name, satisfying that fallback exactly as designed for e.g. a
// single-driver page, but wrongly for a page whose whole premise is one
// specific gender division. A page's own registered theme text ("Women's
// MMA fan page...") is the real, existing signal for this — detected here
// rather than adding a new field to maintain.
const WOMENS_ONLY_THEME_RE = /\b(women'?s|female)\b/i;

export function isWomensOnlyPage(page: PageConfig): boolean {
  return WOMENS_ONLY_THEME_RE.test(page.page_theme || "");
}

export function requiresNamedEntity(candidate: Candidate, page: PageConfig, matchedNames: string[]): boolean {
  if (page.page_type === "national") return false;
  if (page.entities.length === 0) return false;
  // Women's-division pages skip the same-sport fallback entirely — only a
  // REAL, guaranteed match against this page's own (all-women) roster
  // counts. A same-sport regex/AI guess that happens to be a real name is
  // still the wrong gender division for this page's actual premise.
  if (isWomensOnlyPage(page)) {
    return realRegisteredEntityMatches(candidate, page).length === 0;
  }
  return matchedNames.length === 0;
}

// Same key (exact story/edition) already posted on this page, ever within
// the given window — replaces the old skill file's per-page idempotency
// check with a real, deterministic array scan.
export function alreadyPostedRecently(candidate: Candidate, log: PostedLogEntry[], withinHours: number): boolean {
  const cutoff = Date.now() - withinHours * 3600 * 1000;
  // Confirmed live: real posted-log entries can be missing `posted_at`
  // entirely (schema drift). Treat an unparseable/missing timestamp as
  // "not recent enough to match" rather than throwing/NaN-comparing —
  // this check erring toward "not a duplicate" on bad data is the safer
  // failure direction than silently crashing the whole workflow task.
  return log.some((p) => {
    if (p.key !== candidate.key) return false;
    const t = p.posted_at ? new Date(p.posted_at).getTime() : NaN;
    return !isNaN(t) && t > cutoff;
  });
}

// Same literal link already posted on this page within 24h — this is the
// exact check that would have caught the real coloradoprimetime_ incident
// (same link posted 10+ times in a day under different story wrappers).
export function duplicateLinkRecently(candidate: Candidate, log: PostedLogEntry[], withinHours = 24): boolean {
  const cutoff = Date.now() - withinHours * 3600 * 1000;
  return log.some((p) => {
    if (p.reply_url !== candidate.link) return false;
    const t = p.posted_at ? new Date(p.posted_at).getTime() : NaN;
    return !isNaN(t) && t > cutoff;
  });
}

// Which render templates this page has already used TODAY — the deterministic
// input to the least-used-today rotation in activities/index.ts's
// chooseTemplate, ported from the real threads-automation skill file's
// "MANDATORY TEMPLATE VARIETY" rule (never default back to the same one or
// two templates; prefer whichever approved template has been used least
// today). Reads straight off the same posted-log entries every other check
// here already uses — no new storage, just a new field on PostedLogEntry.
export function templatesUsedToday(postedLog: PostedLogEntry[], dateISO: string): string[] {
  return postedLog.filter((p) => (p.posted_at || "").startsWith(dateISO) && p.template).map((p) => p.template as string);
}

// ── Political content filter — ZERO EXCEPTIONS, ported verbatim from
// ES-Threads-Automation-Skill-v1.md's Political Content Filter section. ──
//
// Tier 1: instant drop, no context check at all.
// ⛔ OPERATOR FIX (2026-08-12, real live incident): a p55 (Fearless Female
// Fighters) post shipped with the headline `"woke mma fan" "israeli
// communist"` — a real tweet about an anonymous fan getting called both
// labels in some online argument, sourced via the Twitter tier. The
// original Tier 1/Tier 2 lists only ever covered US-DOMESTIC politics
// (Trump/Democrats/Republicans/president/White House/shooting) — there was
// nothing here for geopolitics, national/ethnic/religious identity labels,
// or political-ideology name-calling, so this entire category sailed
// through with zero coverage. Same "ZERO EXCEPTIONS" policy as the
// existing entries — none of these terms have a legitimate "it's actually
// about sports" exception in a live fan-content pipeline, so they're
// instant-drop, not context-checked like the Tier 2 list below.
const POLITICAL_TIER1 = [
  /\btrump\b/i,
  /\bdemocrats?\b/i,
  /\brepublicans?\b/i,
  /white\s+house\s+shooting/i,
  /\bisrael(i|is)?\b/i,
  /\bpalestin(e|ian|ians)\b/i,
  /\bgaza\b/i,
  /\bzionis(t|ts|m)\b/i,
  /\bantisemit(e|ic|ism)\b/i,
  /\bhamas\b/i,
  /\bcommunists?\b/i,
  /\bsocialists?\b/i,
  /\bfascists?\b/i,
  /\bnazis?\b/i,
  /\bgenocide\b/i,
];
// Tier 2: context check — passes only when a sports noun is adjacent;
// blocked otherwise. A White House VENUE story is blocked even when
// sports-related (a real team/athlete White House visit still reads as
// politically-adjacent regardless of sports framing).
const POLITICAL_TIER2 = [/\bpresident\b/i, /\bshooting\b/i, /\bpolitical\b/i, /white\s+house/i];
const SPORTS_NOUNS = /\b(team|game|player|athlete|coach|league|season|championship|trophy|match|tournament|roster|draft|contract|stadium|arena|nfl|nba|mlb|nhl|ufc|mma|wnba|f1|nascar|golf|tennis|boxing)\b/i;
const WHITE_HOUSE_VENUE = /white\s+house/i;

// ⛔ OPERATOR FIX (2026-08-12, real live incident): the new "israel" Tier 1
// pattern above false-positived on real, legitimate UFC content — "UFC
// Stars Israel Adesanya and Rampage Jackson" — blocking a real MMA story
// because a real fighter's FIRST NAME is "Israel." A real geopolitical
// reference to the country is essentially never followed directly by a
// capitalized word with no preposition/possessive in between ("Israel's
// government," "in Israel," "Israel and Gaza" all have something between
// "Israel" and the next word) — "Israel Adesanya"/"Israel Adesanya's" is
// the one real, confirmed collision pattern. This is a narrow, targeted
// exception for exactly that shape, not a general loosening of the filter.
const ISRAEL_AS_NAME_RE = /\bIsrael\s+[A-Z][a-z]+/;

export function politicalContentCheck(candidate: Candidate): { blocked: boolean; reason: string | null } {
  const text = `${candidate.subject} ${candidate.headline} ${candidate.rawText || ""}`;

  if (WHITE_HOUSE_VENUE.test(text)) {
    return { blocked: true, reason: "WHITE_HOUSE_VENUE_BLOCKED" };
  }
  for (const re of POLITICAL_TIER1) {
    if (re.source === /\bisrael(i|is)?\b/i.source && ISRAEL_AS_NAME_RE.test(text)) continue;
    if (re.test(text)) return { blocked: true, reason: `POLITICAL_TIER1:${re.source}` };
  }
  for (const re of POLITICAL_TIER2) {
    if (re.test(text) && !SPORTS_NOUNS.test(text)) {
      return { blocked: true, reason: `POLITICAL_TIER2_NO_SPORTS_CONTEXT:${re.source}` };
    }
  }
  return { blocked: false, reason: null };
}

// ── Accuracy gate — a DETERMINISTIC approximation, not full per-claim LLM
// fact-checking. This project's whole design principle (see file header) is
// "a pure function or a real HTTP call, nothing here is ask-the-model-to-
// remember" — a Temporal worker activity has no LLM call at runtime to do
// what the real skill file's Routine does (re-verify every claim against a
// fetched source). What IS deterministically checkable, and is checked
// here: (1) freshness (already isFreshEnough), (2) the linked source
// actually EXISTS and its fetched text plausibly supports the headline —
// the primary matched entity name appears in the article body. This catches
// the cheap, real failure mode (headline/link mismatch, stale link reused
// for a new headline) without claiming to replicate full fact-checking.
export interface AccuracyGateResult {
  pass: boolean;
  reason: string | null;
}

// ⛔ OPERATOR FIX (2026-08-08, real live incident): a real hourly run logged
// LINK_DEAD/SOURCE_UNREACHABLE for a batch of real, live URLs (Yahoo Sports,
// Mirror, NorthJersey, etc.) — re-testing every one of them minutes later,
// from the exact same EC2 host, every single one resolved fine (HTTP 200).
// This was transient site-side flakiness or a momentary network blip during
// that run, not a real dead link or a code bug — but a single failed attempt
// with zero retry was throwing away an otherwise-good candidate (and
// therefore that page's whole slot for the hour) over a hiccup. One retry
// with a short backoff, applied to both fetch call sites that decide
// pass/fail on network reachability, costs at most a few seconds per
// candidate and meaningfully reduces false-negative drops from transient
// blips without weakening what "reachable"/"mentions the subject" means.
// ⛔ OPERATOR FIX (2026-08-10, real live incidents): this exact function is
// what `checkAccuracy` calls to verify a candidate's linked article — and
// it's the confirmed root cause of the 7 hourly-run crashes this morning
// AND (via the same missing-timeout pattern in socialSearch.ts) a 2+ hour
// stall this afternoon. `fetch(url, init)` here had NO client-side abort or
// timeout at all — a slow/hanging server on the other end could keep this
// promise pending indefinitely, well past Temporal's own activity-level
// StartToClose timeout, which only tells the WORKFLOW to retry — it does
// nothing to cancel this actual in-flight call. The zombie call then keeps
// running in this Node process, blocking real forward progress, and when
// it finally resolves the worker tries to report a completion Temporal has
// already abandoned. A real, enforced client-side timeout (independent of
// how slow or unresponsive the remote server is) closes this for good.
async function fetchWithRetry(url: string, init: RequestInit, attempts = 2, timeoutMs = 20_000): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchWithTimeout(url, init, timeoutMs);
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastError;
}

export async function accuracyGate(candidate: Candidate, primaryEntityName: string | null, maxAgeHours: number): Promise<AccuracyGateResult> {
  if (!isFreshEnough(candidate, maxAgeHours)) {
    return { pass: false, reason: "STALE_CANDIDATE" };
  }
  if (!primaryEntityName) {
    // No registered entity matched — entityOrSportMatch already gates this
    // upstream; nothing further to check evidence against here.
    return { pass: true, reason: null };
  }
  // Verify against where the claim actually came from — sourceLink for a
  // candidate whose reply `link` was resolved to an ES-owned URL (see
  // sourcing.ts's resolveExternalLink), otherwise `link` itself.
  const verifyUrl = candidate.sourceLink || candidate.link;
  try {
    const res = await fetchWithRetry(verifyUrl, { redirect: "follow" });
    if (!res.ok) return { pass: false, reason: `SOURCE_UNREACHABLE:${res.status}` };
    const body = await res.text();
    // Strip HTML tags for a plain-text substring check — cheap, no parser dependency.
    const plain = body.replace(/<[^>]+>/g, " ").toLowerCase();
    const nameLower = primaryEntityName.toLowerCase();
    if (!plain.includes(nameLower)) {
      return { pass: false, reason: `SOURCE_DOES_NOT_MENTION_SUBJECT:${primaryEntityName}` };
    }
  } catch (e) {
    return { pass: false, reason: `SOURCE_FETCH_ERROR:${(e as Error).message}` };
  }
  return { pass: true, reason: null };
}

export async function linkResolves(url: string): Promise<boolean> {
  try {
    const head = await fetchWithRetry(url, { method: "HEAD", redirect: "follow" });
    if (head.ok) return true;
    const get = await fetchWithRetry(url, { method: "GET", redirect: "follow" });
    return get.ok;
  } catch {
    return false;
  }
}

export function hasUtm(url: string): boolean {
  return url.includes("utm_source=") && url.includes("utm_medium=");
}

export function appendUtm(url: string, utmString: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${utmString}`;
}

// Freshness gate for a Beehiiv edition candidate — a stale newsletter edition
// (confirmed live: one publication's latest "confirmed" post was ~7 weeks
// old) is not a good primary source; fall back to the shared pool instead.
export function isFreshEnough(candidate: Candidate, maxAgeHours: number): boolean {
  const ageMs = Date.now() - new Date(candidate.publishedAt).getTime();
  return ageMs <= maxAgeHours * 3600 * 1000;
}

export interface CandidateCheckResult {
  pass: boolean;
  reason: string | null;
}

// The one function that runs every gate against a single candidate for a
// single page. Every field here is checked in real code — nothing here is
// an LLM "please remember to verify this."
//
// ⛔ There is deliberately no cross-page "same story on multiple pages"
// check here (see dailyRunWorkflow.ts's 2026-08-07 operator correction —
// different pages legitimately covering the same real, topically-relevant
// story is normal, not a duplicate). Real duplicate prevention stays
// per-page/per-link below (alreadyPostedRecently, duplicateLinkRecently).
// ⛔ OPERATOR FIX (2026-08-12, real live incident, severe, quantified): a
// full-day audit found "Vintage NASCAR Vault" (p46 — explicitly registered
// as "Vintage/legends-era... nostalgia page... not current-season news")
// posted FIVE separate pieces of current 2026 NASCAR news in one day
// ("SVG's Former Team Forced To Apologize," "JGR Driver Linked With an
// International Team," "Larson Wins Again," "Can Ty Gibbs shock the NASCAR
// world," "NASCAR Rumor: Dale Jr's JRM") — every one passed every existing
// gate (real entity/sport match, real accuracy) because none of those
// gates check WHEN the story is from, only WHETHER it's real and on-topic
// by keyword. A retrospective-only page's real relevance rule isn't
// keyword-based at all — it's temporal: current-season news is
// structurally off-theme regardless of how well-sourced or accurate it is.
// Detected via the page's own registered theme text (keys off "nostalgia"/
// "retrospective"/"vintage"/"legends-era" — real, human-written
// classification already present in the registry, not a new field to
// maintain) rather than a hardcoded page-ID list, so it applies to any
// future retrospective page automatically.
const RETROSPECTIVE_THEME_RE = /\b(nostalgia|retrospective|vintage|legends-era|classic\s+19\d0s)\b/i;
const RETROSPECTIVE_MAX_AGE_DAYS = 60;

export function isRetrospectiveOnlyPage(page: PageConfig): boolean {
  return RETROSPECTIVE_THEME_RE.test(page.page_theme || "");
}

function isTooRecentForRetrospectivePage(candidate: Candidate, page: PageConfig): boolean {
  if (!isRetrospectiveOnlyPage(page)) return false;
  // evergreen_search deliberately searches for content ABOUT a curated
  // retrospective angle (e.g. "1979 Petty-Pearson Daytona finish") — a
  // freshly-published retrospective piece covering that decades-old event
  // is exactly the right content for this page, but would carry TODAY'S
  // publish date and get wrongly blocked by an age check. This gate exists
  // to catch actual current-season news slipping in via keyword-only
  // matching (es_article/web_search/social_search), not to second-guess
  // the one tier built specifically for these pages.
  if (candidate.source === "evergreen_search") return false;
  const ageMs = Date.now() - new Date(candidate.publishedAt).getTime();
  return ageMs < RETROSPECTIVE_MAX_AGE_DAYS * 24 * 3600 * 1000;
}

export function runDeterministicChecks(candidate: Candidate, page: PageConfig, postedLog: PostedLogEntry[]): CandidateCheckResult {
  const political = politicalContentCheck(candidate);
  if (political.blocked) {
    return { pass: false, reason: political.reason };
  }
  if (isTooRecentForRetrospectivePage(candidate, page)) {
    return { pass: false, reason: "TOO_RECENT_FOR_RETROSPECTIVE_PAGE" };
  }
  if (!entityOrSportMatch(candidate, page)) {
    return { pass: false, reason: "NO_ENTITY_SPORT_MATCH" };
  }
  if (isTestMarkerContent(candidate)) {
    return { pass: false, reason: "TEST_MARKER_CONTENT" };
  }
  if (isPromoBettingContent(candidate)) {
    return { pass: false, reason: "PROMO_BETTING_CONTENT" };
  }
  if (isBareQuotedFragment(candidate)) {
    return { pass: false, reason: "BARE_QUOTED_FRAGMENT" };
  }
  if (isReplyTweetContent(candidate)) {
    return { pass: false, reason: "REPLY_TWEET_CONTENT" };
  }
  if (isNonEnglishContent(candidate)) {
    return { pass: false, reason: "NON_ENGLISH_CONTENT" };
  }
  if (requiresNamedEntity(candidate, page, matchedEntityNames(candidate, page))) {
    return { pass: false, reason: "NO_NAMED_ENTITY" };
  }
  // Allowlist, not the old competitor blocklist — strictly subsumes it
  // (anything on COMPETITOR_DOMAINS necessarily fails this too), and also
  // catches the real incident that motivated it: a tweet/social URL, or any
  // other external site, ending up as the reply link.
  if (!isEsOwnedLink(candidate.link)) {
    return { pass: false, reason: "LINK_NOT_ES_OWNED" };
  }
  if (alreadyPostedRecently(candidate, postedLog, 24 * 14)) {
    return { pass: false, reason: "ALREADY_POSTED" };
  }
  if (duplicateLinkRecently(candidate, postedLog, 24)) {
    return { pass: false, reason: "DUPLICATE_LINK_24H" };
  }
  return { pass: true, reason: null };
}
