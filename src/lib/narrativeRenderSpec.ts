// ⛔ OPERATOR ARCHITECTURE CHANGE (2026-08-10): "Clear instructions should go
// from the Anthropic key in Vercel AI Gateway to OpenArt — this entity, this
// text, this is how it should be placed, all by Claude." Direct analogue of
// the Facebook full pipeline's shard routine, where Claude itself reasons
// per-post about the on-image headline/accent/kicker rather than a
// deterministic keyword-regex lookup. Before this file, activities/index.ts
// computed the on-image copy via chooseKicker (5 hardcoded keyword
// patterns), chooseAccentWord (a fixed ~25-word regex bank), and
// shortHeadline (mechanical word-boundary truncation) — none of which
// reason about what's actually dramatic or coherent about THIS specific
// story. This is the exact same call pattern already proven for captions
// (narrativeCaption.ts): real Claude call via the Vercel AI Gateway,
// strictly validated, NEVER trusted blindly — falls back to the existing
// deterministic values on any failure or policy violation.

import { Candidate, PageConfig } from "./types";
import { TemplateId } from "./renderSpec";
import { fetchWithTimeout } from "./httpUtil";

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const MODEL = "anthropic/claude-sonnet-4-5";

export interface RenderCopy {
  headline: string;
  accent: string | null;
  kicker: string;
  story_type: string;
}

export interface RenderCopyResult extends RenderCopy {
  usedFallback: boolean;
  violation?: string;
}

const LAYOUT_DESCRIPTIONS: Record<TemplateId, string> = {
  hero: "a milestone/hero card — full-bleed dominant shot, heroic low angle, for a big achievement or record",
  standard_editorial: "a standard editorial news card — plain, straightforward coverage",
  dramatic_news: "a dramatic single-subject news card — tight, high-drama shot for firings/suspensions/trades/controversy",
  comparison: "a split-frame head-to-head comparison card between two people",
  quote: "a quote card built around one specific quoted line from the story",
};

function stripWrappingQuotesAndMarkdown(text: string): string {
  let t = text.trim();
  if ((t.startsWith("{") && t.endsWith("}"))) return t; // already bare JSON
  const codeBlock = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return codeBlock ? codeBlock[1].trim() : t;
}

async function callGateway(prompt: string, apiKey: string): Promise<string> {
  const res = await fetchWithTimeout(
    GATEWAY_URL,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
        temperature: 0.7,
      }),
    },
    45_000
  );
  if (!res.ok) throw new Error(`AI gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`AI gateway returned no text content: ${JSON.stringify(json).slice(0, 300)}`);
  return stripWrappingQuotesAndMarkdown(content);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function buildPrompt(
  candidate: Candidate,
  page: PageConfig,
  athleteNames: string[],
  layout: TemplateId,
  fallback: RenderCopy,
  retryNote?: string
): string {
  const facts = [
    `Headline: ${stripHtml(candidate.headline)}`,
    candidate.rawText ? `Additional detail: ${stripHtml(candidate.rawText)}` : null,
    athleteNames.length > 0 ? `Named people/teams in this story: ${athleteNames.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    `You are writing the ON-IMAGE copy for a sports fan-page infographic card — the words that get rendered directly onto the card, not the social caption. This card has already been decided to be a ${LAYOUT_DESCRIPTIONS[layout]}.`,
    ``,
    `Here are the ONLY real facts about this story — do not invent any detail, quote, number, or context beyond what's given:`,
    facts,
    ``,
    `Write exactly these fields, reasoning about what's actually dramatic/newsworthy about THIS specific story (never a generic label):`,
    `- headline: the giant on-image headline. A complete, coherent thought, 4-6 words when possible (never cut off mid-sentence — a slightly longer complete phrase beats a shorter broken one). Must be a real claim from the facts above, never rephrased into something the facts don't say.`,
    `- accent: ONE word — chosen FROM THE HEADLINE YOU JUST WROTE, copied verbatim (same spelling/case-insensitive match) — that carries the story's real drama (e.g. a word like "STUNNING", "CONFIRMED", "CHAOS", "SNUBBED"). This is NOT a separate word you invent and place elsewhere on the card — it is highlighted IN PLACE, inside the one continuous headline sentence, in accent color. Never pick a word that isn't already sitting in your own headline text; a headline with no genuinely dramatic word in it means you return null rather than forcing an accent, and NEVER rewrite the headline just to shoehorn a dramatic word in. Rules: it must NEVER be part of any named person's own name (${athleteNames.join(", ") || "none named"}), and it must be a DIFFERENT word from "${fallback.kicker}" (the card's fixed CTA strip, decided separately from your reasoning here — never repeat that text).`,
    `- story_type: a short phrase describing the story's real shape (e.g. "trade rumor", "career milestone", "coaching controversy") — this only steers the prompt's tone, keep it to 2-4 words.`,
    retryNote ? `\nIMPORTANT — your previous attempt failed because: ${retryNote}. Fix that specifically.` : "",
    ``,
    `Output ONLY a JSON object with exactly these 3 keys (headline, accent, story_type) — no markdown, no explanation, no code fence. accent may be null.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ⛔ OPERATOR FIX (2026-08-11, real live incidents): "COACH: THAT'S WEILI'S
// BELT" + a disconnected "CLAIMED" floating separately, "LAKERS FACE LUKA
// DONCIC EXIT WARNING" with a redundant standalone "WARNING" above it — the
// AI was free to invent ANY dramatic word for accent, with nothing
// requiring it to actually be a word from the headline it just wrote. The
// user's own framing: the power word must be ONE WORD FROM THE SENTENCE,
// highlighted in place — never a separate word written apart from it. This
// check enforces that structurally: an accent that isn't a literal
// whole-word match inside the headline it's supposed to belong to is
// rejected the same as any other policy violation, forcing a retry (or a
// null accent) rather than a disconnected floating word.
export function accentIsWordInHeadline(accent: string, headline: string): boolean {
  const words = headline.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
  return words.includes(accent.trim().toLowerCase());
}

function violates(parsed: any, athleteNames: string[], kicker: string): string | null {
  if (!parsed || typeof parsed !== "object") return "NOT_AN_OBJECT";
  if (typeof parsed.headline !== "string" || !parsed.headline.trim()) return "MISSING_HEADLINE";
  if (typeof parsed.story_type !== "string" || !parsed.story_type.trim()) return "MISSING_STORY_TYPE";
  if (parsed.accent !== null && parsed.accent !== undefined) {
    if (typeof parsed.accent !== "string" || !parsed.accent.trim()) return "INVALID_ACCENT_TYPE";
    const accentLower = parsed.accent.trim().toLowerCase();
    if (accentLower === kicker.trim().toLowerCase()) return "ACCENT_DUPLICATES_KICKER";
    if (!accentIsWordInHeadline(parsed.accent, parsed.headline)) return "ACCENT_NOT_IN_HEADLINE";
    for (const name of athleteNames) {
      const lastName = name.trim().split(/\s+/).pop()?.toLowerCase() || "";
      if (lastName.length > 2 && (accentLower === lastName || accentLower.includes(lastName))) return "ACCENT_FROM_NAME";
    }
  }
  return null;
}

const TRAILING_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "by",
  "for", "with", "from", "as", "is", "are", "was", "were", "his", "her",
  "its", "that", "this", "into", "over", "under", "after", "before",
  "amid", "during", "about", "vs", "vs.",
]);

// Same word-boundary safety net shortHeadline already applies to the
// deterministic path — a headline that came back a little long from the AI
// still never gets cut into a dangling article/preposition.
function capHeadlineLength(headline: string, maxWords = 6, hardCeiling = 10): string {
  const words = headline.trim().split(/\s+/);
  if (words.length <= hardCeiling) return headline.trim();
  let end = maxWords;
  while (end < words.length && end < hardCeiling) {
    const last = words[end - 1].replace(/[^a-zA-Z']/g, "").toLowerCase();
    if (!TRAILING_STOPWORDS.has(last)) break;
    end++;
  }
  return words.slice(0, end).join(" ").replace(/[:;,]+$/, "");
}

function buildLayoutPrompt(candidate: Candidate, eligible: TemplateId[], usedTodayCounts: Record<string, number>): string {
  const options = eligible.map((t) => `- "${t}": ${LAYOUT_DESCRIPTIONS[t]} (used ${usedTodayCounts[t] ?? 0}x today)`).join("\n");
  return [
    `Pick which visual layout best fits this real sports story. Options (pick exactly one, by its exact key):`,
    options,
    ``,
    `Story facts:`,
    `Headline: ${stripHtml(candidate.headline)}`,
    candidate.rawText ? `Additional detail: ${stripHtml(candidate.rawText)}` : "",
    ``,
    `Reason about which layout actually fits the STORY'S shape and emotional weight (e.g. a big career milestone deserves the hero layout, a firing/suspension deserves dramatic_news, plain roster news fits standard_editorial) — don't just default to whichever's been used least today, though prefer a less-used option when two layouts fit almost equally well.`,
    `Output ONLY a JSON object: {"layout": "<one of the exact keys above>"}. No markdown, no explanation.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ⛔ OPERATOR PARITY FIX (2026-08-10): "at least [layout reasoning] can be
// implemented here as well." Previously chooseTemplate (activities/index.ts)
// picked purely by keyword-eligibility + least-used-today rotation — never
// reasoning about whether the layout's actual visual weight (heroic vs
// dramatic vs plain) fits the story. Constrained to the SAME eligible set
// the deterministic path already computes (a structural constraint tied to
// how many real photos exist), so this can only pick something that was
// already going to be tried anyway — it just picks the better-fitting one
// among them instead of pure rotation.
export async function chooseLayoutViaAI(
  candidate: Candidate,
  page: PageConfig,
  eligible: TemplateId[],
  usedTodayCounts: Record<string, number>,
  fallback: TemplateId
): Promise<TemplateId> {
  const apiKey = process.env.VERCEL_AI_GATEWAY_KEY;
  if (!apiKey || eligible.length <= 1) return fallback;
  try {
    const raw = await callGateway(buildLayoutPrompt(candidate, eligible, usedTodayCounts), apiKey);
    const parsed = JSON.parse(raw);
    if (typeof parsed?.layout === "string" && eligible.includes(parsed.layout)) return parsed.layout as TemplateId;
    console.error(`chooseLayoutViaAI: invalid pick "${parsed?.layout}" for ${page.page_id}, using fallback`);
  } catch (e) {
    console.error(`chooseLayoutViaAI: failed for ${page.page_id}: ${(e as Error).message}`);
  }
  return fallback;
}

// ⛔ OPERATOR ARCHITECTURE CHANGE (2026-08-12): "give template selection to
// Claude as well, since it has the complete context." Two real headline
// matches used to be an automatic green light for the comparison/VS
// layout — a keyword-count check can't tell "genuine head-to-head
// rivalry" from "two names incidentally co-mentioned" (the PGA/LPGA
// incident: two matches off ONE substring collision; the still-open risk:
// "Judge and Cole Both Named All-Stars" — two real names, zero rivalry).
// This is that judgment call, handed to a model that can actually read
// the story. It does NOT get authority over WHETHER two real subjects
// exist at all — that structural gate (matchedEntityNames finding two
// real, verified, photographable names) stays fully deterministic in
// activities/index.ts, since a comparison card physically needs two real
// photos to search for. This only judges, given that two real names
// already passed that gate, whether the STORY itself genuinely reads as
// a comparison. Defaults to false (the safer, single-subject path) on any
// failure/unavailability — same conservative-default pattern as every
// other AI-augmented decision in this pipeline.
export async function isGenuineComparisonViaAI(
  candidate: Candidate,
  page: PageConfig,
  nameA: string,
  nameB: string
): Promise<boolean> {
  const apiKey = process.env.VERCEL_AI_GATEWAY_KEY;
  if (!apiKey) return false;
  const prompt = [
    `Two names were both found in this story: "${nameA}" and "${nameB}".`,
    `Headline: ${stripHtml(candidate.headline)}`,
    candidate.rawText ? `Additional detail: ${stripHtml(candidate.rawText)}` : "",
    ``,
    `Is this story GENUINELY a head-to-head comparison, rivalry, or direct exchange between these two — the kind of story a split-frame "VS" card would actually represent?`,
    `Answer false if they're just incidentally co-mentioned — both received the same honor, one is a passing reference, they're on the same team, or the story is really about only one of them with the other named for context. Only answer true when the story's actual subject IS the relationship or matchup between the two.`,
    `Output ONLY a JSON object: {"genuine_comparison": true} or {"genuine_comparison": false}. No markdown, no explanation.`,
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const raw = await callGateway(prompt, apiKey);
    const parsed = JSON.parse(raw);
    return parsed?.genuine_comparison === true;
  } catch (e) {
    console.error(`isGenuineComparisonViaAI: failed for ${page.page_id}: ${(e as Error).message}`);
    return false;
  }
}

export async function buildNarrativeRenderCopy(
  candidate: Candidate,
  page: PageConfig,
  athleteNames: string[],
  layout: TemplateId,
  fallback: RenderCopy
): Promise<RenderCopyResult> {
  const apiKey = process.env.VERCEL_AI_GATEWAY_KEY;
  if (!apiKey) return { ...fallback, usedFallback: true, violation: "NO_API_KEY" };

  let retryNote: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const prompt = buildPrompt(candidate, page, athleteNames, layout, fallback, retryNote);
      const raw = await callGateway(prompt, apiKey);
      const parsed = JSON.parse(raw);
      const violation = violates(parsed, athleteNames, fallback.kicker);
      if (!violation) {
        return {
          headline: capHeadlineLength(parsed.headline),
          accent: parsed.accent ?? null,
          // Kicker is the card's fixed CTA strip (see chooseKicker in
          // activities/index.ts) — never AI-reasoned, always carried
          // through from the caller's deterministic value.
          kicker: fallback.kicker,
          story_type: String(parsed.story_type).trim(),
          usedFallback: false,
        };
      }
      retryNote = `your last attempt violated: ${violation} — fix that specifically`;
      console.error(`buildNarrativeRenderCopy: attempt ${attempt + 1} violated policy (${violation}) for ${page.page_id}`);
    } catch (e) {
      console.error(`buildNarrativeRenderCopy: attempt ${attempt + 1} failed for ${page.page_id}: ${(e as Error).message}`);
    }
  }

  return { ...fallback, usedFallback: true, violation: "FAILED_AFTER_RETRY" };
}
