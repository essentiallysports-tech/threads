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
  // Fixed, page-level hashtag set (e.g. ["#GoBucks", "#BuckeyeNation"]) —
  // appended on every post ALONGSIDE the existing per-story dynamic hashtag
  // from buildTopicHashtag, never replacing it. Confirmed live (2026-08-24):
  // manual posts on this page's own account use a consistent branded set on
  // every post, which our per-story-only hashtag never repeats — no
  // accumulating brand/community signal across posts. Optional and empty by
  // default; only populate with hashtags actually confirmed from real fan
  // usage for that page, never invented.
  branded_hashtags?: string[];
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
  source: "beehiiv_newsletter" | "shared_pool" | "es_article" | "web_search" | "social_search" | "evergreen_search" | "beehiiv_poll";
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
  // ⛔ OPERATOR FIX (2026-08-19, real live incident): "if say 80 ES articles
  // and 65 are relevant to our pages... we can directly create at least 100
  // posts from them." A page used to get exactly ONE candidate per real ES
  // article — once posted, that article's key went into postedLog and every
  // future candidate sharing it was filtered out for good (see sourcing.ts's
  // postedKeys check), so real article volume was structurally capped at
  // 1 post/article regardless of how much daily budget was left unfilled.
  // sourceFromEsArticles now emits multiple candidates per real article,
  // each with a distinct `key` (so dedup treats them as separate posts) and
  // a different `angle` — the SAME real facts/link, told from a genuinely
  // different narrative framing (stat-led, debate/reaction, comparison,
  // "why it matters"). Optional — undefined means "no specific angle,
  // default framing," the prior behavior.
  angle?: "stat" | "debate" | "comparison" | "significance";
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
  // ⛔ OPERATOR FIX (2026-08-14, real live incident): the render pipeline has
  // always computed a real card_url (renderCard's own return value, used to
  // actually build the Postiz post) but never once saved it here — the
  // dashboard's "No image" on 100% of posts wasn't a display bug, this
  // field simply never existed in any real entry to display. Postiz's own
  // API carries no card/media field either (types/dashboard.ts's
  // PostizPost), so this is the only place a real value can come from.
  card_url?: string | null;
  // ⛔ OPERATOR FIX (2026-08-29, real live incident): confirmed live — the
  // same source photo (e.g. one Deion Sanders shot) used across many
  // consecutive posts on one page despite ES-MCP returning several real
  // alternatives, because nothing anywhere recorded which raw reference
  // photo a past post actually used. `card_url` is the final AI-rendered
  // output (a different image every time even when the source repeats), so
  // it can never answer "have I used THIS photo before." This is the raw
  // ES-MCP candidate URL passed to OpenArt as `reference_photo_url` — read
  // back by activities/index.ts's recentlyUsedPhotoUrls() to skip repeats.
  source_photo_url?: string | null;
  // ⛔ OPERATOR FIX (2026-08-18, real live incident): "hardcoded filters
  // list... must include this today's date and what date the source
  // article is from." A 3-month-old ESPN article got posted as breaking
  // news and there was no way to audit it after the fact — the posted log
  // never recorded which sourcing tier a post came from or what its real
  // source publish date was, only `posted_at` (when WE posted it). Both are
  // now recorded on every entry so any future incident can be diagnosed
  // from the log alone, without a manual curl/JSON-LD check.
  source?: Candidate["source"];
  source_published_at?: string;
}

// Kept in sync with renderSpec.ts's own TemplateId (duplicated here rather
// than imported — pre-existing split in this codebase, not introduced by
// this change; TypeScript catches drift between the two at compile time).
export type TemplateId = "hero" | "standard_editorial" | "dramatic_news" | "comparison" | "quote" | "retro";

export interface PageRunResult {
  page_id: string;
  outcome: "posted" | "dropped" | "skipped_capped" | "no_candidate" | "dry_run_would_post";
  reason?: string;
  candidate?: Candidate;
  post_id?: string;
  cardUrl?: string | null; // visibility into whether renderCard actually produced an image
}
