// ⛔ OPERATOR FIX (2026-08-07): "for websearch of page-relevant stuff, which
// was also what T2 included, this can be used" — Tavily fills the exact gap
// the real threads-automation skill file calls "page-scoped fresh sourcing"
// (Jetro/WebSearch, scoped to one page's own entities/sport_groups) — the
// tier that keeps a page's slot from going unfilled when the shared pool AND
// its own newsletter both come up empty/stale. Independent of the Facebook
// T0-T2 pipeline and of ES's own article table, same as the other two tiers.

import { Candidate, PageConfig } from "./types";

const TAVILY_URL = "https://api.tavily.com/search";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  published_date?: string;
}

export async function tavilySearch(query: string, apiKey: string, maxResults = 8): Promise<TavilyResult[]> {
  const res = await fetch(TAVILY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      topic: "news",
      search_depth: "basic",
      days: 3,
      max_results: maxResults,
      include_answer: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { results?: TavilyResult[] };
  return json.results || [];
}

// Scoped to THIS page's own registered entities/sport_groups — never a
// generic sportswide search, per the same "page-scoped, not a full re-run"
// rule the reference skill file applies to its own Jetro/WebSearch tier.
export async function sourceFromWebSearch(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];

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

  const results = await tavilySearch(query, apiKey).catch((e) => {
    console.error(`sourceFromWebSearch: Tavily query failed for ${page.page_id}: ${(e as Error).message}`);
    return [] as TavilyResult[];
  });

  return tavilyResultsToCandidates(results, "web_search", dateISO);
}

export function tavilyResultsToCandidates(results: TavilyResult[], source: Candidate["source"], dateISO: string): Candidate[] {
  return results
    .filter((r) => r.title && r.url)
    .map((r): Candidate => ({
      source,
      key: r.url,
      subject: r.title,
      headline: r.title,
      link: r.url,
      publishedAt: r.published_date || dateISO,
      rawText: r.content?.slice(0, 500),
    }));
}
