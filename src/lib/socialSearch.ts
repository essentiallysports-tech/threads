// ⛔ OPERATOR FIX (2026-08-07): "add this Apify token for Reddit and Twitter
// scraping if more new stories are needed." Deliberately a LAST-RESORT tier,
// not always-on like the ES-articles/Tavily tiers — a real Apify actor run
// is a genuine scrape job (10-30s+ per call), so calling it for every one of
// 25 pages on every hourly run would blow up run latency for marginal gain
// on days the other three tiers already have enough. sourceCandidatePoolForPage
// only reaches for this when the other tiers left the page's pool thin.

import { Candidate, PageConfig } from "./types";

const APIFY_BASE = "https://api.apify.com/v2/acts";

async function runActorSync<T>(actorId: string, input: Record<string, unknown>, apiKey: string, timeoutSecs = 45): Promise<T[]> {
  const res = await fetch(`${APIFY_BASE}/${actorId}/run-sync-get-dataset-items?token=${apiKey}&timeout=${timeoutSecs}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Apify ${actorId} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T[];
}

interface TweetItem {
  type?: string;
  url: string;
  fullText?: string;
  text?: string;
  createdAt?: string;
  id: string;
}

interface RedditPostItem {
  dataType?: string;
  id?: string;
  parsedId?: string;
  url?: string;
  title?: string;
  body?: string;
  communityName?: string;
  createdAt?: string;
}

function scopedQuery(page: PageConfig): string | null {
  const entityNames = page.entities.map((e) => e.name);
  const terms = entityNames.length > 0 ? entityNames.slice(0, 2) : page.sport_groups.slice(0, 1);
  if (terms.length === 0) return null;
  const sportTerm = page.sport_groups[0] ? ` ${page.sport_groups[0]}` : "";
  return `${terms.join(" ")}${sportTerm}`;
}

export async function sourceFromTwitter(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  const apiKey = process.env.APIFY_API_TOKEN;
  const query = scopedQuery(page);
  if (!apiKey || !query) return [];

  const items = await runActorSync<TweetItem>("apidojo~tweet-scraper", { searchTerms: [query], maxItems: 5, sort: "Latest" }, apiKey).catch((e) => {
    console.error(`sourceFromTwitter: failed for ${page.page_id}: ${(e as Error).message}`);
    return [] as TweetItem[];
  });

  return items
    .filter((t) => t.url && (t.fullText || t.text))
    .map((t): Candidate => ({
      source: "social_search",
      key: t.id || t.url,
      subject: t.fullText || t.text || "",
      headline: (t.fullText || t.text || "").slice(0, 200),
      link: t.url,
      publishedAt: t.createdAt ? new Date(t.createdAt).toISOString() : `${dateISO}T12:00:00Z`,
      rawText: t.fullText || t.text,
    }));
}

export async function sourceFromReddit(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  const apiKey = process.env.APIFY_API_TOKEN;
  const query = scopedQuery(page);
  if (!apiKey || !query) return [];

  const items = await runActorSync<RedditPostItem>(
    "trudax~reddit-scraper-lite",
    { searches: [query], maxItems: 5, sort: "new", type: "posts" },
    apiKey
  ).catch((e) => {
    console.error(`sourceFromReddit: failed for ${page.page_id}: ${(e as Error).message}`);
    return [] as RedditPostItem[];
  });

  return items
    .filter((r) => r.title && r.communityName && r.url) // drop subreddit/community metadata rows, keep real posts only
    .map((r): Candidate => ({
      source: "social_search",
      key: r.parsedId || r.id || r.url!,
      subject: r.title!,
      headline: r.title!,
      link: r.url!,
      publishedAt: r.createdAt ? new Date(r.createdAt).toISOString() : `${dateISO}T12:00:00Z`,
      rawText: r.body?.slice(0, 500),
    }));
}
