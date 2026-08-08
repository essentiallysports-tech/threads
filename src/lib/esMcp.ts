// Direct REST access to ES-MCP's search_images tool — bypasses MCP/OAuth
// entirely. Confirmed live (2026-08-06) by reading essentiallysports-tech/
// es-mcp's own source (tools/search-images.ts, app/[transport]/route.ts):
// the server accepts a static bearer token (MCP_AUTH_TOKEN) obtained via its
// own self-serve /api/access endpoint (a soft domain-gated email check, no
// OTP loop), and the JSON-RPC tool-call response always embeds each image's
// real full-resolution URL in a predictable text line: "Full-resolution URL
// (use this — the inline preview is a low-res thumbnail): <url>". Regex-
// parsing that line is more robust than depending on the exact wording
// around it, which is UI copy the ES-MCP team could tweak.

const MCP_URL = "https://mcp.essentiallysports.com/mcp";
const URL_LINE_RE = /Full-resolution URL[^:]*:\s*(\S+)/;

export interface EsImageResult {
  url: string;
  title: string;
  caption?: string;
  credit?: string;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string[]> {
  const token = process.env.ES_MCP_BEARER_TOKEN;
  if (!token) throw new Error("ES_MCP_BEARER_TOKEN is not set");

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`ES-MCP ${name} -> ${res.status}: ${await res.text()}`);

  const raw = await res.text();
  const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`ES-MCP ${name}: no data line in response: ${raw.slice(0, 300)}`);
  const parsed = JSON.parse(dataLine.slice(6));
  if (parsed.error) throw new Error(`ES-MCP ${name} error: ${JSON.stringify(parsed.error)}`);
  const content = parsed.result?.content as Array<{ type: string; text?: string }> | undefined;
  return (content || []).filter((c) => c.type === "text").map((c) => c.text || "");
}

function parseResult(metaText: string): EsImageResult | null {
  const urlMatch = metaText.match(URL_LINE_RE);
  if (!urlMatch) return null;
  const titleMatch = metaText.match(/^\*\*(.+?)\*\*/);
  const captionMatch = metaText.match(/^Caption:\s*(.+)$/m);
  const creditMatch = metaText.match(/^Credit:\s*(.+)$/m);
  return {
    url: urlMatch[1],
    title: titleMatch?.[1] || "",
    caption: captionMatch?.[1],
    credit: creditMatch?.[1],
  };
}

// Searches ES's media library. Returns up to `count` results, ranked as
// ES-MCP ranks them (relevance then recency) — does NOT verify each URL is
// actually reachable (see searchOneImage, which does).
export async function searchImages(query: string, type: "agency" | "custom" | "all" = "agency", count = 5): Promise<EsImageResult[]> {
  const texts = await callTool("search_images", { query, per_page: count, type });
  return texts.map(parseResult).filter((r): r is EsImageResult => r !== null);
}

// Searches ES's media library for a real, ACTUALLY REACHABLE photo — tries
// each candidate in ranked order and HEAD-checks it, since the media
// library confirmed live (2026-08-06) to occasionally contain entries whose
// image_url 404s on a different CDN host than the one actually serving the
// image (a real, observed data-quality gap in the library itself, not a
// bug in this code). Returns null if NONE of the top candidates resolve —
// callers must treat null as "no usable photo for this subject," never
// substitute a generic/unrelated image (see the render pipeline's hard
// rules).
export async function searchOneImage(query: string, type: "agency" | "custom" | "all" = "agency"): Promise<EsImageResult | null> {
  const candidates = await searchImages(query, type, 5);
  for (const candidate of candidates) {
    try {
      const head = await fetch(candidate.url, { method: "HEAD" });
      if (head.ok) return candidate;
    } catch {
      // network error on this one candidate — try the next, don't fail the whole search
    }
  }
  return null;
}

export interface EsArticleResult {
  title: string;
  url: string;
  publishedTime: string | null; // "HH:MM" as returned by the tool — no date component
}

// ⛔ OPERATOR FIX (2026-08-07): "at least ES articles can serve as a source
// for the MCP, irrespective of whether T2 is live" — query_articles hits ES's
// own article_big_table directly, which exists and is populated regardless
// of whether the separate Facebook T0-T2 pipeline has run today. This is a
// genuinely independent content source, not a fallback that depends on the
// same upstream pipeline the newsletter/shared-pool tiers already depend on.
// Response is markdown text (title as a link, then a metadata line) — same
// text-content shape as search_images, parsed the same defensive way.
const ARTICLE_LINE_RE = /\*\*\[(.+?)\]\((https?:\/\/[^)]+)\)\*\*\s*\nSport:[^|]*\|[^|]*\|[^|]*\|\s*Published:\s*(\d{2}:\d{2})/g;

export async function queryRecentArticles(sport: string | null, dateISO: string, limit = 20): Promise<EsArticleResult[]> {
  const args: Record<string, unknown> = { publish_date_start: dateISO, publish_date_end: dateISO, limit };
  if (sport) args.sport = sport;
  return queryArticles(args);
}

// ⛔ OPERATOR FIX (2026-08-08): "only ES article/newsletter link allowed" —
// when a real, externally-discovered story (Tavily/Apify) doesn't itself
// have an ES-owned link, this is how a genuine ES article covering the SAME
// entity gets found instead, rather than either fabricating a link or
// posting the external one. Real query_articles `entity` filter, wider date
// range than queryRecentArticles's single-day default since a real ES piece
// on the same subject may have run a few days either side.
export async function queryArticlesByEntity(entity: string, dateStart: string, dateEnd: string, limit = 20): Promise<EsArticleResult[]> {
  return queryArticles({ entity, publish_date_start: dateStart, publish_date_end: dateEnd, limit });
}

async function queryArticles(args: Record<string, unknown>): Promise<EsArticleResult[]> {
  const texts = await callTool("query_articles", args);
  const joined = texts.join("\n");
  const results: EsArticleResult[] = [];
  for (const match of joined.matchAll(ARTICLE_LINE_RE)) {
    results.push({ title: match[1], url: match[2], publishedTime: match[3] });
  }
  return results;
}
