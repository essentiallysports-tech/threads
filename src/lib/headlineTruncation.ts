// Shared word-boundary truncation safety net — extracted 2026-09-08
// (comprehensive audit) from activities/index.ts's shortHeadline, which is
// where every fix below was originally built and proven against real live
// incidents. narrativeRenderSpec.ts's buildNarrativeRenderCopy had its OWN,
// separate, never-updated copy of this same idea (capHeadlineLength) that
// only ever checked TRAILING_STOPWORDS — none of the fixes below — even
// though it sits on a genuinely live path (any AI-authored headline over
// hardCeiling words that passes the structural + coherence checks reaches
// it, not just a fallback case). Two independently-maintained copies of the
// same safety net is exactly how that gap opened in the first place; both
// callers now share this one module instead.
//
// ⛔ OPERATOR FIX (2026-08-15, real live incident): a real card shipped
// "Vrabel Refuses to Give Up Major" — the truncated headline ends on
// "major," a dangling adjective that needs a noun after it ("Major"
// WHAT?). TRAILING_STOPWORDS only ever covered articles/prepositions/
// conjunctions; it has no concept of an adjective/intensifier that reads
// as unfinished without whatever noun it was modifying. This is a curated
// list of the same failure mode with a different part of speech — common
// escalating/intensifying words that appear right before a noun in this
// pipeline's real headlines, never a coherent way to end one.
export const TRAILING_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "by",
  "for", "with", "from", "as", "is", "are", "was", "were", "his", "her",
  "its", "that", "this", "into", "over", "under", "after", "before",
  "amid", "during", "about", "vs", "vs.",
]);

export const DANGLING_MODIFIERS = new Set([
  "major", "massive", "huge", "biggest", "big", "key", "critical", "new",
  "next", "final", "latest", "surprise", "historic", "significant",
  "record-breaking", "shocking", "stunning", "official", "important",
  "exclusive", "breaking", "first", "last", "top", "worst", "best", "crucial",
]);

// ⛔ OPERATOR FIX (2026-09-08, comprehensive audit): confirmed across 6 real
// historical headlines (p35/p44/p47/p80) truncating to end on a bare modal
// auxiliary — "...Michael Jordan Should", "...LeBron James Will" — which
// dangle exactly like DANGLING_MODIFIERS' adjectives do (a modal always
// promises a main verb that hasn't arrived: "Should" WHAT?), but are a
// distinct part of speech from that set's adjectives/intensifiers, so kept
// as their own named set rather than folded into a misleadingly-named one.
export const MODAL_VERBS = new Set([
  "should", "could", "would", "can", "will", "might", "must", "may", "shall",
  "shouldn't", "couldn't", "wouldn't", "can't", "won't", "mightn't", "mustn't",
]);

// ⛔ OPERATOR FIX (2026-09-08, real live incident): a real card rendered
// "NBA Rival Reveals How Kobe Bryant" — cut from "...How Kobe Bryant Took
// Care of His Family After [a wildfire]." Every word in the truncated
// output is fine on its own ("Bryant" is nobody's dangling modifier or
// stopword), so neither check above ever fired, but the sentence as a
// whole dangles: "How Kobe Bryant" opens a clause that needs its own verb
// ("...took care of...") to mean anything, and the cut landed before it.
// TRAILING_STOPWORDS/DANGLING_MODIFIERS only ever inspect the LAST word —
// neither has a concept of an EARLIER word committing the sentence to a
// predicate that hasn't arrived yet. Distinct failure mode from both: this
// is common specifically because these words read as completely natural
// mid-headline ("Reveals How", "Explains Why", "Shows What") right up
// until a fixed word-count cut lands a few words after one.
export const CLAUSE_OPENERS = new Set(["how", "why", "what", "when", "where", "which", "who", "whether"]);
// Extra words this pipeline gives a clause to reach its own verb/predicate
// before applying the normal last-word check — long enough for the common
// "how/why/what SUBJECT VERB..." shape, bounded so this still respects
// hardCeiling rather than always maxing it out.
export const CLAUSE_RESOLUTION_ALLOWANCE = 3;

// ⛔ OPERATOR FIX (2026-09-08, real live incident): "Ryan Day Confirms Real
// Reason Jeremiah" — cut right after "Jeremiah", leaving the first half of
// "Jeremiah Smith" stranded with no surname. Not a clause-opener case (no
// how/why/what involved) and not a dangling modifier/stopword either —
// "Jeremiah" is a perfectly normal word to end on by every check above.
// This is a DIFFERENT failure shape: severing a multi-word proper name in
// half. A hardcoded list of first names would be the same whack-a-mole as
// TRAILING_STOPWORDS/DANGLING_MODIFIERS/CLAUSE_OPENERS before it — instead,
// this uses the REAL names the story is actually about (athleteNames,
// already resolved by the time shortHeadline is called) to check whether
// the cut lands mid-name, and if so extends exactly far enough to finish
// THAT specific name (which may be more than 2 words, e.g. "Kyle Van
// Noy") — grounded in this candidate's own real data, not a guessed list.
export function extensionToCompleteSplitName(words: string[], cutIndex: number, knownNames: string[]): number {
  const endsWith = words.slice(0, cutIndex).join(" ").toLowerCase();
  for (const name of knownNames) {
    const nameWords = name.trim().split(/\s+/);
    if (nameWords.length < 2) continue;
    for (let k = 1; k < nameWords.length; k++) {
      if (endsWith.endsWith(nameWords.slice(0, k).join(" ").toLowerCase())) {
        return nameWords.length - k;
      }
    }
  }
  return 0;
}

// ⛔ OPERATOR FIX (2026-09-08, real live incident): "...Silence on Tyson
// Fury's" — the name-completion fix above correctly extended the cut from
// "Tyson" to finish the name "Tyson Fury", but "Fury's" is a POSSESSIVE,
// which demands a following noun ("Fury's Trilogy Callout") exactly the
// same way a dangling modifier demands one — completing the NAME isn't the
// same as completing the GRAMMAR built on top of it. A possessive ending
// is unconditionally incomplete, no name list or clause-word list needed —
// simpler and more general than either of the two fixes before it.
export const POSSESSIVE_RE = /['’]s$/;

// Never returns a string ending on a dangling article/preposition/modifier/
// modal/possessive, or a clause opened but never resolved — extends
// word-by-word past maxWords (up to a hard ceiling) until it lands on a
// real content word, or exhausts the text. A slightly longer, coherent line
// beats a shorter, broken one.
export function truncateAtWordBoundary(text: string, maxWords: number, hardCeiling: number, knownNames: string[] = []): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();

  const opensUnresolvedClause = words
    .slice(0, maxWords)
    .some((w) => CLAUSE_OPENERS.has(w.replace(/[^a-zA-Z'-]/g, "").toLowerCase()));
  let end = opensUnresolvedClause ? Math.min(maxWords + CLAUSE_RESOLUTION_ALLOWANCE, hardCeiling) : maxWords;

  while (end < words.length && end < hardCeiling) {
    const last = words[end - 1].replace(/[^a-zA-Z'-]/g, "").toLowerCase();
    const endsInPunctuation = /[:;,]$/.test(words[end - 1]);
    const endsInPossessive = POSSESSIVE_RE.test(words[end - 1]);
    if (!TRAILING_STOPWORDS.has(last) && !DANGLING_MODIFIERS.has(last) && !MODAL_VERBS.has(last) && !endsInPunctuation && !endsInPossessive) break;
    end++;
  }

  const nameExtension = extensionToCompleteSplitName(words, end, knownNames);
  if (nameExtension > 0) end = Math.min(end + nameExtension, hardCeiling, words.length);

  // Completing a split name can itself land on a possessive form of that
  // SAME name ("Tyson" -> "Tyson Fury's") — one more bounded pass to catch
  // that, and any stopword it might in turn expose.
  while (end < words.length && end < hardCeiling) {
    const last = words[end - 1].replace(/[^a-zA-Z'-]/g, "").toLowerCase();
    const endsInPossessive = POSSESSIVE_RE.test(words[end - 1]);
    if (!TRAILING_STOPWORDS.has(last) && !DANGLING_MODIFIERS.has(last) && !MODAL_VERBS.has(last) && !endsInPossessive) break;
    end++;
  }

  return words.slice(0, end).join(" ").replace(/[:;,]+$/, "");
}
