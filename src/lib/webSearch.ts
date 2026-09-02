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
import { anthropic } from "@ai-sdk/anthropic";
import { Candidate, PageConfig } from "./types";
import { fetchWithTimeout, createLimiter } from "./httpUtil";

// ⛔ OPERATOR FIX (2026-08-29, real live incident): see httpUtil.ts's
// createLimiter comment for the full incident context. This file already
// documents two earlier rounds of the same pattern (2026-08-23, 2026-08-24
// backoff increases) as concurrency scaled from 1 execution to 6 shards —
// each round added retry/backoff, which helps a transient blip but not a
// SUSTAINED overload, and confirmed live in THIS incident: 5,697 "Claude
// search failed" + 1,589 "Grok fallback also failed" in one window, both
// "operation was aborted" against the same shared Vercel AI Gateway now
// under load from all 41 pages' repair passes across all 6 shards at once.
// Bounding in-process concurrency here queues the burst instead of firing it
// all at once — no measured Gateway capacity figure exists, so this is a
// conservative starting point, same reasoning as the ES-MCP/Beehiiv limiters.
const limitAiGateway = createLimiter(6);

// The AI SDK's gateway auto-detection reads this exact env var name; the
// project's existing credential is named VERCEL_AI_GATEWAY_KEY everywhere
// else (narrativeCaption.ts, narrativeRenderSpec.ts, cardTextQC.ts), so bridge
// it here rather than requiring a second, differently-named env var.
if (!process.env.AI_GATEWAY_API_KEY && process.env.VERCEL_AI_GATEWAY_KEY) {
  process.env.AI_GATEWAY_API_KEY = process.env.VERCEL_AI_GATEWAY_KEY;
}

const GROK_MODEL = "xai/grok-4.20-non-reasoning";
const CLAUDE_MODEL = "anthropic/claude-sonnet-4-5";

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  published_date?: string;
}

// Scoped to THIS page's own registered entities/sport_groups — never a
// generic sportswide search, per the same "page-scoped, not a full re-run"
// rule the reference skill file applies to its own Jetro/WebSearch tier.
//
// ⛔ OPERATOR FIX (2026-08-17, real live incident): this used to search only
// `entityNames.slice(0, 3)` — any page with more than 3 registered
// entities never got web-search coverage for the rest at all, every single
// run. Confirmed live: a completed run's own candidate log showed 55% of
// all dropped candidates failing NO_NAMED_ENTITY, mostly generic same-sport
// stories (sourced from the broad, sport-level ES-articles/shared-pool
// tiers) that were never going to match this page's specific roster — real
// content existed, sourcing just wasn't looking for it. Now batches ALL of
// a page's registered entities into groups of 3 (keeps each query's
// disambiguation quality — see the sportTerm comment below) and runs one
// search per group in parallel, so a page with 10 registered players gets
// real search coverage for all 10, not just its first 3.
const ENTITY_BATCH_SIZE = 3;

export async function sourceFromWebSearch(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  if (!process.env.VERCEL_AI_GATEWAY_KEY) return [];

  const entityNames = page.entities.map((e) => e.name);
  const sportTerm = page.sport_groups[0] ? ` ${page.sport_groups[0]}` : "";

  const termBatches: string[][] =
    entityNames.length > 0
      ? Array.from({ length: Math.ceil(entityNames.length / ENTITY_BATCH_SIZE) }, (_, i) =>
          entityNames.slice(i * ENTITY_BATCH_SIZE, i * ENTITY_BATCH_SIZE + ENTITY_BATCH_SIZE)
        )
      : page.sport_groups.length > 0
      ? [page.sport_groups.slice(0, 2)]
      : [];
  if (termBatches.length === 0) return [];

  // Sport term appended even for named-entity queries — a bare name search
  // ("Mark Martin news") can surface an unrelated same-named person; adding
  // the page's own sport keeps results scoped to what this page is actually
  // about. entityOrSportMatch/accuracyGate downstream only check for text
  // overlap, not real disambiguation, so this is the cheap fix upstream.
  const resultsPerBatch = await Promise.all(
    termBatches.map((terms) =>
      webSearch(`${terms.join(" OR ")}${sportTerm} news`).catch((e) => {
        console.error(`sourceFromWebSearch: web search failed for ${page.page_id} (${terms.join(", ")}): ${(e as Error).message}`);
        return [] as SearchResult[];
      })
    )
  );

  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const results of resultsPerBatch) {
    for (const r of results) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      merged.push(r);
    }
  }

  return await searchResultsToCandidates(merged, "web_search", dateISO);
}

// ⛔ OPERATOR FIX (2026-08-17, real live incident): "evergreen tier can be
// worked perfectly using web search" — sourceFromWebSearch above phrases
// every query as "{entity} news", which structurally returns nothing useful
// for a legends/retrospective page: a search for "Dale Earnhardt Sr. NASCAR
// news" finds no real results because Sr. died in 2001 and has no current
// news, while the SAME entity has abundant real career/legacy content a
// history-phrased query would surface. sourceFromEsEvergreenArticles
// already does this against ES's own article database; this does the same
// against the live web for entities ES's own catalog doesn't cover deeply
// enough. Tagged "evergreen_search" — same source tag as the ES-catalog
// evergreen tier, so it inherits the same recency-check exemption
// (isTooRecentForRetrospectivePage in checks.ts) automatically.
// ⛔ OPERATOR FIX (2026-08-18, real live incident): "if you see from a
// consumer POV what value are they adding... rather if fill rate is the
// issue, we can either provide player stats or do comparison posts or
// versus posts/famous player quotes." The old query — "{entity} career
// history legacy retrospective" — is structurally a request for a bio
// summary, so search engines correctly return exactly that: Wikipedia,
// Britannica, BoxRec-style aggregator pages with a stat table and zero
// narrative hook (isGenericProfileFraming in checks.ts now hard-rejects
// these regardless, but it's better to stop asking for them in the first
// place). These four angle-specific query variants ask for content that
// actually has a real hook a caption can be built around, rotated by a
// deterministic hash of the page/date so the same page doesn't always draw
// the same angle.
const EVERGREEN_ANGLE_QUERIES = [
  (terms: string, sport: string) => `${terms}${sport} greatest stat records milestones`,
  (terms: string, sport: string) => `${terms}${sport} head to head comparison rivalry`,
  (terms: string, sport: string) => `${terms}${sport} famous quote interview moment`,
  (terms: string, sport: string) => `${terms}${sport} where are they now career update`,
];

export async function sourceFromEvergreenWebSearch(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  if (!process.env.VERCEL_AI_GATEWAY_KEY) return [];

  const entityNames = page.entities.map((e) => e.name);
  if (entityNames.length === 0) return [];

  const termBatches = Array.from({ length: Math.ceil(entityNames.length / ENTITY_BATCH_SIZE) }, (_, i) =>
    entityNames.slice(i * ENTITY_BATCH_SIZE, i * ENTITY_BATCH_SIZE + ENTITY_BATCH_SIZE)
  );
  const sportTerm = page.sport_groups[0] ? ` ${page.sport_groups[0]}` : "";

  const resultsPerBatch = await Promise.all(
    termBatches.map((terms, i) => {
      const angle = EVERGREEN_ANGLE_QUERIES[(i + dateISO.length) % EVERGREEN_ANGLE_QUERIES.length];
      return webSearch(angle(terms.join(" OR "), sportTerm), 8, true).catch((e) => {
        console.error(`sourceFromEvergreenWebSearch: web search failed for ${page.page_id} (${terms.join(", ")}): ${(e as Error).message}`);
        return [] as SearchResult[];
      });
    })
  );

  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const results of resultsPerBatch) {
    for (const r of results) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      merged.push(r);
    }
  }

  return await searchResultsToCandidates(merged, "evergreen_search", dateISO);
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

// ⛔ OPERATOR FIX (2026-08-17, real live incident): this used to hardcode
// "real, CURRENT sports news" even for sourceFromEvergreenWebSearch's
// history/legacy-phrased queries — confirmed live, that contradiction (ask
// for "current news" while the query itself says "career history legacy
// retrospective") made the model respond conversationally ("I need to
// search for historical information...") instead of strict JSON, failing
// to parse on the majority of evergreen calls. Two distinct prompt framings
// now, selected by the caller, so the instruction never contradicts the
// query's own intent.
const SEARCH_PROMPT = (query: string, evergreen: boolean) =>
  [
    evergreen
      ? `Search the web for real historical/retrospective sports content matching: ${query}`
      : `Search the web for real, current sports news matching: ${query}`,
    `After searching, list every distinct real story you found as a JSON array: [{"title": "<the story's real headline as written on the page you found>", "url": "<that page's exact URL>"}]`,
    `The url in each entry MUST be one you actually retrieved via search — never invent a URL. The title MUST be the real headline/title of that specific page — never a placeholder, a number, or a citation marker.`,
    `Output ONLY the JSON array, no markdown, no explanation, no other text — do not describe your search process, just return the array.`,
  ].join("\n");

// Shared runner for both providers' web-search tool: applies the same
// bounded timeout-with-one-retry pattern, then extracts titled results
// verified against the tool's own real `sources` (never the model's raw
// text, which can hallucinate a URL/title pair even when the tool didn't).
// ⛔ OPERATOR FIX (2026-08-15, real live incident): confirmed live —
// isolated back-to-back tests showed Grok hitting the 20s abort wall on
// ~2/3 calls (a real query genuinely needing more like 20-25s tonight, not
// hanging), same platform-wide slowdown pattern as tonight's Apify/Athena
// incidents. Claude was faster in isolation (12-16s) but production logs
// from the same window show it aborting too — raised for both providers to
// stop cutting off calls that would have succeeded with a few more seconds.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runSearchTool(model: string, tools: any, query: string, maxResults: number, evergreen: boolean): Promise<SearchResult[]> {
  const attempt = () => limitAiGateway(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40_000);
    try {
      return await generateText({
        model,
        prompt: SEARCH_PROMPT(query, evergreen),
        tools,
        abortSignal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  });
  // ⛔ OPERATOR FIX (2026-08-23, real live incident): confirmed live — 211
  // "Claude search failed" / "Grok fallback also failed" events in one
  // night, each one representing FOUR back-to-back attempts (Claude x2,
  // Grok x2) against the same shared Vercel AI Gateway with ZERO delay
  // between any of them. An immediate retry against a momentarily
  // saturated shared endpoint is nearly guaranteed to land in the same
  // saturation window. Same pattern as esMcp.ts's callTool fix: a short
  // backoff before retrying costs a couple seconds but gives real
  // transient load a chance to clear.
  // ⛔ OPERATOR FIX (2026-08-24, sharding rollout, real live incident):
  // confirmed live within the FIRST sharded cycle — up to 6 shards now fire
  // this same evergreen-bank webSearch tier concurrently across many pages
  // (confirmed: Michigan, Georgia Bulldogs, Aaron Judge, Buffalo Bills,
  // classic.nascar, and archives.mma all aborting in the same log window),
  // where before only 1 execution's worth of pages ever hit this tier at
  // once. Doubled from 2000ms — the same reasoning as the original fix,
  // just recalibrated for a shared resource now under several times the
  // concurrent load.
  let result;
  try {
    result = await attempt();
  } catch {
    await new Promise((r) => setTimeout(r, 4000));
    result = await attempt();
  }

  // The tool's own `source.title` field is unreliable across providers
  // (xAI is observed returning bare citation-index numbers like "1", "2").
  // Real titles instead come from the model's own text response, which we
  // then verify against the tool-reported `sources` URLs (the one field
  // neither provider's tool fabricates) so a hallucinated URL/title pair in
  // the text can never survive into a candidate.
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
    console.error(`runSearchTool(${model}): could not parse titled results for "${query}": ${(e as Error).message}`);
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

export async function grokWebSearch(query: string, maxResults = 8, evergreen = false): Promise<SearchResult[]> {
  if (!process.env.VERCEL_AI_GATEWAY_KEY) return [];
  return runSearchTool(GROK_MODEL, { web_search: xai.tools.webSearch({}) }, query, maxResults, evergreen);
}

export async function claudeWebSearch(query: string, maxResults = 8, evergreen = false): Promise<SearchResult[]> {
  if (!process.env.VERCEL_AI_GATEWAY_KEY) return [];
  return runSearchTool(CLAUDE_MODEL, { web_search: anthropic.tools.webSearch_20250305({}) }, query, maxResults, evergreen);
}

// ⛔ OPERATOR FIX (2026-08-14, real live incident): Grok's web search has a
// PERSISTENT (not transient) Gateway-side failure — "Gateway request
// failed: This operation was aborted" reproduced live on isolated,
// back-to-back calls, including after the existing bounded retry inside
// grokWebSearch. Claude Sonnet 4.5's web search tool, called through the
// same gateway credential, was verified live (multiple runs) to work
// reliably (~13-14s, real sources every time). Claude is now PRIMARY;
// Grok is kept as a fallback attempt in case Claude itself degrades, so a
// single provider outage can no longer zero out this entire sourcing tier.
export async function webSearch(query: string, maxResults = 8, evergreen = false): Promise<SearchResult[]> {
  const claudeResults = await claudeWebSearch(query, maxResults, evergreen).catch((e) => {
    console.error(`webSearch: Claude search failed for "${query}": ${(e as Error).message}`);
    return [] as SearchResult[];
  });
  if (claudeResults.length > 0) return claudeResults;

  // Same shared gateway as the Claude attempts above — give it a moment
  // before piling on with a different model rather than switching providers
  // with zero gap (see OPERATOR FIX above in runSearchTool). Doubled
  // 2026-08-24 alongside runSearchTool's own backoff — same sharding-scale
  // reasoning.
  await new Promise((r) => setTimeout(r, 4000));
  return grokWebSearch(query, maxResults, evergreen).catch((e) => {
    console.error(`webSearch: Grok fallback also failed for "${query}": ${(e as Error).message}`);
    return [] as SearchResult[];
  });
}

// ⛔ OPERATOR FIX (2026-08-18, real live incident): confirmed live — a
// Boxing Bulletin post ("Usyk just stopped Verhoeven...") sourced from an
// ESPN article whose own datePublished (2026-05-23) was nearly 3 months
// before it got posted as current news (2026-08-17). Root cause: this
// function set `publishedAt: r.published_date || dateISO`, but SEARCH_PROMPT
// above never asks the search model for a published_date field — so
// `r.published_date` is ALWAYS undefined, and every single web_search /
// evergreen_search candidate got `publishedAt` silently stamped as TODAY,
// regardless of the real article's actual age. This made isFreshEnough()
// (checks.ts) structurally blind to true article age for this entire
// candidate class. Fix: actually fetch each result URL and read its real
// publish date off the page's own metadata (JSON-LD datePublished,
// article:published_time, etc.) — the same manual check that surfaced this
// bug in the first place, now run automatically before a candidate is ever
// built. A fetch failure/no-date-found falls back to the old dateISO
// behavior (never blocks sourcing on this).
const DATE_META_PATTERNS: RegExp[] = [
  /"datePublished"\s*:\s*"([^"]+)"/i,
  /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
  /<meta[^>]+name=["']publish(?:ed)?-?date["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["']/i,
  /<time[^>]+datetime=["']([^"']+)["']/i,
];

async function fetchPublishedDate(url: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 8_000);
    if (!res.ok) return null;
    const html = await res.text();
    for (const pattern of DATE_META_PATTERNS) {
      const match = html.match(pattern);
      if (match) {
        const parsed = new Date(match[1]);
        if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ⛔ OPERATOR FIX (2026-08-18, real live incident): "facetcheck using grok
// websearch so that nothing poor goes out." web_search/evergreen_search are
// the two tiers with no inherent ES trust (unlike es_article/beehiiv_*,
// which are ES's own real, editorially-produced content) — they're where
// every real accuracy incident this session actually originated. The
// existing accuracyGate (checks.ts) only checks that the linked page's own
// text mentions the entity name; it never verifies the CLAIM itself is
// real, current, or correctly attributed. This runs one extra live search
// asking specifically "is this true and current" before such a candidate
// is allowed to render/post. Fails OPEN only on an infra/parse error
// (can't reach the fact-checker itself — matches this project's standing
// "a fallback tier's outage should never zero out a page" posture); fails
// CLOSED on an actual "no, this isn't verifiable" verdict, since that's a
// genuine content problem, not an infra hiccup.
export interface FactCheckResult {
  verified: boolean;
  reason: string;
}

export async function factCheckClaim(candidate: Candidate): Promise<FactCheckResult> {
  if (!process.env.VERCEL_AI_GATEWAY_KEY) return { verified: true, reason: "no_gateway_key_skip" };

  const prompt = [
    `Fact-check this sports headline using live web search: "${candidate.headline}"`,
    candidate.sourceLink ? `It was reportedly found at: ${candidate.sourceLink}` : "",
    `Search the web right now and determine: is this a REAL, CURRENT, ACCURATELY-ATTRIBUTED claim — not outdated, not fabricated, not a misattribution, not a stale story being presented as new?`,
    `Respond with ONLY a JSON object, no markdown, no explanation: {"verified": true or false, "reason": "<one short sentence, e.g. 'confirmed by 2 independent current sources' or 'this event happened months ago, not current'>"}`,
  ]
    .filter(Boolean)
    .join("\n");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attempt = (model: string, tool: any) => limitAiGateway(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40_000);
    try {
      return await generateText({ model, prompt, tools: tool, abortSignal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  });

  try {
    let result;
    try {
      result = await attempt(CLAUDE_MODEL, { web_search: anthropic.tools.webSearch_20250305({}) });
    } catch {
      result = await attempt(GROK_MODEL, { web_search: xai.tools.webSearch({}) });
    }
    const parsed = JSON.parse(stripCodeFence(result.text));
    return {
      verified: parsed.verified !== false,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch (e) {
    console.error(`factCheckClaim: failed for "${candidate.headline}": ${(e as Error).message}`);
    return { verified: true, reason: "factcheck_infra_error_failopen" };
  }
}

export async function searchResultsToCandidates(results: SearchResult[], source: Candidate["source"], dateISO: string): Promise<Candidate[]> {
  const titled = results.filter((r) => r.title && r.url);
  const realDates = await Promise.all(titled.map((r) => fetchPublishedDate(r.url)));

  return titled.map((r, i): Candidate => ({
    source,
    key: r.url,
    subject: r.title,
    headline: r.title,
    link: r.url,
    publishedAt: r.published_date || realDates[i] || dateISO,
    rawText: r.content?.slice(0, 500) || r.title,
  }));
}
