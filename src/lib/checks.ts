// Deterministic, code-enforced checks — the entire reason this service
// exists instead of the old prose skill file. Every function here is a pure
// function or a real HTTP call; nothing here is "ask the model to remember
// to check this."

import { Candidate, PageConfig, PostedLogEntry } from "./types";

export const COMPETITOR_DOMAINS = [
  "bloodyelbow.com", "sportskeeda.com", "si.com", "bleacherreport.com",
  "thescore.com", "yahoo.com", "cbssports.com", "espn.com",
  "theathletic.com", "sportingnews.com", "clutchpoints.com",
];

export function findCompetitorDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const hit = COMPETITOR_DOMAINS.find((d) => host === d || host.endsWith(`.${d}`));
    return hit || null;
  } catch {
    return null; // malformed URL is a different check's problem
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
export function matchedEntityNames(candidate: Candidate, page: PageConfig): string[] {
  const haystack = `${candidate.subject} ${candidate.headline} ${candidate.rawText || ""}`.toLowerCase();
  return page.entities
    .filter((e) => {
      const terms = [e.name.toLowerCase(), ...e.keywords.map((k) => k.toLowerCase())];
      return terms.some((t) => t.length > 2 && haystack.includes(t));
    })
    .map((e) => e.name);
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

// Cross-page, same-run duplicate — the deterministic version of the run-level
// circuit breaker added to the prose skill file after the 107-posts incident.
// `seenThisRun` is a Set the caller maintains across the whole run.
export function isMassDuplicateThisRun(candidate: Candidate, seenThisRun: Set<string>): boolean {
  const normalized = candidate.headline.toLowerCase().trim();
  return seenThisRun.has(normalized);
}

export function recordSeenThisRun(candidate: Candidate, seenThisRun: Set<string>): void {
  seenThisRun.add(candidate.headline.toLowerCase().trim());
}

export async function linkResolves(url: string): Promise<boolean> {
  try {
    const head = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (head.ok) return true;
    const get = await fetch(url, { method: "GET", redirect: "follow" });
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
export function runDeterministicChecks(
  candidate: Candidate,
  page: PageConfig,
  postedLog: PostedLogEntry[],
  seenThisRun: Set<string>
): CandidateCheckResult {
  if (!entityOrSportMatch(candidate, page)) {
    return { pass: false, reason: "NO_ENTITY_SPORT_MATCH" };
  }
  const competitor = findCompetitorDomain(candidate.link);
  if (competitor) {
    return { pass: false, reason: `COMPETITOR_DOMAIN:${competitor}` };
  }
  if (alreadyPostedRecently(candidate, postedLog, 24 * 14)) {
    return { pass: false, reason: "ALREADY_POSTED" };
  }
  if (duplicateLinkRecently(candidate, postedLog, 24)) {
    return { pass: false, reason: "DUPLICATE_LINK_24H" };
  }
  if (isMassDuplicateThisRun(candidate, seenThisRun)) {
    return { pass: false, reason: "MASS_DUPLICATE_THIS_RUN" };
  }
  return { pass: true, reason: null };
}
