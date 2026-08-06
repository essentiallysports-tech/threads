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
  source: "beehiiv_newsletter" | "shared_pool";
  key: string; // stable id for dedup — beehiiv post id, or source_story_id
  subject: string;
  headline: string;
  link: string; // the ONE link that goes in the reply
  publishedAt: string; // ISO
  thumbnailUrl?: string | null;
  rawText?: string; // whatever text is available to build a caption from
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
}

export interface PageRunResult {
  page_id: string;
  outcome: "posted" | "dropped" | "skipped_capped" | "no_candidate" | "dry_run_would_post";
  reason?: string;
  candidate?: Candidate;
  post_id?: string;
  cardUrl?: string | null; // visibility into whether renderCard actually produced an image
}
