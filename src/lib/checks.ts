// Deterministic, code-enforced checks — the entire reason this service
// exists instead of the old prose skill file. Every function here is a pure
// function or a real HTTP call; nothing here is "ask the model to remember
// to check this."

import { Candidate, PageConfig, PostedLogEntry } from "./types";

// ⛔ OPERATOR FIX (2026-08-08, real live incident): a post's reply linked to
// a random x.com tweet URL instead of ES's own content — "only ES article
// link/ES newsletter link... is allowed in the reply, no random links,
// hardcode this." This is a hard ALLOWLIST, replacing the old competitor-
// site blocklist entirely (anything on that old list necessarily fails this
// too, so keeping both was dead weight) — the reply link must be
// essentiallysports.com (the real article) or a *.beehiiv.com subdomain
// (one of the real ES newsletter publications), full stop. The
// web_search/social_search/evergreen_search sourcing tiers (sourcing.ts) are
// genuinely useful for DISCOVERING what's newsworthy right now, but their
// own result URL (an external site, a tweet) must never become the actual
// reply target — this check is what actually enforces that, applied to
// every candidate regardless of which tier found it.
export function isEsOwnedLink(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "essentiallysports.com" || host.endsWith(".beehiiv.com");
  } catch {
    return false;
  }
}

// A candidate's subject/headline text must plausibly connect to this page's
// own registered entities or sport_groups — the deterministic version of the
// old skill file's `entity_or_sport_match`, and the exact check that would
// have stopped the WNBA/boxing incident that started this whole rewrite.
export function entityOrSportMatch(candidate: Candidate, page: PageConfig): boolean {
  const haystack = `${candidate.subject} ${candidate.headline} ${candidate.rawText || ""}`.toLowerCase();
  const entityNames = page.entities.map((e) => e.name.toLowerCase());
  const entityKeywords = page.entities.flatMap((e) => e.keywords.map((k) => k.toLowerCase()));
  const sportGroups = page.sport_groups.map((s) => s.toLowerCase());
  const all = [...entityNames, ...entityKeywords, ...sportGroups];
  if (all.length === 0) return true; // nothing registered to check against — don't block
  return all.some((term) => term.length > 2 && haystack.includes(term));
}

// Which of this page's registered entities (athletes/teams) actually matched
// this candidate — the deterministic source of "which athlete images to pull
// from ES-MCP" for the infographic render step. Returns real EntitySlot
// display names (e.g. "LeBron James"), not raw keywords, so they're directly
// usable as an ES-MCP search_images query. Deliberately separate from
// entityOrSportMatch (a boolean pass/fail) — this is about WHICH entity, not
// whether one matched, per the operator's explicit choice (2026-08-06) to
// keep athlete identification deterministic/code-driven rather than leaving
// it to the render Routine's own judgment.
// Same idea as matchedEntityNames, but for sport_groups — which real league
// this candidate is actually about, for the topic-frequency league cap.
export function matchedSportGroup(candidate: Candidate, page: PageConfig): string | null {
  const haystack = `${candidate.subject} ${candidate.headline} ${candidate.rawText || ""}`.toLowerCase();
  return page.sport_groups.find((s) => haystack.includes(s.toLowerCase())) || null;
}

// ⛔ OPERATOR FIX (2026-08-08, real live incident): confirmed live that
// several pages' `EntitySlot.name` is a COMMA-JOINED list of multiple real
// people ("A'ja Wilson, Caitlin Clark", "Angel Reese, Paige Bueckers,
// Breanna Stewart" — p42 Essentially WNBA) rather than one display name;
// `keywords` holds the actual individual names in the same slot. Returning
// the whole compound `name` string as the "primary entity" handed
// accuracyGate a string that can never appear verbatim in any real article
// ("does the body contain 'A'ja Wilson, Caitlin Clark'?" — never true) —
// this silently and permanently failed SOURCE_DOES_NOT_MENTION_SUBJECT on
// every single candidate for any page with a compound-name slot, which is
// exactly why p42 hadn't posted in 2+ days despite having plenty of real,
// on-topic candidates pass every earlier gate. Returns the SPECIFIC
// individual keyword(s) that actually matched instead, falling back to the
// whole `name` only for slots that are genuinely one single name with no
// keywords array (team-name slots like "Los Angeles Lakers" are unaffected
// either way, since that IS the real, searchable, article-usable string).
export function matchedEntityNames(candidate: Candidate, page: PageConfig): string[] {
  const haystack = `${candidate.subject} ${candidate.headline} ${candidate.rawText || ""}`.toLowerCase();
  const matched: string[] = [];
  for (const e of page.entities) {
    const individualNames = e.keywords.length > 0 ? e.keywords : [e.name];
    for (const name of individualNames) {
      if (name.length > 2 && haystack.includes(name.toLowerCase())) matched.push(name);
    }
  }
  return matched;
}

// ⛔ OPERATOR FIX (2026-08-07, real live incident): a post about "Star
// Fighter's Brother's UFC Debut Canceled" went out live — that's not a
// caption-writing failure, it's SEEDED TEST/PLACEHOLDER content in the
// Beehiiv source (matches other observed test-labeled entries: "(low)",
// "(high - X core test)", "- test success") that nothing in the pipeline
// filtered out. Two distinct signals below, both checked deterministically
// before a candidate ever reaches captioning/rendering:
// ⛔ OPERATOR FIX (2026-08-08, real live incident): a seeded "Ex-UFC Champ
// Mourns Mother's Death (Test)" candidate passed every gate and reached the
// render step — none of the existing patterns catch a plain "(Test)"/"(test)"
// suffix, only the more specific "(low)"/"(high"/"core test" variants seen
// before. Added as its own pattern rather than broadening an existing one,
// since "(test)" alone is common enough test-content phrasing to risk false
// positives if merged into a looser existing rule.
const TEST_MARKER_PATTERNS = [/\(low\)/i, /\(high\b/i, /core\s+test/i, /-\s*test\s+success/i, /\btest\s+mode\b/i, /\(test\)/i];

export function isTestMarkerContent(candidate: Candidate): boolean {
  const text = `${candidate.subject} ${candidate.headline} ${candidate.rawText || ""}`;
  return TEST_MARKER_PATTERNS.some((re) => re.test(text));
}

// ⛔ OPERATOR FIX (2026-08-08): "do what is left" — two real guardrails the
// reference skill file specified (Section 8's topic-frequency limits,
// Section "Hard Caps"' dominant-narrative cap) but this project never built.
// Both need to know WHICH entity/league a PAST post covered — see
// PostedLogEntry.entity/.sportGroup, populated at post time.
export interface FrequencyCheckResult {
  pass: boolean;
  reason: string | null;
}

function withinHours(entry: PostedLogEntry, hours: number, now: number): boolean {
  const t = entry.posted_at ? new Date(entry.posted_at).getTime() : NaN;
  return !isNaN(t) && now - t <= hours * 3600 * 1000;
}

// Ported from ES-Threads-Automation-Skill-v1.md Section 8: 3 entity tags/24h,
// 5 league tags/24h between posts on the same page — this doesn't fight the
// throughput goal, it just stops one entity/league from crowding out
// everything else in a single day.
//
// ⛔ OPERATOR FIX (2026-08-08): the original min-gap here was 2 hours, ported
// verbatim from the reference skill file without checking it against THIS
// project's actual hourly firing cadence — with 26 pages and a strict 2h
// gap, any page that posted in hour N is unconditionally blocked in hour
// N+1, capping real per-run eligibility to roughly half the registry
// regardless of content quality (confirmed live: a run right after a
// high-volume hour dropped to 5/26 posted, nearly all blocked by this one
// check). Operator directive: shorten to 50 minutes — just under the hourly
// interval, so a page is eligible again by the very next firing rather than
// skipping every other one, while still preventing the same page from
// posting twice within a single hour if a run ever executes out of its
// normal cadence.
const MIN_GAP_MINUTES = 50;

export function topicFrequencyCheck(primaryEntityName: string | null, primarySportGroup: string | null, postedLog: PostedLogEntry[]): FrequencyCheckResult {
  const now = Date.now();
  const last24h = postedLog.filter((p) => withinHours(p, 24, now));

  const mostRecentPostTime = last24h.reduce((latest, p) => {
    const t = p.posted_at ? new Date(p.posted_at).getTime() : 0;
    return t > latest ? t : latest;
  }, 0);
  if (mostRecentPostTime > 0 && now - mostRecentPostTime < MIN_GAP_MINUTES * 60 * 1000) {
    return { pass: false, reason: `TOPIC_FREQUENCY_MIN_GAP_${MIN_GAP_MINUTES}M` };
  }

  if (primaryEntityName) {
    const entityCount = last24h.filter((p) => p.entity === primaryEntityName).length;
    if (entityCount >= 3) return { pass: false, reason: `TOPIC_FREQUENCY_ENTITY_CAP:${primaryEntityName}` };
  }
  if (primarySportGroup) {
    const sportCount = last24h.filter((p) => p.sportGroup === primarySportGroup).length;
    if (sportCount >= 5) return { pass: false, reason: `TOPIC_FREQUENCY_LEAGUE_CAP:${primarySportGroup}` };
  }
  return { pass: true, reason: null };
}

// Ported from the reference skill file's "DOMINANT-NARRATIVE CAP" — no
// single subject may account for more than ~25% of a page's posts in any
// rolling 7-day window (the real, twice-recurring DJ Moore/Bills incident
// that rule exists to stop). Exempt below a minimum sample (4 posts) since
// a ratio is meaningless — and misleadingly restrictive — over a tiny count.
export function dominantNarrativeCheck(primaryEntityName: string | null, postedLog: PostedLogEntry[]): FrequencyCheckResult {
  if (!primaryEntityName) return { pass: true, reason: null };
  const now = Date.now();
  const last7d = postedLog.filter((p) => withinHours(p, 24 * 7, now));
  if (last7d.length < 4) return { pass: true, reason: null };
  const entityCount = last7d.filter((p) => p.entity === primaryEntityName).length;
  if ((entityCount + 1) / (last7d.length + 1) > 0.25) {
    return { pass: false, reason: `DOMINANT_NARRATIVE_CAP:${primaryEntityName}` };
  }
  return { pass: true, reason: null };
}

// ⛔ OPERATOR FIX (2026-08-07): "vague things should never go out, it must
// contain proper names" — not just a pattern match on "star fighter"-style
// phrasing, a hard rule. If this page has ANY registered entities to check
// against (athletes or teams — matchedEntityNames covers both), a candidate
// that matches none of them by name has no real proper noun to build a
// specific post around, full stop. Pages with an EMPTY entities list (none
// registered) are exempt — entityOrSportMatch already treats that the same
// way (nothing registered to check against, don't block on it).
//
// ⛔ SECOND EXEMPTION (2026-08-08, activating p44 "EssentiallySports Media"):
// a "national" page_type is architecturally different — its `entities`
// array is a single generic placeholder ("Biggest cross-sport storylines of
// the week", keywords like "sports news"/"athlete news"), not a real
// athlete/team list, because national roundup pages are explicitly designed
// to cover whatever's biggest across sports that week, not track specific
// people. Applying the named-entity rule there would reject nearly
// everything it's supposed to post. `national_threshold` (not entity
// matching) is that page type's own real relevance gate.
export function requiresNamedEntity(candidate: Candidate, page: PageConfig, matchedNames: string[]): boolean {
  if (page.page_type === "national") return false;
  return page.entities.length > 0 && matchedNames.length === 0;
}

// Same key (exact story/edition) already posted on this page, ever within
// the given window — replaces the old skill file's per-page idempotency
// check with a real, deterministic array scan.
export function alreadyPostedRecently(candidate: Candidate, log: PostedLogEntry[], withinHours: number): boolean {
  const cutoff = Date.now() - withinHours * 3600 * 1000;
  // Confirmed live: real posted-log entries can be missing `posted_at`
  // entirely (schema drift). Treat an unparseable/missing timestamp as
  // "not recent enough to match" rather than throwing/NaN-comparing —
  // this check erring toward "not a duplicate" on bad data is the safer
  // failure direction than silently crashing the whole workflow task.
  return log.some((p) => {
    if (p.key !== candidate.key) return false;
    const t = p.posted_at ? new Date(p.posted_at).getTime() : NaN;
    return !isNaN(t) && t > cutoff;
  });
}

// Same literal link already posted on this page within 24h — this is the
// exact check that would have caught the real coloradoprimetime_ incident
// (same link posted 10+ times in a day under different story wrappers).
export function duplicateLinkRecently(candidate: Candidate, log: PostedLogEntry[], withinHours = 24): boolean {
  const cutoff = Date.now() - withinHours * 3600 * 1000;
  return log.some((p) => {
    if (p.reply_url !== candidate.link) return false;
    const t = p.posted_at ? new Date(p.posted_at).getTime() : NaN;
    return !isNaN(t) && t > cutoff;
  });
}

// Which render templates this page has already used TODAY — the deterministic
// input to the least-used-today rotation in activities/index.ts's
// chooseTemplate, ported from the real threads-automation skill file's
// "MANDATORY TEMPLATE VARIETY" rule (never default back to the same one or
// two templates; prefer whichever approved template has been used least
// today). Reads straight off the same posted-log entries every other check
// here already uses — no new storage, just a new field on PostedLogEntry.
export function templatesUsedToday(postedLog: PostedLogEntry[], dateISO: string): string[] {
  return postedLog.filter((p) => (p.posted_at || "").startsWith(dateISO) && p.template).map((p) => p.template as string);
}

// ── Political content filter — ZERO EXCEPTIONS, ported verbatim from
// ES-Threads-Automation-Skill-v1.md's Political Content Filter section. ──
//
// Tier 1: instant drop, no context check at all.
const POLITICAL_TIER1 = [/\btrump\b/i, /\bdemocrats?\b/i, /\brepublicans?\b/i, /white\s+house\s+shooting/i];
// Tier 2: context check — passes only when a sports noun is adjacent;
// blocked otherwise. A White House VENUE story is blocked even when
// sports-related (a real team/athlete White House visit still reads as
// politically-adjacent regardless of sports framing).
const POLITICAL_TIER2 = [/\bpresident\b/i, /\bshooting\b/i, /\bpolitical\b/i, /white\s+house/i];
const SPORTS_NOUNS = /\b(team|game|player|athlete|coach|league|season|championship|trophy|match|tournament|roster|draft|contract|stadium|arena|nfl|nba|mlb|nhl|ufc|mma|wnba|f1|nascar|golf|tennis|boxing)\b/i;
const WHITE_HOUSE_VENUE = /white\s+house/i;

export function politicalContentCheck(candidate: Candidate): { blocked: boolean; reason: string | null } {
  const text = `${candidate.subject} ${candidate.headline} ${candidate.rawText || ""}`;

  if (WHITE_HOUSE_VENUE.test(text)) {
    return { blocked: true, reason: "WHITE_HOUSE_VENUE_BLOCKED" };
  }
  for (const re of POLITICAL_TIER1) {
    if (re.test(text)) return { blocked: true, reason: `POLITICAL_TIER1:${re.source}` };
  }
  for (const re of POLITICAL_TIER2) {
    if (re.test(text) && !SPORTS_NOUNS.test(text)) {
      return { blocked: true, reason: `POLITICAL_TIER2_NO_SPORTS_CONTEXT:${re.source}` };
    }
  }
  return { blocked: false, reason: null };
}

// ── Accuracy gate — a DETERMINISTIC approximation, not full per-claim LLM
// fact-checking. This project's whole design principle (see file header) is
// "a pure function or a real HTTP call, nothing here is ask-the-model-to-
// remember" — a Temporal worker activity has no LLM call at runtime to do
// what the real skill file's Routine does (re-verify every claim against a
// fetched source). What IS deterministically checkable, and is checked
// here: (1) freshness (already isFreshEnough), (2) the linked source
// actually EXISTS and its fetched text plausibly supports the headline —
// the primary matched entity name appears in the article body. This catches
// the cheap, real failure mode (headline/link mismatch, stale link reused
// for a new headline) without claiming to replicate full fact-checking.
export interface AccuracyGateResult {
  pass: boolean;
  reason: string | null;
}

// ⛔ OPERATOR FIX (2026-08-08, real live incident): a real hourly run logged
// LINK_DEAD/SOURCE_UNREACHABLE for a batch of real, live URLs (Yahoo Sports,
// Mirror, NorthJersey, etc.) — re-testing every one of them minutes later,
// from the exact same EC2 host, every single one resolved fine (HTTP 200).
// This was transient site-side flakiness or a momentary network blip during
// that run, not a real dead link or a code bug — but a single failed attempt
// with zero retry was throwing away an otherwise-good candidate (and
// therefore that page's whole slot for the hour) over a hiccup. One retry
// with a short backoff, applied to both fetch call sites that decide
// pass/fail on network reachability, costs at most a few seconds per
// candidate and meaningfully reduces false-negative drops from transient
// blips without weakening what "reachable"/"mentions the subject" means.
async function fetchWithRetry(url: string, init: RequestInit, attempts = 2): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastError;
}

export async function accuracyGate(candidate: Candidate, primaryEntityName: string | null, maxAgeHours: number): Promise<AccuracyGateResult> {
  if (!isFreshEnough(candidate, maxAgeHours)) {
    return { pass: false, reason: "STALE_CANDIDATE" };
  }
  if (!primaryEntityName) {
    // No registered entity matched — entityOrSportMatch already gates this
    // upstream; nothing further to check evidence against here.
    return { pass: true, reason: null };
  }
  // Verify against where the claim actually came from — sourceLink for a
  // candidate whose reply `link` was resolved to an ES-owned URL (see
  // sourcing.ts's resolveExternalLink), otherwise `link` itself.
  const verifyUrl = candidate.sourceLink || candidate.link;
  try {
    const res = await fetchWithRetry(verifyUrl, { redirect: "follow" });
    if (!res.ok) return { pass: false, reason: `SOURCE_UNREACHABLE:${res.status}` };
    const body = await res.text();
    // Strip HTML tags for a plain-text substring check — cheap, no parser dependency.
    const plain = body.replace(/<[^>]+>/g, " ").toLowerCase();
    const nameLower = primaryEntityName.toLowerCase();
    if (!plain.includes(nameLower)) {
      return { pass: false, reason: `SOURCE_DOES_NOT_MENTION_SUBJECT:${primaryEntityName}` };
    }
  } catch (e) {
    return { pass: false, reason: `SOURCE_FETCH_ERROR:${(e as Error).message}` };
  }
  return { pass: true, reason: null };
}

export async function linkResolves(url: string): Promise<boolean> {
  try {
    const head = await fetchWithRetry(url, { method: "HEAD", redirect: "follow" });
    if (head.ok) return true;
    const get = await fetchWithRetry(url, { method: "GET", redirect: "follow" });
    return get.ok;
  } catch {
    return false;
  }
}

export function hasUtm(url: string): boolean {
  return url.includes("utm_source=") && url.includes("utm_medium=");
}

export function appendUtm(url: string, utmString: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${utmString}`;
}

// Freshness gate for a Beehiiv edition candidate — a stale newsletter edition
// (confirmed live: one publication's latest "confirmed" post was ~7 weeks
// old) is not a good primary source; fall back to the shared pool instead.
export function isFreshEnough(candidate: Candidate, maxAgeHours: number): boolean {
  const ageMs = Date.now() - new Date(candidate.publishedAt).getTime();
  return ageMs <= maxAgeHours * 3600 * 1000;
}

export interface CandidateCheckResult {
  pass: boolean;
  reason: string | null;
}

// The one function that runs every gate against a single candidate for a
// single page. Every field here is checked in real code — nothing here is
// an LLM "please remember to verify this."
//
// ⛔ There is deliberately no cross-page "same story on multiple pages"
// check here (see dailyRunWorkflow.ts's 2026-08-07 operator correction —
// different pages legitimately covering the same real, topically-relevant
// story is normal, not a duplicate). Real duplicate prevention stays
// per-page/per-link below (alreadyPostedRecently, duplicateLinkRecently).
export function runDeterministicChecks(candidate: Candidate, page: PageConfig, postedLog: PostedLogEntry[]): CandidateCheckResult {
  const political = politicalContentCheck(candidate);
  if (political.blocked) {
    return { pass: false, reason: political.reason };
  }
  if (!entityOrSportMatch(candidate, page)) {
    return { pass: false, reason: "NO_ENTITY_SPORT_MATCH" };
  }
  if (isTestMarkerContent(candidate)) {
    return { pass: false, reason: "TEST_MARKER_CONTENT" };
  }
  if (requiresNamedEntity(candidate, page, matchedEntityNames(candidate, page))) {
    return { pass: false, reason: "NO_NAMED_ENTITY" };
  }
  // Allowlist, not the old competitor blocklist — strictly subsumes it
  // (anything on COMPETITOR_DOMAINS necessarily fails this too), and also
  // catches the real incident that motivated it: a tweet/social URL, or any
  // other external site, ending up as the reply link.
  if (!isEsOwnedLink(candidate.link)) {
    return { pass: false, reason: "LINK_NOT_ES_OWNED" };
  }
  if (alreadyPostedRecently(candidate, postedLog, 24 * 14)) {
    return { pass: false, reason: "ALREADY_POSTED" };
  }
  if (duplicateLinkRecently(candidate, postedLog, 24)) {
    return { pass: false, reason: "DUPLICATE_LINK_24H" };
  }
  return { pass: true, reason: null };
}
