// Mirrors the same PageConfig/ThreadsConfig shape es-page-registry uses (S3
// is the shared source of truth for both systems) — kept as a plain type
// copy here rather than a package dependency so this service has zero
// runtime coupling to that Next.js app.

export interface EntitySlot {
  name: string;
  keywords: string[];
  weight: number;
}

export interface ThreadsConfig {
  account_handle: string;
  postiz_integration_id: string;
  char_limit: number;
  hashtag_logic: string;
  topic_registration: boolean;
  caption_voice_mode?: "brand" | "fan";
  emoji_count_min?: number;
  emoji_count_max?: number;
  beehiiv_publication_id?: string;
  beehiiv_link_exempt?: boolean;
  daily_budget_min?: number;
  daily_budget_max?: number;
  posting_window_start?: string;
  posting_window_end?: string;
  utm_string?: string;
}

export interface PageConfig {
  page_id: string;
  page_name: string;
  page_type: "national" | "regional" | "entity";
  platform: "facebook" | "threads";
  status: "active" | "paused";
  page_theme: string;
  sport_groups: string[];
  entities: EntitySlot[];
  national_threshold: number;
  rival_entities: string[];
  threads?: ThreadsConfig;
}

export interface PageIndexEntry {
  page_id: string;
  page_name: string;
  platform: string;
  status: string;
}

export interface PageIndex {
  pages: PageIndexEntry[];
  last_updated: string;
}

// A sourced candidate — either a newsletter edition (direct-from-Beehiiv) or
// an article-style story from the shared T2 pool the Facebook pipeline also
// produces. This is the ONE thing per page this workflow tries to post.
export interface Candidate {
  source: "beehiiv_newsletter" | "shared_pool" | "es_article" | "web_search" | "social_search" | "evergreen_search";
  key: string; // stable id for dedup — beehiiv post id, or source_story_id
  subject: string;
  headline: string;
  link: string; // the ONE link that goes in the reply
  publishedAt: string; // ISO
  thumbnailUrl?: string | null;
  rawText?: string; // whatever text is available to build a caption from
  // ⛔ OPERATOR FIX (2026-08-08): "only ES article/newsletter link allowed in
  // the reply" — for externally-discovered candidates (web_search/
  // social_search/evergreen_search), `link` gets resolved to an ES-owned
  // URL before posting (see sourcing.ts's resolveExternalLinks). This flag
  // tells the caption writer which kind of link it actually is: "same_story"
  // means a real ES article covering this exact story was found (CTA can
  // say "full story in the reply"); "subscribe" means no matching ES
  // article existed and the link is just the page's own newsletter (CTA
  // must NOT claim the newsletter covers this story — it's a "want more
  // like this? subscribe" framing instead, which stays honest).
  linkContext?: "same_story" | "subscribe";
  // The ORIGINAL discovery-source URL, preserved when `link` gets swapped to
  // an ES-owned URL by resolveExternalLink. The accuracy gate verifies the
  // claim against THIS (where the fact actually came from), never against
  // `link` — a page's generic newsletter (the "subscribe" fallback) was
  // never going to mention this specific story, and checking it there was a
  // real regression that tanked fill-rate the moment link resolution shipped.
  sourceLink?: string;
}

export interface PostedLogEntry {
  key: string;
  post_id?: string;
  // Optional, not required — confirmed live (2026-08-05) that real S3
  // posted-logs contain entries missing this field entirely. Every reader
  // of this field must treat it as possibly absent (see lib/checks.ts and
  // workflows/dailyRunWorkflow.ts), never assume it's always a valid string.
  posted_at?: string;
  reply_url?: string | null;
  headline?: string;
  // Which render layout this post used — read back by checks.templatesUsedToday
  // to drive the least-used-today template rotation (2026-08-07 operator fix:
  // every live post had been landing on the same "breaking" layout).
  template?: string;
  // ⛔ OPERATOR FIX (2026-08-08): "do what is left" — the reference skill
  // file's topic-frequency and dominant-narrative caps both need to know
  // WHICH entity/league a past post was actually about, which nothing
  // previously recorded. Populated from matchedEntityNames/page.sport_groups
  // at post time; read back by checks.ts's topicFrequencyCheck and
  // dominantNarrativeCheck.
  entity?: string;
  sportGroup?: string;
}

export type TemplateId = "hero" | "standard_editorial" | "dramatic_news" | "comparison" | "quote";

export interface PageRunResult {
  page_id: string;
  outcome: "posted" | "dropped" | "skipped_capped" | "no_candidate" | "dry_run_would_post";
  reason?: string;
  candidate?: Candidate;
  post_id?: string;
  cardUrl?: string | null; // visibility into whether renderCard actually produced an image
}
