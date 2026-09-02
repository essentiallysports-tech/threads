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
  // ⛔ OPERATOR REVERSAL (2026-08-15, real live incident, severe): the
  // 2026-08-10 "same-sport, different real player" fallback below (removed)
  // was already known to be too loose for a page representing one specific
  // gender division (fixed 2026-08-12, Adesanya/Rampage on Fearless Female
  // Fighters) — but it was left active for every OTHER entity/regional
  // page, and it's the exact same flaw for those too: a page representing
  // ONE specific team/athlete roster (Detroit Lions Community, entities:
  // Goff/St. Brown/Gibbs/Hutchinson/Sewell) had its last 5 straight posts
  // be about the Patriots, Giants, Browns, Raiders, and Packers — real NFL
  // news, real named players, zero connection to the Lions — confirmed live
  // via a direct user report ("This is not Detroit Lions content"). A real
  // name in the same sport was never a legitimate substitute for this
  // page's own registered roster; it just wasn't caught yet outside the
  // gender case. The 2026-08-15 sourcing.ts fix (genuinely-relevant-count
  // gate) already ensures a page short on REAL entity matches falls through
  // to web_search/social_search instead of going dark, so this fallback is
  // no longer needed to hit volume — it was only ever masking the same
  // shortage this fix now surfaces and solves correctly.
  return realRegisteredEntityMatches(candidate, page, opts);
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

// ⛔ OPERATOR FIX (2026-08-27, real live incident, editorial complaint):
// "10 Funniest Joe Rogan Quotes In His UFC Career" and "Joe Rogan's 10 Most
// Memorable Post Fight Interviews" went live on the Rogan page — real ES
// staff confirmed live: "we don't cover this, nor does the newsletter
// provide anything like this." Both were sourced from evergreen_search
// (webSearch.ts's EVERGREEN_ANGLE_QUERIES, e.g. "...famous quote interview
// moment"), which pulls in third-party listicle-farm content (thesportster.
// com) for a low-supply entity rather than real news. Operator directive:
// ban this SHAPE of content on every page, not just this one — "in [the
// entity's] absence posts are made on the particular athlete/entity's
// sport's news, not such rubbish pieces." This is the deterministic gate on
// the shape; sourcing.ts's evergreen tiers still need their own follow-up
// to stop generating this framing in the first place, not just get caught
// here after the fact.
const LISTICLE_FILLER_PATTERNS = [
  /\b\d+\s+(?:funniest|best|worst|greatest|craziest|wildest|weirdest|dumbest|smartest|most\s+\w+)\b/i,
  /\btop\s+\d+\b/i,
];

export function isListicleFillerContent(candidate: Candidate): boolean {
  const text = `${candidate.subject} ${candidate.headline} ${candidate.rawText || ""}`;
  return LISTICLE_FILLER_PATTERNS.some((re) => re.test(text));
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

// ⛔ OPERATOR FIX (2026-08-18, real live incident): "if you see from a
// consumer POV what value are they adding, why would somebody click on a
// link below." Confirmed live: Boxing Bulletin and Baltimore Ravens Community
// posted ONLY generic bio/aggregator pages all day (8/8 and 5/5 posts —
// "Tyson Fury - Wikipedia", "Tyson Fury — Profile, Record, Stats & Fight
// History", "Lamar Jackson | Biography, Statistics... | Britannica",
// "Derrick Henry NFL Player Profile and Career Stats") — every one traced to
// sourceFromEvergreenWebSearch's "{entity} career history legacy
// retrospective" query, which trivially surfaces exactly these pages. They
// pass every existing gate (real entity match, real English content, not a
// bare fragment) because nothing ever asked "does this have a story, or is
// it just a name and a stat table" — a bio page has zero narrative hook, so
// the caption/render pipeline can only ever produce a hollow "want more?
// subscribe" CTA around it, which is exactly the pattern the operator
// flagged as adding no value to a reader. This is a hard, source-agnostic
// reject — a Wikipedia/Britannica/BoxRec-style page or a generic
// "Profile/Biography/Career Stats" headline is never postable content,
// regardless of which tier found it.
// ⛔ OPERATOR FIX (2026-08-19, real live incident, TWICE more): confirmed
// live — this gate's original domain/headline lists were too narrow and
// kept letting the same class of content through with slightly different
// wording/source each time: "Mark Andrews Stats, News and Video" (a
// generic team-site player-hub page, not "Stats & News" the old regex
// expected) and "Valentina Shevchenko Quotes on BrainyQuote" (a generic
// third-party quote-compilation site never in the domain list at all).
// Operator's own framing: "what incentive does someone have to click a
// link below a compiled quotes page / a generic stats hub — there's no
// story." The real, general pattern across every incident so far: a real
// person's name followed by nothing but a small set of generic
// content-type nouns (stats/news/video/quotes/bio/profile/overview/
// highlights/record), in any order/punctuation, describing a static
// reference page rather than an actual event — OR the source domain is a
// known aggregator/compilation site by nature (quotes, stats, bio, boxing
// record databases). Broadened both checks to the general pattern instead
// of re-adding one more specific phrase/domain every time a new wording
// shows up.
// ⛔ OPERATOR FIX (2026-08-22, real live incident): "Tyson Fury - News &
// Rumors - PBC Boxing | FOX Sports" and "Max Holloway - News & Rumors -
// UFC | FOX Sports" both went out live on Combat pages — FOX Sports'
// per-athlete "news hub" pages are structurally the same generic
// aggregator-profile page as a Wikipedia bio (no single real event, just a
// standing feed of headlines about the person), but the dash/pipe-heavy
// title shape ("Name - News & Rumors - League | FOX Sports") doesn't match
// GENERIC_PROFILE_HEADLINE_RE's anchored noun-list pattern — confirmed by
// tracing real evergreen_search output that disproportionately fed Combat/
// CFB pages these pages instead of real specific articles, directly
// suppressing their real click-through (autopost_sessions near zero on
// Boxing Bulletin/Conor McGregor/Ohio State despite real total traffic).
// Domain-based, not headline-shaped, so it catches every title variant.
const GENERIC_PROFILE_DOMAINS = [
  "wikipedia.org", "britannica.com", "boxrec.com", "espn.com/boxing",
  "brainyquote.com", "goodreads.com", "azquotes.com", "quotefancy.com",
  "biography.com", "famousbirthdays.com", "celebrity.fm", "thefamouspeople.com",
  "foxsports.com",
];
// ⛔ OPERATOR FIX (2026-08-19, real live incident, THIRD time on this exact
// gate): "News & Updates" and "News & Rumors" slipped through — same class
// of generic team-site aggregator title as every prior incident, just two
// more nouns ("updates", "rumors") this list didn't have yet. Broadened
// well past the specific words seen so far to the general category of
// generic content-hub/aggregator suffixes, so the next slightly different
// phrasing of the same underlying pattern doesn't require another
// one-word patch.
const GENERIC_CONTENT_NOUNS =
  "(?:stats?|statistics|scores?|news|videos?|quotes?|bio(?:graphy)?|profile|overview|info(?:rmation)?|highlights?|recaps?|record|career|fight history|player profile|player stats|updates?|rumou?rs?|buzz|gossip|roundup|insider|tracker|reports?|watch|central|hub|digest|wire|notebook|corner|schedules?|rosters?|standings?)";
const GENERIC_PROFILE_HEADLINE_RE = new RegExp(
  // The whole headline (after a name of up to 4 capitalized words) is
  // NOTHING BUT these generic nouns joined by punctuation/connectors —
  // anchored end-to-end so a real event headline that merely CONTAINS one
  // of these words (e.g. "Ravens Trade News: X happens") still passes,
  // since it has real content beyond the generic noun list.
  `^[\\w.'-]+:?(?:\\s+[\\w.'-]+:?){0,4}\\s+${GENERIC_CONTENT_NOUNS}(?:\\s*(?:,\\s*(?:&|and)?|&|and)\\s*${GENERIC_CONTENT_NOUNS})*(?:\\s+on\\s+[\\w.'-]+)?\\s*$` + // e.g. "X Stats, News and Video", "X Quotes on BrainyQuote", "X: NFL News, Rumors, & Updates" (Oxford-comma list, optional colon after a name word)
    `|\\b(profile|biography|bio)\\b.*\\b(record|stats?|statistics|history)\\b` +
    `|\\b(record|career)\\b.*\\b(history|stats?)\\b.*\\b(fight|boxing|player)\\b` +
    `|\\bcareer (stats|history|record)s?\\b|\\bfight history\\b|\\bplayer (profile|stats)\\b|\\bstats\\s*&\\s*news\\b` +
    `|^[\\w.\\s]+\\s*-\\s*wikipedia$`,
  "i"
);

// ⛔ OPERATOR FIX (2026-08-20, real live incident — "ESPN Delivers NFL
// Scores, Stats and Highlights" went out as a real post on a national
// roundup page with no actual event/player/team named): a DIFFERENT shape
// of the same underlying problem as GENERIC_PROFILE_HEADLINE_RE — that gate
// matches "{name} + generic-noun-list" with no verb (a static reference
// page's title); this is "{outlet} {delivers/rounds up/etc.} {generic-noun-
// list}" with a verb, but the verb is itself content-free (an outlet
// "delivering" scores/stats/highlights is not a real, specific event —
// every outlet does this every day). End-anchored the same way, for the
// same reason: a real headline that happens to use "delivers" but then
// names an actual result/person/team afterward still has real content past
// the noun list and correctly passes.
const GENERIC_DELIVERY_VERBS = "(?:delivers?|provides?|rounds?\\s*up|brings?|shares?|offers?|posts?|drops?)";
const GENERIC_ROUNDUP_RE = new RegExp(
  `^[\\w.'-]+(?:\\s+[\\w.'-]+){0,2}\\s+${GENERIC_DELIVERY_VERBS}\\s+(?:[\\w.'-]+\\s+){0,2}${GENERIC_CONTENT_NOUNS}(?:\\s*(?:,\\s*(?:&|and)?|&|and)\\s*${GENERIC_CONTENT_NOUNS})*\\s*$`,
  "i"
);

// ⛔ OPERATOR FIX (2026-08-19, real live incident, FOURTH time on this exact
// gate): "Aidan Hutchinson - NFL News, Rumors, & Updates | FOX Sports" and
// "Tyson Fury - News & Rumors - PBC Boxing | FOX Sports" both slipped
// through — real generic aggregator titles, but with a trailing SOURCE
// ATTRIBUTION suffix (a scraper artifact: "| Site Name" / "- Site Name")
// that the end-anchored noun-list regex doesn't account for, so the
// pattern never reaches the string's actual end. Rather than keep growing
// one giant regex to also model every possible trailing-attribution shape
// (risking it accidentally swallowing a real headline's own dash clause),
// strip a KNOWN, bounded list of real sports-media site names from the end
// first, then run the existing check against what's left — a real
// headline's own content is never JUST a known outlet's name, so this
// can't misfire the way a generic "any capitalized trailing words" rule
// could.
const TRAILING_SOURCE_RE =
  /\s*[|]\s*[\w.'-]+(?:\s+[\w.'-]+){0,3}\s*$|\s*-\s*(?:FOX Sports|NBC Sports|CBS Sports|Sky Sports|Yahoo Sports|Yardbarker|PBC Boxing|ESPN|NFL\.com|NBA\.com|MLB\.com|Bleacher Report|The Athletic|Sporting News|NewsNow|RotoWire|USA Today|Box-pro|Grokipedia)\s*$/i;

function stripTrailingSourceAttribution(text: string): string {
  let stripped = text;
  // Repeated — "News & Rumors - PBC Boxing | FOX Sports" has TWO trailing
  // attribution segments chained together.
  for (let i = 0; i < 3; i++) {
    const next = stripped.replace(TRAILING_SOURCE_RE, "");
    if (next === stripped) break;
    stripped = next.trim();
  }
  return stripped;
}

// ⛔ OPERATOR FIX (2026-08-20, real live incident): "Dallas Goedert News &
// Updates" and "Penei Sewell Stats, News and Video" went out live as the
// ON-IMAGE headline — the exact pattern this gate exists for — even though
// the underlying candidate/caption was fine. Root cause: this gate only ever
// ran against the SOURCE candidate's headline/subject (in
// runDeterministicChecks, before rendering); nothing ever checked the
// SEPARATELY-COMPUTED on-image headline text (narrativeRenderSpec.ts's AI
// output, or its deterministic shortHeadline(candidate.headline) fallback),
// which can independently regress to this exact shape regardless of how good
// the real story is. Extracted as its own text-only function so both the
// AI-copy retry loop (narrativeRenderSpec.ts's violates()) and the final
// render spec (activities/index.ts, covering the deterministic-fallback
// case too) can check the ACTUAL text that's about to be rendered, not just
// the original source headline.
// ⛔ OPERATOR FIX (2026-08-22, real live incident): "Jazz Chisholm Jr. - New
// York Yankees Second Baseman - ESPN" went out live — a roster/player-page
// title, the same "describes who someone IS, reports no actual event"
// failure this whole gate exists for, just shaped as "Name - Team Position
// - Outlet" instead of "Name + generic noun list". GENERIC_PROFILE_HEADLINE_RE
// only catches the noun-list-suffix shape; this is a middle-of-string
// position/role description between two dashes, structurally identical to
// a Wikipedia-style bio page.
const SPORTS_POSITION_WORDS =
  "(?:quarterback|running back|wide receiver|tight end|cornerback|safety|linebacker|defensive end|offensive lineman|point guard|shooting guard|small forward|power forward|center|pitcher|catcher|shortstop|(?:first|second|third) baseman|outfielder|designated hitter|goalie|goaltender|defenseman|midfielder|striker|goalkeeper|defender|head coach)";
// ⛔ OPERATOR FIX (2026-08-22, real live incident): "Ryan Day | Head Coach |
// Ohio State Football" went out live on a CFB page — the exact same
// no-event coach/roster bio-page shape this gate exists for, just using "|"
// as the title separator (a very common <title> tag convention on team/
// league official sites) instead of "-", which the pattern didn't match.
// Accepts either separator now — same failure shape, different punctuation.
const GENERIC_ROLE_PROFILE_RE = new RegExp(
  `^[\\w.'\\s]+\\s*[-|]\\s*[\\w.'\\s]*\\b${SPORTS_POSITION_WORDS}\\b\\s*(?:[-|]\\s*[\\w.'\\s-]+)?\\s*$`,
  "i"
);
// ⛔ OPERATOR FIX (2026-08-25, real live incident, FOURTH time on this exact
// bug class): "Josh Allen | Buffalo Bills - buffalobills.com" and "Charley
// Hull | Bio | LPGA | Ladies Professional Golf Association" both went out
// live — team/league official-site roster and bio pages, same "describes
// who someone IS, reports no actual event" failure this whole gate exists
// for, but neither the domain list nor GENERIC_ROLE_PROFILE_RE's specific
// sports-position-word requirement caught them (no listed generic domain,
// no position word — just a bare team/org name or the literal word "Bio").
// Every prior fix in this file's history added ANOTHER specific domain or
// separator shape — that pattern guarantees a fifth incident on the next
// team's site. These two checks are domain-agnostic on purpose: a trailing
// " - word.com"/"| word.com" suffix is something a real narrative headline
// essentially never has (that's a raw <title> tag convention, not editorial
// writing) regardless of WHICH site it's from, and a standalone "bio"/
// "profile"/"roster" segment is the same tell independent of sport.
const TRAILING_DOMAIN_SUFFIX_RE = /[-|]\s*[a-z0-9-]+\.(?:com|org|net)\s*$/i;
const GENERIC_REFERENCE_SEGMENT_RE = /\|\s*(?:bio|profile|roster|player\s+page|official\s+site)\s*(?:\||$)/i;

export function isGenericFramingText(text: string): boolean {
  const trimmed = text.trim();
  if (GENERIC_PROFILE_HEADLINE_RE.test(trimmed)) return true;
  if (GENERIC_PROFILE_HEADLINE_RE.test(stripTrailingSourceAttribution(trimmed))) return true;
  if (GENERIC_ROUNDUP_RE.test(trimmed)) return true;
  if (GENERIC_ROUNDUP_RE.test(stripTrailingSourceAttribution(trimmed))) return true;
  if (GENERIC_ROLE_PROFILE_RE.test(trimmed)) return true;
  if (TRAILING_DOMAIN_SUFFIX_RE.test(trimmed)) return true;
  if (GENERIC_REFERENCE_SEGMENT_RE.test(trimmed)) return true;
  return false;
}

export function isGenericProfileFraming(candidate: Candidate): boolean {
  const text = `${candidate.subject} ${candidate.headline}`.trim();
  if (isGenericFramingText(text)) return true;
  // Check BOTH `link` and `sourceLink` — by the time this runs, an
  // externally-sourced candidate's `link` has usually already been swapped
  // to an ES-owned URL by resolveExternalLink (sourcing.ts), so the real
  // bio-site domain only still lives on `sourceLink`.
  for (const url of [candidate.link, candidate.sourceLink]) {
    if (!url) continue;
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      if (GENERIC_PROFILE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return true;
    } catch {
      // not a parseable absolute URL — skip
    }
  }
  return false;
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
// ⛔ OPERATOR FIX (2026-08-24, sharding rollout, real live incident,
// severe): confirmed live as the single dominant failure reason (100+
// occurrences in one cycle, well ahead of every other gate combined) —
// 50 minutes assumed each run posts a page near the START of its own
// execution, so the NEXT hourly fire (60 min later) always clears the gap
// with margin. Real sharded runs now take 30-70+ minutes, and a page's
// `posted_at` is recorded whenever Phase 2 actually gets to it — often well
// into that window, not near the start. The real gap between "this post was
// recorded" and "the next hourly execution tries this page again" is
// (60 minutes - however far into the PREVIOUS run this page's post landed),
// which routinely drops under 50 the moment a run takes more than ~10
// minutes to reach a given page — meaning most pages were failing their OWN
// next legitimate hourly attempt, not actually being protected from rapid
// duplicate posting. The real "same-run rapid double-post" case this gate
// was written for is separately covered by Phase 2's own 15-minute
// same-page stagger (dailyRunWorkflow.ts) — lowering this further doesn't
// remove that protection, just stops it from also eating the next hour's
// legitimate, distinct post.
const MIN_GAP_MINUTES = 20;

// ⛔ OPERATOR FIX (2026-08-23, real live incident): "same story repetition"
// was reported as the reason single-team fan pages (Michigan, Ohio State,
// Colorado — pages with exactly ONE registered entity, e.g. p35's only
// entity is "Michigan Wolverines") were stuck near-zero posts/day despite
// real, genuinely distinct ES articles being available (a QB-room update, a
// recruiting story, a coach's brother's lawsuit — different real events).
// Root cause traced to this exact entity-count cap, not actual duplication:
// on a single-entity page, EVERY real candidate necessarily shares that one
// registered entity (there's nothing else to attribute it to), so this cap
// hard-blocks the page at 3 posts/24h the moment it has any real content at
// all, regardless of daily_budget_max (8-12) or how many genuinely different
// stories exist. The cap's real purpose (stop one player crowding out a
// roster page's many OTHER real players — the original DJ Moore/Bills
// incident) is meaningless when there's no other entity to crowd out. Real
// duplicate-story prevention already exists independently (checkCandidate's
// alreadyPostedRecently/duplicateLinkRecently, per-link not per-entity) —
// this cap only ever added value on multi-entity pages, so it's now skipped
// entirely for single-entity ones rather than loosened for everyone.
export function topicFrequencyCheck(
  primaryEntityName: string | null,
  primarySportGroup: string | null,
  postedLog: PostedLogEntry[],
  isSingleEntityPage = false,
  // ⛔ OPERATOR FIX (2026-08-23): identical blind spot to the entity cap
  // above, for the league/sport-group cap — a page registered under exactly
  // one sport_group (entities:[] pages that only pass entityOrSportMatch via
  // the sport-group substring path) necessarily has every real candidate
  // share that one sport_group, so this 5/24h cap permanently caps such a
  // page's 6th+ post of the day regardless of daily_budget_max. Skipped the
  // same way, for the same reason.
  isSingleSportGroupPage = false
): FrequencyCheckResult {
  const now = Date.now();
  const last24h = postedLog.filter((p) => withinHours(p, 24, now));

  const mostRecentPostTime = last24h.reduce((latest, p) => {
    const t = p.posted_at ? new Date(p.posted_at).getTime() : 0;
    return t > latest ? t : latest;
  }, 0);
  if (mostRecentPostTime > 0 && now - mostRecentPostTime < MIN_GAP_MINUTES * 60 * 1000) {
    return { pass: false, reason: `TOPIC_FREQUENCY_MIN_GAP_${MIN_GAP_MINUTES}M` };
  }

  if (primaryEntityName && !isSingleEntityPage) {
    const entityCount = last24h.filter((p) => p.entity === primaryEntityName).length;
    if (entityCount >= 3) return { pass: false, reason: `TOPIC_FREQUENCY_ENTITY_CAP:${primaryEntityName}` };
  }
  if (primarySportGroup && !isSingleSportGroupPage) {
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
export function dominantNarrativeCheck(
  primaryEntityName: string | null,
  postedLog: PostedLogEntry[],
  isSingleEntityPage = false
): FrequencyCheckResult {
  // ⛔ OPERATOR FIX (2026-08-23): see topicFrequencyCheck's comment above —
  // same root bug. On a single-entity page every post necessarily matches
  // the page's one registered entity, so this ratio is mathematically ~100%
  // forever, not a real signal of narrative crowding.
  if (!primaryEntityName || isSingleEntityPage) return { pass: true, reason: null };
  const now = Date.now();
  const last7d = postedLog.filter((p) => withinHours(p, 24 * 7, now));
  if (last7d.length < 4) return { pass: true, reason: null };
  const entityCount = last7d.filter((p) => p.entity === primaryEntityName).length;
  if ((entityCount + 1) / (last7d.length + 1) > 0.25) {
    return { pass: false, reason: `DOMINANT_NARRATIVE_CAP:${primaryEntityName}` };
  }
  return { pass: true, reason: null };
}

// ⛔ OPERATOR FIX (2026-08-24, real live incident, severe): confirmed live
// via a 197-post audit sample — 10+ real clusters where the SAME page
// posted the SAME real-world event twice within hours, reworded each time
// (newyorkyankeescommunity: the Gerrit Cole "passed Clemens, 6 IP/8 K"
// story at 11:48 and again at 17:30 the same day; kingscourtchronicles: a
// former-employee lawsuit story 9 hours apart; lsu_community_central: the
// same Kiffin callout twice, ~2 hours apart; and more). None of this is
// caught by any existing gate — duplicateLinkRecently/alreadyPostedRecently
// both key off the candidate's LINK, but these are usually genuinely
// DIFFERENT real articles/sources (or the same event surfaced twice by
// different sourcing tiers with different keys) about the identical
// real-world event — no link-based check can ever catch "different URL,
// same story," because the URLs really are different strings.
//
// This has to be a semantic check, not a lexical one — same reasoning that
// justified isCoherentHeadlineViaAI (narrativeRenderSpec.ts) for catching
// incoherent-but-structurally-valid headlines. Cheap pre-filter first (only
// compare against this page's own recent posts that share the SAME primary
// entity — a strong, free prior that a same-event collision is even
// plausible) so the real AI call only fires when there's something
// genuine to compare against, not on every candidate.
export interface DuplicateStoryCheckResult {
  pass: boolean;
  reason: string | null;
}

const AI_GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const AI_GATEWAY_MODEL = "anthropic/claude-sonnet-4-5";
// ⛔ OPERATOR FIX (2026-08-31, policy): 48h -> 72h — an identical story is
// fine to repost once real time has passed, but the cutoff should match the
// 72h general freshness cap (dailyRunWorkflow.ts) rather than sit shorter
// than it.
const DUPLICATE_STORY_WINDOW_HOURS = 72;

async function isDuplicateStoryViaAI(candidateHeadline: string, recentHeadlines: string[]): Promise<{ duplicate: boolean; matched?: string }> {
  const apiKey = process.env.VERCEL_AI_GATEWAY_KEY;
  // Fail OPEN, same policy as every other AI-judgment gate in this pipeline
  // (isCoherentHeadlineViaAI, factCheckClaim) — an infra hiccup on this
  // specific check must never cost the whole run's volume; a real link/
  // dedup incident is worse than an occasional missed semantic duplicate.
  if (!apiKey) return { duplicate: false };
  const prompt = [
    `A sports fan page is about to post this NEW headline:`,
    `"${candidateHeadline}"`,
    ``,
    `Here are headlines this SAME page already posted recently:`,
    ...recentHeadlines.map((h, i) => `${i + 1}. "${h}"`),
    ``,
    `Is the NEW headline describing the SAME specific real-world event as any of the headlines above — the same game, same quote, same announcement, same incident — just worded differently? Answer true ONLY if it's genuinely the same underlying event. A genuinely NEW development involving the same person/team (a follow-up, a reaction to the earlier event, a different game, an update to a developing story) is NOT a duplicate — answer false for that. When in doubt, answer false; this check exists to catch obvious reposts, not to block legitimate follow-up coverage.`,
    `Output ONLY a JSON object: {"duplicate": true, "matched": "<the exact headline number/text it duplicates>"} or {"duplicate": false}. No markdown, no explanation.`,
  ].join("\n");
  try {
    const res = await fetchWithTimeout(
      AI_GATEWAY_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: AI_GATEWAY_MODEL,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 200,
          temperature: 0.3,
        }),
      },
      30_000
    );
    if (!res.ok) throw new Error(`AI gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("AI gateway returned no text content");
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    const parsed = JSON.parse(cleaned);
    return { duplicate: parsed?.duplicate === true, matched: parsed?.matched };
  } catch (e) {
    console.error(`isDuplicateStoryViaAI: failed, treating as not-duplicate: ${(e as Error).message}`);
    return { duplicate: false };
  }
}

export async function duplicateStoryCheck(
  candidate: Candidate,
  primaryEntityName: string | null,
  postedLog: PostedLogEntry[]
): Promise<DuplicateStoryCheckResult> {
  if (!primaryEntityName) return { pass: true, reason: null }; // no entity match — nothing reliable to compare against
  const now = Date.now();
  const recentSameEntity = postedLog
    .filter((p) => p.entity === primaryEntityName && withinHours(p, DUPLICATE_STORY_WINDOW_HOURS, now) && p.headline)
    .slice(-5); // bound the prompt — the most recent handful is what a real reader would actually remember seeing
  if (recentSameEntity.length === 0) return { pass: true, reason: null }; // nothing on this entity recently — cheap exit, no AI call needed

  const result = await isDuplicateStoryViaAI(
    candidate.headline,
    recentSameEntity.map((p) => p.headline!)
  );
  if (result.duplicate) {
    return { pass: false, reason: `DUPLICATE_STORY_SAME_EVENT:${primaryEntityName}${result.matched ? `:${result.matched}`.slice(0, 100) : ""}` };
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
  // ⛔ OPERATOR FIX (2026-08-31, real live incident): a single-athlete fan
  // page (page_type "entity") registers its subject's real rivals/peers as
  // their own entity slots too, at lower weight, so genuine crossover
  // stories ("McGregor vs Poirier") still match — but that let a story
  // ENTIRELY about a rival, zero mention of the page's actual subject, pass
  // this gate just because the rival is also a registered slot. Live
  // incident: p54 (Conor McGregor fan page, McGregor weight 40) posted a
  // Khabib Nurmagomedov/Islam Makhachev story — Islam is a real registered
  // slot (weight 10, for legitimate crossover coverage) but McGregor wasn't
  // mentioned at all. Regional/team pages are unaffected — a roster has no
  // single "flagship" to prefer over teammates, so this only tightens
  // page_type "entity" (one-athlete) pages, and only requires the match
  // include the page's OWN highest-weight entity, not exclusively it.
  if (page.page_type === "entity") {
    const maxWeight = Math.max(...page.entities.map((e) => e.weight));
    const flagshipKeywords = new Set(
      page.entities
        .filter((e) => e.weight === maxWeight)
        .flatMap((e) => (e.keywords.length > 0 ? e.keywords : [e.name]))
        .map((k) => k.toLowerCase())
    );
    return !matchedNames.some((m) => flagshipKeywords.has(m.toLowerCase()));
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

// ⛔ OPERATOR FIX (2026-08-22, real live incident): this check has been
// silently DEAD since it was written — it compares `p.reply_url` (the
// STORED value, which is always `candidate.link` + a UTM query string, per
// buildReplyLink in caption.ts: `${candidate.link}${sep}${utm}...`) against
// a fresh candidate's bare `candidate.link` (no query string). Those two
// can never be equal, so this "duplicate link" gate has never once fired —
// confirmed live on the sibling es-threads-temporal-photo pipeline (same
// checks.ts, forked verbatim): the exact class of incident this function's
// own original comment named ("same link posted... under different story
// wrappers") happened again, TWICE in one day, on lsu_community_central —
// two different real articles each posted twice via the multi-angle
// sourcing feature's `key`/`key:angle` variants, which deliberately use
// different dedup KEYS for the same real link. This check exists
// specifically as the backstop for that exact case, and it was never
// working on either pipeline. Compare the base URL (everything before `?`)
// on both sides instead of the raw strings.
function baseUrlNoQuery(url: string): string {
  const qIndex = url.indexOf("?");
  return qIndex === -1 ? url : url.slice(0, qIndex);
}

// Same literal link already posted on this page within 24h — this is the
// exact check that would have caught the real coloradoprimetime_ incident
// (same link posted 10+ times in a day under different story wrappers).
//
// ⛔ OPERATOR FIX (2026-08-22, caught while verifying the fix above, before
// it caused real damage): a "subscribe" candidate's link is deliberately a
// generic newsletter homepage, the SAME URL for every genuinely different
// real story that falls back to a "subscribe for more" CTA (confirmed live:
// essentiallysportsmedia legitimately posted 13 different real headlines
// all reusing essentiallysports-daily.beehiiv.com as their CTA link in one
// week) — the base-URL fix above would have flagged every one of those as
// "the same story repeated" and silently dropped real, distinct candidates.
// Skip the check entirely for subscribe-context candidates, and skip any
// historical entry that was ALSO a subscribe link (identifiable by the same
// utm_content=reply_link tag buildReplyLink always adds for that case) —
// never compare a subscribe link's shared homepage against itself.
export function duplicateLinkRecently(candidate: Candidate, log: PostedLogEntry[], withinHours = 24): boolean {
  if (candidate.linkContext === "subscribe") return false;
  const cutoff = Date.now() - withinHours * 3600 * 1000;
  const candidateBase = baseUrlNoQuery(candidate.link);
  return log.some((p) => {
    if (!p.reply_url || p.reply_url.includes("utm_content=reply_link")) return false;
    if (baseUrlNoQuery(p.reply_url) !== candidateBase) return false;
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
    // Strip HTML tags for a plain-text substring check — cheap, no parser
    // dependency. ⛔ OPERATOR FIX (2026-08-23, real live incident): confirmed
    // live drop, p52 ("Kobe 8/24 Legacy") — SOURCE_DOES_NOT_MENTION_SUBJECT:
    // Kobe Bryant on a real tribute/retrospective article that referred to
    // him by first name throughout, never spelling the full registered two-
    // word form. Also decode HTML entities before matching — an un-decoded
    // "&#8217;"/"&rsquo;" apostrophe means a straight-apostrophe registered
    // name (Ja'Marr Chase, De'Aaron Fox, Shaquille O'Neal) can never match
    // even when the full name IS present verbatim in the rendered page. The
    // entity was already confirmed relevant upstream by entityOrSportMatch/
    // realRegisteredEntityMatches before ever reaching this gate — this
    // check only re-confirms the SPECIFIC LINKED ARTICLE is really about it,
    // so accepting a strong single-token match (the surname, the part of a
    // name people are least likely to omit) is a safe loosening, not a
    // weakening of what "mentions the subject" means.
    const plain = body
      .replace(/<[^>]+>/g, " ")
      .replace(/&(?:rsquo|lsquo|#8216|#8217|#x2018|#x2019);/gi, "'")
      .replace(/&(?:rdquo|ldquo|#8220|#8221|#x201c|#x201d);/gi, '"')
      .replace(/&(?:amp|#38|#x26);/gi, "&")
      .replace(/&nbsp;/gi, " ")
      .toLowerCase();
    const nameLower = primaryEntityName.toLowerCase();
    // Any single significant token (first OR last name, length > 2) — not
    // just the surname. The real motivating incident (Kobe Bryant) is a
    // FIRST-name-only reference, the more common convention in tribute/
    // retrospective writing for a globally recognized figure; a surname-only
    // fallback would have missed that exact case.
    const nameTokens = nameLower.split(/\s+/).filter((t) => t.length > 2);
    const matches = plain.includes(nameLower) || nameTokens.some((t) => plain.includes(t));
    if (!matches) {
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

export type CaptionAgeTone = "current" | "standard" | "retro";

// ES policy (2026-08-31): urgency/"breaking" framing is only honest up to
// 48h old; nostalgia/retro framing is appropriate past 6 months; the wide
// middle band gets plain news tone with no urgency language.
export const BREAKING_ELIGIBLE_MAX_HOURS = 48;
export const RETRO_TONE_MIN_DAYS = 180;

export function classifyCaptionAgeTone(candidate: Candidate): CaptionAgeTone {
  // sourceFromEsEvergreenArticles (sourcing.ts) deliberately stamps
  // publishedAt as "now" — ES-MCP's older-article results carry no real
  // date, and this tier is a 5-YEAR lookback by design (genuinely-old ES
  // catalog content, meant to be reused as banter/legacy content per
  // Aashish, not as if it just happened). Trusting that fake timestamp here
  // would do the opposite of this tier's own purpose: every evergreen
  // candidate would read as "current" and become breaking-news-eligible.
  // We don't know the TRUE age (could be weeks or years old), so "standard"
  // (plain news tone, no urgency, no false immediacy) is the only always-
  // correct answer — "retro" would overclaim an age we can't confirm.
  if (candidate.source === "evergreen_search") return "standard";
  const ageMs = Date.now() - new Date(candidate.publishedAt).getTime();
  if (ageMs <= BREAKING_ELIGIBLE_MAX_HOURS * 3600 * 1000) return "current";
  if (ageMs >= RETRO_TONE_MIN_DAYS * 24 * 3600 * 1000) return "retro";
  return "standard";
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
  //
  // ⛔ OPERATOR FIX (2026-08-24, real live incident, resolves the 2026-08-23
  // flagged decision above): confirmed live on the two newly-onboarded
  // retrospective pages (Classic NASCAR, MMA Archives) — TOO_RECENT_FOR_
  // RETROSPECTIVE_PAGE was the failure reason on the overwhelming majority
  // of ALL attempted candidates (60+ and 40+ respectively in one run alone),
  // because sourceFromEsArticles legitimately surfaces real, CURRENT stories
  // that are genuinely ABOUT a registered legend (e.g. "Jeff Gordon
  // advocates for a modern IROC revival") — exactly the content this page's
  // audience wants, just rejected for having an accurate "today" timestamp.
  // The 2026-08-23 concern (a current story that merely REFERENCES a legend
  // in passing, e.g. "X breaks Kobe's record", shouldn't count) is real, but
  // narrower than "any es_article" — checked directly here: only exempt when
  // the candidate's own headline/subject text actually names one of this
  // page's REGISTERED legend entities via its curated keywords, not just any
  // current story. A passing mention without a registered-keyword match
  // still gets the strict age check below, same as before this fix.
  if (candidate.source === "evergreen_search") return false;
  // ⛔ OPERATOR FIX (2026-08-24, same day, real live incident): the es_article
  // fix above didn't move the needle for Classic NASCAR — confirmed live the
  // dominant failures there were nascar.com/hendrickmotorsports.com/
  // azquotes.com/nascarhall.com results (Jeff Gordon retrospective pieces,
  // Richard Petty Q&As, legend quote pages), all tagged "web_search" or
  // "social_search", not "es_article". Same underlying bug, two more source
  // types that hit the identical wall — this gate's own comment already
  // named "es_article/web_search/social_search" as the three keyword-only
  // tiers it exists to police, but only es_article got the entity-match
  // exemption. Extending the same check (must actually name a registered
  // legend, not just any current story) to all three keyword-matched tiers.
  if (candidate.source === "es_article" || candidate.source === "web_search" || candidate.source === "social_search") {
    const text = `${candidate.headline} ${candidate.subject || ""}`.toLowerCase();
    const mentionsRegisteredLegend = page.entities.some((e) => e.keywords.some((k) => text.includes(k.toLowerCase())));
    if (mentionsRegisteredLegend) return false;
  }
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
  if (isListicleFillerContent(candidate)) {
    return { pass: false, reason: "LISTICLE_FILLER_CONTENT" };
  }
  if (isBareQuotedFragment(candidate)) {
    return { pass: false, reason: "BARE_QUOTED_FRAGMENT" };
  }
  if (isGenericProfileFraming(candidate)) {
    return { pass: false, reason: "GENERIC_PROFILE_FRAMING" };
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
