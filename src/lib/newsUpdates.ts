// (2026-10-21, operator: "build eala link free updates") ES published no Alex
// Eala article Oct 16-21 while she played the Ningbo Open, so the page had
// nothing to post. The page's own team kept it alive with short, link-free
// match updates ("Alex Eala kicked off her Ningbo Open campaign in style,
// outclassing Diane Parry 6-3, 6-1"; "EJ Obiena stands up for Alex Eala…").
// This builds the same kind of post from Google News headlines by trusted
// outlets. Facts come only from those headlines; nothing is linked, so these
// posts don't earn clicks — they keep the account active and its reach up
// when ES has nothing to link. Enabled per page with threads.link_free_news.
import { Candidate, PageConfig, PostedLogEntry } from "./types";
import { fetchWithTimeout } from "./httpUtil";

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_MS = 20 * 60 * 1000;
const MAX_CANDIDATES = 8;

// Publishers whose headlines we treat as reported fact. Social platforms and
// aggregators are never used.
const TRUSTED_PUBLISHERS = [
  "abs-cbn", "inquirer", "gma", "rappler", "philstar", "manila bulletin", "daily tribune", "businessmirror",
  "philippine news agency", "spin.ph", "tiebreaker times", "one sports", "manila times", "sunstar", "cnn philippines",
  "espn", "tennis.com", "wta", "reuters", "associated press", "ap news", "bbc", "the guardian", "yahoo sports",
  "tennis majors", "tennis365", "the athletic", "nbc sports", "cbs sports",
  // (2026-10-23) for All Things Rogan: MMA outlets, and reputable entertainment
  // press for his podcast. Political stories are still dropped by
  // runDeterministicChecks' political gate like any other candidate.
  "mma fighting", "mma junkie", "sherdog", "bloody elbow", "cageside press", "fox sports", "sports illustrated",
  "sporting news", "usa today", "variety", "the hollywood reporter", "rolling stone",
];
const EXCLUDED_LEADS = /^\s*(\[|opinion\b|editorial\b|column\b|commentary\b|analysis\b|letters?\b|watch\b|listen\b|podcast\b)/i;

export interface NewsItem {
  title: string;
  publisher: string;
  link: string;
  publishedAt: string;
}

const cache = new Map<string, { at: number; items: NewsItem[] }>();

function decode(text: string): string {
  return text
    .replace(/^\s*<!\[CDATA\[/, "")
    .replace(/\]\]>\s*$/, "")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

export function parseGoogleNews(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const block of xml.match(/<item>[\s\S]*?<\/item>/g) || []) {
    const tag = (name: string) => {
      const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`));
      return m ? decode(m[1]) : "";
    };
    const publisher = tag("source");
    let title = tag("title");
    // Google appends " - Publisher" to every title.
    if (publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -(publisher.length + 3)).trim();
    const t = Date.parse(tag("pubDate"));
    const link = tag("link");
    if (!title || !link || isNaN(t)) continue;
    out.push({ title, publisher, link, publishedAt: new Date(t).toISOString() });
  }
  return out;
}

export function isTrustedPublisher(publisher: string): boolean {
  const p = publisher.toLowerCase();
  return TRUSTED_PUBLISHERS.some((t) => p.includes(t));
}

function namesEntity(title: string, entity: string): boolean {
  const last = entity.trim().split(/\s+/).pop() || entity;
  return new RegExp(`(^|[^a-z])${last.toLowerCase().replace(/[^a-z0-9]/g, "")}([^a-z]|$)`, "i").test(title);
}

// Capitalised words that identify the event ("Parry", "Shnaider", "Ningbo"),
// minus the subject's own name, to group reports of the same story.
function eventWords(title: string, entity: string): Set<string> {
  const own = new Set(entity.toLowerCase().split(/\s+/).concat(["alex", "alexandra", "filipina", "filipino", "pinay", "philippines", "philippine"]));
  const words = title.match(/\b[A-Z][a-zA-Z'’-]{3,}\b/g) || [];
  return new Set(words.map((w) => w.toLowerCase()).filter((w) => !own.has(w)));
}

async function fetchNews(cfg: NonNullable<NonNullable<PageConfig["threads"]>["link_free_news"]>): Promise<NewsItem[]> {
  const hl = cfg.hl || "en-US";
  const gl = cfg.gl || "US";
  const ceid = cfg.ceid || `${gl}:${hl.split("-")[0]}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${cfg.query} when:2d`)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.items;
  let items: NewsItem[] = [];
  try {
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, FETCH_TIMEOUT_MS);
    if (res.ok) items = parseGoogleNews(await res.text());
    else console.error(`newsUpdates: Google News -> ${res.status}`);
  } catch (e) {
    console.error(`newsUpdates: Google News failed: ${(e as Error).message}`);
  }
  cache.set(url, { at: Date.now(), items });
  return items;
}

export function linkFreeUpdatesToday(postedLog: PostedLogEntry[], dateISO: string): number {
  return postedLog.filter((p) => p.source === "news_update" && (p.posted_at || "").startsWith(dateISO)).length;
}

export function buildNewsCandidates(items: NewsItem[], entity: string, maxAgeHours: number, now = Date.now()): Candidate[] {
  const fresh = items
    .filter((it) => isTrustedPublisher(it.publisher) && namesEntity(it.title, entity) && !EXCLUDED_LEADS.test(it.title))
    .filter((it) => now - Date.parse(it.publishedAt) <= maxAgeHours * 3_600_000)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const it of fresh) {
    const norm = it.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(norm)) continue;
    seen.add(norm);
    const mine = eventWords(it.title, entity);
    // Other trusted headlines about the same event add facts (a score, an
    // opponent) the caption may use; never headlines about something else.
    const related = fresh
      .filter((o) => o !== it && [...eventWords(o.title, entity)].some((w) => mine.has(w)))
      .slice(0, 3)
      .map((o) => `${o.title} (${o.publisher})`);
    out.push({
      source: "news_update",
      linkFree: true,
      // No ":" in the key: checks.ts's articleBaseKey cuts at the first one, so
      // "news:<slug>" made every update count as the same article.
      key: `news_${norm.replace(/\s+/g, "-").slice(0, 100)}`,
      subject: it.title,
      headline: it.title,
      link: it.link,
      publishedAt: it.publishedAt,
      realPublishedAt: it.publishedAt,
      rawText: [`${it.title} (reported by ${it.publisher})`, ...related].join(". Also reported: "),
    } as Candidate);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

export async function sourceLinkFreeNews(page: PageConfig, postedLog: PostedLogEntry[], dateISO: string): Promise<Candidate[]> {
  const cfg = page.threads?.link_free_news;
  if (!cfg?.query || !cfg.entity) return [];
  if (linkFreeUpdatesToday(postedLog, dateISO) >= (cfg.max_per_day ?? 3)) return [];
  const items = await fetchNews(cfg);
  return buildNewsCandidates(items, cfg.entity, cfg.max_age_hours ?? 12);
}
