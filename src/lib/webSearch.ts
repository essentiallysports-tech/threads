// ⛔ OPERATOR FIX (2026-08-10): "for web search remove tavilly and use Grok
// in Vercel's API gateway key" — Tavily's quota was exhausted (killing the
// web_search and evergreen_search sourcing tiers); replaced with xAI Grok's
// real live web search, called through the same VERCEL_AI_GATEWAY_KEY
// credential already used for captions and render-copy generation
// (narrativeCaption.ts/narrativeRenderSpec.ts), instead of a second,
// separate API key. This is Grok's REAL web_search tool (via the AI SDK's
// xai.tools.webSearch()) — results come back as genuine `sources` entries
// with real URLs, never fabricated by the model, matching the project's
// hard "never fabricate a link or fact" rule.

import { generateText } from "ai";
import { xai } from "@ai-sdk/xai";
import { Candidate, PageConfig } from "./types";

// The AI SDK's gateway auto-detection reads this exact env var name; the
// project's existing credential is named VERCEL_AI_GATEWAY_KEY everywhere
// else (narrativeCaption.ts, narrativeRenderSpec.ts, cardTextQC.ts), so bridge
// it here rather than requiring a second, differently-named env var.
if (!process.env.AI_GATEWAY_API_KEY && process.env.VERCEL_AI_GATEWAY_KEY) {
  process.env.AI_GATEWAY_API_KEY = process.env.VERCEL_AI_GATEWAY_KEY;
}

const MODEL = "xai/grok-4.20-non-reasoning";

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  published_date?: string;
}

// Scoped to THIS page's own registered entities/sport_groups — never a
// generic sportswide search, per the same "page-scoped, not a full re-run"
// rule the reference skill file applies to its own Jetro/WebSearch tier.
export async function sourceFromWebSearch(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  if (!process.env.VERCEL_AI_GATEWAY_KEY) return [];

  const entityNames = page.entities.map((e) => e.name);
  const terms = entityNames.length > 0 ? entityNames.slice(0, 3) : page.sport_groups.slice(0, 2);
  if (terms.length === 0) return [];
  // Sport term appended even for named-entity queries — a bare name search
  // ("Mark Martin news") can surface an unrelated same-named person; adding
  // the page's own sport keeps results scoped to what this page is actually
  // about. entityOrSportMatch/accuracyGate downstream only check for text
  // overlap, not real disambiguation, so this is the cheap fix upstream.
  const sportTerm = page.sport_groups[0] ? ` ${page.sport_groups[0]}` : "";
  const query = `${terms.join(" OR ")}${sportTerm} news`;

  const results = await grokWebSearch(query).catch((e) => {
    console.error(`sourceFromWebSearch: Grok search failed for ${page.page_id}: ${(e as Error).message}`);
    return [] as SearchResult[];
  });

  return searchResultsToCandidates(results, "web_search", dateISO);
}

// ⛔ OPERATOR FIX (2026-08-10/11, real live incident): confirmed live —
// "could not parse titled results ... 'is not valid JSON'" on real queries,
// e.g. `**[{"title": ...` — Grok sometimes wraps its JSON output in
// markdown bold instead of (or alongside) a code fence, which the original
// fence-only stripper never handled, silently discarding real, valid
// results.
function stripCodeFence(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const unfenced = fence ? fence[1] : text;
  return unfenced.trim().replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
}

export async function grokWebSearch(query: string, maxResults = 8): Promise<SearchResult[]> {
  if (!process.env.VERCEL_AI_GATEWAY_KEY) return [];

  // ⛔ OPERATOR FIX (2026-08-10/11, real live incident): confirmed live —
  // sourceCandidatePool was hitting its 2-minute ACTIVITY-level timeout for
  // real pages even after every raw fetch() call in the codebase got a
  // client-side timeout (see httpUtil.ts). Root cause: this is the one
  // network call in the whole pipeline that doesn't go through fetch() —
  // it's the `ai` SDK's generateText(), which has no default timeout and
  // (like every bare fetch found earlier) will hang indefinitely if xAI's
  // gateway is slow. `abortSignal` closes the exact same gap here.
  // ⛔ OPERATOR FIX (2026-08-12, real live incident): live logs from the
  // 2026-08-12 10:00Z run showed "Gateway request failed: This operation
  // was aborted" on nearly every page — xAI/the Vercel AI Gateway was
  // genuinely slow/hanging that run. 45s per page, times every degraded
  // page, was eating a large share of the fixed 20-min run budget before
  // rendering even started. Same fix as the Apify Reddit/Twitter timeouts
  // below: fail fast so one degraded external tier can't starve the rest
  // of the pipeline of run-budget.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let result;
  try {
    result = await generateText({
      model: MODEL,
      prompt: [
        `Search the web for real, current sports news matching: ${query}`,
        `After searching, list every distinct real story you found as a JSON array: [{"title": "<the story's real headline as written on the page you found>", "url": "<that page's exact URL>"}]`,
        `The url in each entry MUST be one you actually retrieved via search — never invent a URL. The title MUST be the real headline/title of that specific page — never a placeholder, a number, or a citation marker.`,
        `Output ONLY the JSON array, no markdown, no explanation, no other text.`,
      ].join("\n"),
      tools: { web_search: xai.tools.webSearch({}) },
      abortSignal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  // xAI's `source.title` field on this tool is observed (2026-08-10) to
  // return bare citation-index numbers ("1", "2") rather than real
  // headlines — unusable as a candidate headline. Real titles instead come
  // from the model's own text response, which we then verify against the
  // tool-reported `sources` URLs (the only field the tool never fabricates)
  // so a hallucinated URL in the text can never survive into a candidate.
  const verifiedUrls = new Set(
    (result.sources || [])
      .filter((s): s is Extract<(typeof result.sources)[number], { sourceType: "url" }> => s.sourceType === "url" && Boolean(s.url))
      .map((s) => s.url)
  );
  if (verifiedUrls.size === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(result.text));
  } catch (e) {
    console.error(`grokWebSearch: could not parse titled results for "${query}": ${(e as Error).message}`);
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const item of parsed) {
    const title = typeof item?.title === "string" ? item.title.trim() : "";
    const url = typeof item?.url === "string" ? item.url.trim() : "";
    if (!title || !url) continue;
    if (!verifiedUrls.has(url)) continue; // not a real, tool-returned source — drop it
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, content: "" });
    if (out.length >= maxResults) break;
  }
  return out;
}

export function searchResultsToCandidates(results: SearchResult[], source: Candidate["source"], dateISO: string): Candidate[] {
  return results
    .filter((r) => r.title && r.url)
    .map((r): Candidate => ({
      source,
      key: r.url,
      subject: r.title,
      headline: r.title,
      link: r.url,
      publishedAt: r.published_date || dateISO,
      rawText: r.content?.slice(0, 500) || r.title,
    }));
}
