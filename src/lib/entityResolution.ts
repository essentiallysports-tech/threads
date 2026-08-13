// ⛔ OPERATOR ARCHITECTURE CHANGE (2026-08-11): "deterministic code isn't
// able to choose which entity to pick from, so sometimes it posts random
// photos, but when complete news is given to claude to write the caption,
// claude has full context so that can easily pick up what entity is
// needed." The regex-only entity extraction (extractSimilarPlayerName/
// extractNameFromArticle in checks.ts) is a pattern-matcher — it cannot
// understand a headline's actual meaning, which is exactly why "He Is Not
// Obligated to Stay" and "Sophie Targets 7 Figure Deal" both got
// misidentified as real names. A model reading the whole story never makes
// that class of mistake. This is that model call — used ONLY as a fallback
// when the registered-entity match (checks.ts's matchedEntityNames tier 1,
// a curated per-page roster) already found nothing, same cost-gating
// philosophy as the existing extractNameFromArticle fallback.
//
// Hard rule, same hallucination-safety pattern already proven in
// webSearch.ts's grokWebSearch (verifies every URL against tool-returned
// sources) and narrativeRenderSpec.ts's violates() check: the model is
// asked to EXTRACT a name already present in the given facts, never to
// infer or guess one — and whatever it returns is verified as a literal
// substring of those same facts before ever being trusted. An unverifiable
// answer is treated exactly like "found nothing," never substituted in
// anyway.

import { Candidate, PageConfig } from "./types";
import { fetchWithTimeout } from "./httpUtil";

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const MODEL = "anthropic/claude-sonnet-4-5";

function stripWrappingQuotesAndMarkdown(text: string): string {
  const t = text.trim();
  if (t.startsWith("{") && t.endsWith("}")) return t;
  const codeBlock = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return codeBlock ? codeBlock[1].trim() : t;
}

// ⛔ OPERATOR FIX (2026-08-12, real live incident): "MLB Pro Ejected Without
// Even Playing" — a real story that genuinely never names who was ejected
// ("most fans still don't know what he actually did to earn it") — got a
// fabricated "Pro Ejected" pseudo-name from the regex fallback anyway,
// which then searched ES-MCP for that nonsense and returned an unrelated
// photo. The AI extraction almost certainly ran here and correctly
// returned null (there IS no real subject) — but the caller couldn't tell
// "AI ran and confirmed no entity" apart from "AI didn't run at all," so it
// fell through to the regex heuristic regardless, silently overriding a
// correct AI judgment with a worse guess. Three-way return value fixes
// this at the source: `undefined` = AI genuinely didn't produce a
// judgment (no API key, network/gateway failure) — callers should still
// try their own fallback chain. `null` = AI ran and confirmed there is no
// real depictable subject (including a hallucinated-and-rejected
// candidate — treated the same, since a failed-verification guess is not
// more trustworthy than "no entity") — callers must trust this and NOT
// second-guess it with a less reliable heuristic. A string = a real,
// verified entity.
export async function extractEntityViaAI(candidate: Candidate, page: PageConfig): Promise<string | null | undefined> {
  const apiKey = process.env.VERCEL_AI_GATEWAY_KEY;
  if (!apiKey) return undefined;

  const facts = [
    `Headline: ${candidate.headline}`,
    candidate.subject && candidate.subject !== candidate.headline ? `Subject line: ${candidate.subject}` : null,
    candidate.rawText ? `Additional detail: ${candidate.rawText}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `You are identifying WHO or WHAT TEAM a sports infographic card's photo should depict, based ONLY on these real facts — never invent, infer, or guess beyond what's explicitly stated:`,
    facts,
    ``,
    `Rules:`,
    `- Return the ONE real person's full name or team name this story is CLEARLY AND SPECIFICALLY about — copied verbatim exactly as it appears in the facts above (same spelling/capitalization).`,
    `- If the facts don't clearly name a specific depictable person/team (e.g. a league-wide, abstract, or procedural story with no single subject), return null rather than guessing.`,
    `- NEVER return a word that merely LOOKS like a name (a quoted clause, a headline verb, a pronoun) — only a real person or team actually being reported on.`,
    `- NEVER return a name you merely suspect is involved but that isn't actually written in the facts above.`,
    ``,
    `Output ONLY a JSON object with exactly one key: {"entity": "<name>"} or {"entity": null}. No markdown, no explanation, no code fence.`,
  ].join("\n");

  try {
    const res = await fetchWithTimeout(
      GATEWAY_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 100,
          temperature: 0,
        }),
      },
      30_000
    );
    if (!res.ok) {
      console.error(`extractEntityViaAI: gateway ${res.status} for ${page.page_id}: ${(await res.text()).slice(0, 300)}`);
      return undefined; // infrastructure failure — no judgment was made, let the caller's own fallback try
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") return undefined;

    const parsed = JSON.parse(stripWrappingQuotesAndMarkdown(content));
    const entity = typeof parsed?.entity === "string" ? parsed.entity.trim() : null;
    if (!entity) return null;

    // Hard verification — the model must have EXTRACTED this from the real
    // facts, never invented it. If it isn't a literal substring of what we
    // actually gave it, it's fabricating; reject exactly like "found
    // nothing" so the existing regex/article fallbacks still get a try.
    const haystack = `${candidate.subject} ${candidate.headline} ${candidate.rawText || ""}`.toLowerCase();
    if (!haystack.includes(entity.toLowerCase())) {
      console.error(`extractEntityViaAI: rejected unverifiable entity "${entity}" for ${page.page_id} — not found verbatim in source facts`);
      return null;
    }
    return entity;
  } catch (e) {
    console.error(`extractEntityViaAI: failed for ${page.page_id}: ${(e as Error).message}`);
    return undefined; // genuine call failure — no judgment was made
  }
}

// ⛔ OPERATOR FIX (2026-08-13, real live incident): "why is fight between
// still picked up as entity when entity was being picked by Anthropic?" —
// extractEntityViaAI above only ever ran for the SINGLE-subject photo-search
// path. Any story rendered via the comparison/quote (two-subject) template
// — e.g. "Who Wins an MMA Fight Between Max Holloway and Usman
// Nurmagomedov?" — never consulted the AI at all: its entities came from
// `matchedEntityNames` in checks.ts, a purely regex-based path (real-roster
// match, else the same `extractSimilarPlayerName` pattern-matcher that
// misread "Fight Between" as a name). This is that same AI extraction,
// extended to return up to two verified names so it can also drive
// comparison/quote-card entity resolution, not just the single-subject one.
export async function extractEntitiesViaAI(candidate: Candidate, page: PageConfig, maxEntities = 2): Promise<string[] | undefined> {
  const apiKey = process.env.VERCEL_AI_GATEWAY_KEY;
  if (!apiKey) return undefined;

  const facts = [
    `Headline: ${candidate.headline}`,
    candidate.subject && candidate.subject !== candidate.headline ? `Subject line: ${candidate.subject}` : null,
    candidate.rawText ? `Additional detail: ${candidate.rawText}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `You are identifying WHO or WHAT TEAM(S) a sports infographic card's photo(s) should depict, based ONLY on these real facts — never invent, infer, or guess beyond what's explicitly stated:`,
    facts,
    ``,
    `Rules:`,
    `- If this story is clearly about exactly ONE real person/team, return that one name.`,
    `- If this story is a genuine head-to-head, comparison, matchup, or exchange between exactly TWO real people/teams (e.g. "Who wins a fight between X and Y", "X responds to Y's claim"), return BOTH names, most prominent/first-mentioned first.`,
    `- Copy each name verbatim exactly as it appears in the facts above (same spelling/capitalization).`,
    `- If the facts don't clearly name a specific depictable person/team (e.g. a league-wide, abstract, or procedural story with no single subject), return an empty array rather than guessing.`,
    `- NEVER return a word that merely LOOKS like a name (a quoted clause, a headline verb, a pronoun, a connector word like "between"/"fight") — only a real person or team actually being reported on.`,
    `- NEVER return a name you merely suspect is involved but that isn't actually written in the facts above.`,
    `- Return at most ${maxEntities} names.`,
    ``,
    `Output ONLY a JSON object with exactly one key: {"entities": ["<name>", ...]} (empty array if none). No markdown, no explanation, no code fence.`,
  ].join("\n");

  try {
    const res = await fetchWithTimeout(
      GATEWAY_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 150,
          temperature: 0,
        }),
      },
      30_000
    );
    if (!res.ok) {
      console.error(`extractEntitiesViaAI: gateway ${res.status} for ${page.page_id}: ${(await res.text()).slice(0, 300)}`);
      return undefined; // infrastructure failure — no judgment was made, let the caller's own fallback try
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") return undefined;

    const parsed = JSON.parse(stripWrappingQuotesAndMarkdown(content));
    const rawEntities = Array.isArray(parsed?.entities) ? parsed.entities : [];

    // Same hard verification as extractEntityViaAI — every name must be a
    // literal substring of what we actually gave the model, never invented.
    // A name that fails verification is dropped exactly like "not returned"
    // — never worse than an empty result.
    const haystack = `${candidate.subject} ${candidate.headline} ${candidate.rawText || ""}`.toLowerCase();
    const verified = rawEntities
      .filter((e: unknown): e is string => typeof e === "string" && e.trim().length > 0)
      .map((e: string) => e.trim())
      .filter((e: string) => {
        const ok = haystack.includes(e.toLowerCase());
        if (!ok) console.error(`extractEntitiesViaAI: rejected unverifiable entity "${e}" for ${page.page_id} — not found verbatim in source facts`);
        return ok;
      })
      .slice(0, maxEntities);
    return verified;
  } catch (e) {
    console.error(`extractEntitiesViaAI: failed for ${page.page_id}: ${(e as Error).message}`);
    return undefined; // genuine call failure — no judgment was made
  }
}
