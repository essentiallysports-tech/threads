// Mirrors the same PageConfig/ThreadsConfig shape es-page-registry uses (S3
// is the shared source of truth for both systems) — kept as a plain type
// copy here rather than a package dependency so this service has zero
// runtime coupling to that Next.js app.

export interface EntitySlot {
  name: string;
  keywords: string[];
  weight: number;
  // Match this slot's name/keywords as whole words only. Plain substring
  // matching stays the default because existing slots rely on it ("shaq" ->
  // "Shaquille", "golf" -> "golfer"); this is for bare team nicknames that
  // also sit inside ordinary words ("lions" in "Billions").
  whole_word?: boolean;
  // ⛔ OPERATOR FIX (2026-09-29, real live incident): this slot represents
  // the team/org as a whole (e.g. "Dallas Cowboys", keyword "cowboys"), not
  // one person — real live incident on Dallas Cowboys Community: 8 of 19
  // candidate attempts in one run were distinct, real, current stories
  // (Joey Porter Jr. contract talk, P.J. Locke's IR move, a Jerry Jones/
  // Micah Parsons-brother feud, a rival trade) all rejected
  // TOPIC_FREQUENCY_ENTITY_CAP or DOMINANT_NARRATIVE_CAP because they all
  // resolved primaryEntity="cowboys" — every one of these headlines opens
  // with "Cowboys ..." before the specific player's name, and
  // matchedEntityNames' ordering (checks.ts) picks whichever registered
  // match occurs FIRST in the text. The entity/dominant-narrative caps
  // exist to stop a page looking repetitive by fixating on ONE PERSON — a
  // team-identity slot is structurally never "one person," it's the page's
  // own broad umbrella, so treating it as capped the same way collapses
  // genuinely distinct daily news into one bucket and starves the page well
  // under its real budget. Same root cause independently degrades photo
  // quality: renderCard's searchTerms/hero-photo pick is the SAME ordered
  // list, so a specific-player story like "Cowboys Make Double Roster Move
  // After Placing P.J. Locke on IR" renders with a generic team photo
  // instead of Locke. Opt-in (default false, zero behavior change for
  // every slot that doesn't set it) rather than a blanket rule, matching
  // this file's whole_word precedent: is_team_identity=true drops this
  // specific slot to the END of matchedEntityNames' ordering whenever a
  // more specific (non-team-identity) match is ALSO present in the same
  // candidate, so a genuinely single-subject story about the team itself
  // still resolves to the team (nothing else to prefer), but a story that
  // also names a real person always prefers that person, for both the
  // frequency/narrative caps AND the photo subject.
  is_team_identity?: boolean;
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
  // Only post articles no other page has posted in the last 24h — see
  // crossPageLedger.ts. For pages whose natural candidate pool overlaps
  // established pages (e.g. several general-NASCAR accounts); an unflagged
  // page is never blocked by the cross-page ledger.
  exclusive_articles?: boolean;
  // How far back (hours) an exclusive_articles page looks for another page's
  // claim on the same article. Unset = 24. Clamped to (0, 24] — the ledger
  // only retains 24h of claims. Operator decision (2026-09-30): 12 on the
  // five general-NASCAR pages, where ~12 real ES NASCAR articles/day are
  // shared across nine NASCAR accounts; still spaces any two exclusive
  // accounts' posts of one story at least 12h apart (the 2026-09-22
  // incident was the same story on five accounts within ~8 minutes).
  exclusive_window_hours?: number;
  // ⛔ OPERATOR FIX (2026-09-30, real live incident): per-page override of
  // sourcing.ts's EVERGREEN_NON_RETRO_MAX_AGE_DAYS (21) — how old a
  // registered entity's real ES article can be and still count as usable
  // evergreen supply. Real incident: Alex Eala Fan Club and Fearless Female
  // Fighters (individual-athlete/small-roster pages, not team pages) went
  // starved for days — real ES coverage of their registered entities exists
  // (confirmed live: Amanda Nunes alone has 813 tagged articles), but an
  // individual fighter/player's news is inherently bursty, not daily, so
  // the newest 15-per-entity results (queryArticlesByEntity) are often
  // ALL older than 21 days between fight camps/tournaments — the entire
  // evergreen tier silently returns nothing for weeks, identical in shape
  // to the 2026-09-15 retrospective-page fix (checks.ts's
  // isTooRecentForRetrospectivePage) but for a page that isn't
  // retrospective, just low-frequency. 21 days stays the default
  // everywhere — it exists specifically to stop months-old news being
  // pushed as current on a page with steady daily volume (the
  // 2026-09-24 "College Football Program Bans Public From Attending
  // Spring Game" incident this constant was built for), which this
  // override never touches for any page that doesn't explicitly set it.
  // Widens ONLY which real, on-topic, correctly-attributed articles are
  // eligible for the evergreen tier — every relevance/accuracy/named-
  // entity gate downstream is completely unchanged.
  evergreen_max_age_days?: number;
  // (2026-09-30, operator decision) first claim on the day's AI-gateway
  // budget — see aiBudgetHold.ts. Once most of the budget is spent, pages
  // without this flag stop for the day after their 3rd post, so the rest of
  // the budget goes to the pages that actually earn the link clicks (Sep
  // 25-29: 8 pages, ~97% of GA4 Threads sessions). Unset = not priority.
  ai_priority?: boolean;
  // (2026-10-02, operator rule) "in no 6 hour window should the top 10 pages
  // by traffic have 0 posts ever." A page with this set never spends its
  // whole daily cap early (dailyRunWorkflow.ts pacedCapFor keeps one post in
  // reserve per (gap - 1) hours left in the UTC day), and once it has gone
  // (gap - 1.5) hours without a post it is "due" (checks.ts isGapDue): its
  // next runs go first, can widen supply (see sourceCandidatePool and
  // runDeterministicChecks) and may use the last 10% of the AI budget.
  // Relevance and accuracy gates are never relaxed. Unset = no guarantee.
  min_post_gap_hours?: number;
  // (2026-10-03, page-owner feedback) a fan page devoted to one person (its
  // highest-weight entity, e.g. LeBron on Kings Court Chronicles): stories
  // that read to that person's fans as a shot at them are rejected here
  // (CRITICAL_OF_PAGE_HERO) and left to the league newsroom page. See
  // checks.ts's flagshipStanceCheck.
  protect_flagship?: boolean;
  // (2026-10-09) how far back this page's throwback search reaches, in days
  // (default 120 — see GAP_RESCUE_EVERGREEN_DAYS in activities/index.ts). For a
  // page whose subject ES covers only a few times a week (Alex Eala: ~3
  // articles/week), the 21-120-day archive runs out; her older career moments
  // are still good throwback material.
  throwback_max_age_days?: number;
  // (2026-10-03, page-owner feedback) people this page no longer covers —
  // e.g. LeBron James on the Lakers page after his move to Philadelphia. A
  // story whose headline leads with one of them is rejected
  // (EXCLUDED_SUBJECT); a passing mention after the page's own subject is fine.
  exclude_subjects?: string[];
  // Internal, never set in the registry: while a gap-guarded page is due,
  // sourceCandidatePool sets this to the page's normal evergreen window, and
  // the evergreen tier then searches articles OLDER than that many days
  // (newest-first within that older range) instead of the newest overall —
  // the newest are, by definition, the ones already posted.
  evergreen_rescue_end_days?: number;
  // Internal, never set in the registry: while a gap-guarded page is due, the
  // pool may hold this many candidates (normally 20), with the page's own
  // throwback items placed ahead of web/social search results.
  rescue_candidate_cap?: number;
  // Fixed, page-level hashtag set (e.g. ["#GoBucks", "#BuckeyeNation"]) —
  // appended on every post ALONGSIDE the existing per-story dynamic hashtag
  // from buildTopicHashtag, never replacing it. Confirmed live (2026-08-24):
  // manual posts on this page's own account use a consistent branded set on
  // every post, which our per-story-only hashtag never repeats — no
  // accumulating brand/community signal across posts. Optional and empty by
  // default; only populate with hashtags actually confirmed from real fan
  // usage for that page, never invented.
  branded_hashtags?: string[];
  // ⛔ OPERATOR ADD (2026-09-12, explicit operator directive): "for the
  // essentiallysports media page, these are the only 4 sports for which 1
  // post should go each... to be scheduled at the time told." Before this,
  // a "national" page (p44) had no way to restrict itself to a fixed set of
  // sports or pin a post to a specific clock time — every post on every
  // page just gets scheduled for "~1 hour from whenever this cycle
  // finishes" (dailyRunWorkflow.ts's `postTime`). `sport_groups` is a flat
  // matchable-keyword list with no per-entry cap or timing, so this is a
  // separate, additive structure: when present, checkFixedSportSlot
  // (checks.ts) restricts candidates to ONLY a sport_group in one of these
  // slots and caps each slot to one post per rolling 24h, and
  // dailyRunWorkflow.ts's scheduling step pins that item's post to the
  // slot's next IST clock-time occurrence instead of the default "+1h"
  // timestamp. `sport_groups` here can list MULTIPLE real matchable
  // strings for one slot (e.g. ["UFC","Boxing"] both feeding one "Combat"
  // slot/post) — matchedSportGroup only ever matches the literal words a
  // real headline actually contains ("UFC", "Boxing"), never the slot's
  // own display label, which may not appear in any real story text at all.
  fixed_sport_slots?: FixedSportSlot[];
}

export interface FixedSportSlot {
  label: string; // display/log name for this slot, e.g. "Combat" — not itself matched against candidate text
  sport_groups: string[]; // real page.sport_groups entries that feed this one slot (matchedSportGroup semantics)
  post_time_ist: string; // "HH:MM", 24h IST clock time this slot's one daily post is scheduled for
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
  // ⛔ OPERATOR FIX (2026-09-10, real live incident): loadActiveThreadsPages
  // (s3registry.ts) used to infer "this is a dedicated-firehose page, the
  // main workflow must never also pick it up" purely from sport_groups:[]
  // AND entities:[] both being empty (see that function's own 2026-08-27
  // comment). That inference broke for p81 (Broadcaster and Media), a
  // firehose page that genuinely NEEDS real entities for its own relevance
  // matching (sourceFromEsArticles' entity-only-scoped mode) but has no
  // sport_groups — confirmed live: it slipped past the guard and started
  // getting full AI-rendered infographic cards from the main workflow
  // (dailyRunWorkflow.ts) on top of its intended plain-link firehose posts,
  // both pipelines posting to the same account uncoordinated. This explicit
  // flag is the real, unambiguous signal a firehose page's shape can never
  // accidentally satisfy or fail to satisfy — set on every page owned by
  // firehoseWorkflow.ts (getPageById, not this list), checked in ADDITION
  // to the original both-empty inference, which stays as a safety net.
  is_firehose_only?: boolean;
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
  // ⛔ OPERATOR FIX (2026-09-11, real live incident): evergreen_search stamps
  // `publishedAt` as synthetic-today (see sourceFromEsEvergreenArticles's own
  // comment) so freshness gates don't wrongly exclude a real-but-aged
  // article — but that leaves no genuine date for anything that needs to
  // know the article's REAL age (classifyCaptionAgeTone's retro/throwback
  // framing, confirmed live captioning a CURRENT Rory McIlroy FedExCup story
  // as "Throwback to..."). Set only by the evergreen tier when the source
  // WordPress API actually returned a real date; absent for every other
  // source and for the rare case that date was itself missing.
  realPublishedAt?: string; // ISO, the article's REAL publish date (not synthetic)
  // (2026-10-02) set on an evergreen candidate that only qualified because a
  // gap-guarded page was due (widened age window) — classifyCaptionAgeTone
  // frames it as a throwback rather than as news.
  rescue?: boolean;
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
