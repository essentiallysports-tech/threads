import { Candidate, PageConfig } from "./types";

// Deterministic caption templating — no LLM call in this path. Real editorial
// craft (the actual English writing) is admittedly more fixed/formulaic than
// the old skill file's model-authored captions; that trade is *why* this is
// deterministic instead of a plausible imitation of an editor. If you want
// AI-authored copy back later, the correct way to add it is a SEPARATE
// activity (e.g. a real Claude API call) whose OUTPUT still passes through
// runDeterministicChecks + these length/format rules before anything posts —
// never trusted blindly. See README "On captions."

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function buildCaption(candidate: Candidate, page: PageConfig): string {
  const voice = page.threads?.caption_voice_mode || "fan";
  const cleanHeadline = stripHtml(candidate.headline);

  // Part 1: the hook, from the real headline. Part 2: a genuine, non-bait
  // reply-forcing line — templated but tied to the actual subject, not a
  // generic filler phrase (the exact banned pattern the old skill file's
  // circuit breaker was built to catch: "HEADLINE / Your take? / newsletter").
  const part1 = cleanHeadline;
  const part2 =
    voice === "brand"
      ? `What's your read on this?`
      : `This is bigger than it looks 👀`;
  const part3 =
    candidate.source === "beehiiv_newsletter"
      ? `We go deeper on this in today's newsletter.`
      : candidate.linkContext === "subscribe"
      ? `Want more stories like this? Subscribe to our newsletter. Link's in the reply.`
      : `Full story linked in the reply.`;

  return [part1, "", part2, "", part3].join("\n");
}

// ⛔ LEARNING PORTED (2026-08-08, ES_Threads_Automation_Playbook.md Section 8
// "Hashtag & Topic Logic"): channel selection is scope-based — a team/player-
// specific story gets that entity's own hashtag, a league-wide story gets the
// league hashtag, a cross-sport/national story gets none. Every real page's
// registry entry already has `hashtag_logic: "write_then_delete"` and
// `topic_registration: true` set (confirmed live 2026-08-08) — the schema was
// always there, this is the first time it's actually used. Returns null when
// no real scope-appropriate hashtag applies (never fabricates a generic one).
export function buildTopicHashtag(matchedEntityNames: string[], sportGroup: string | null): string | null {
  if (matchedEntityNames.length > 0) {
    const tag = matchedEntityNames[0].replace(/[^a-zA-Z0-9]/g, "");
    if (tag) return `#${tag}`;
  }
  if (sportGroup) {
    const tag = sportGroup.replace(/[^a-zA-Z0-9]/g, "");
    if (tag) return `#${tag}`;
  }
  return null; // cross-sport/national story — no topic channel to register
}

// Returns null (never throws) when the page has no registered UTM string —
// this is an expected, real business condition (confirmed live: p50 Bay Area
// Hoops genuinely has none registered), not an unexpected failure. Throwing
// here made Temporal retry the activity 3 times pointlessly and then crash
// the whole workflow run — confirmed live, caught and fixed same session.
// Never auto-generate a substitute UTM; the caller must drop the candidate.
// ⛔ OPERATOR FIX (2026-08-12): "the same UTMs are being used for manual and
// autoposting both, so traffic from autoposts can't be tracked." page's own
// utm_string is a static, hand-set value — identical whether a human or
// this pipeline posts the link, so GA4 has no way to isolate autopost
// traffic. utm_term is unused anywhere else in this codebase, so it's a
// safe, dedicated slot for this signal — added on every link this
// function builds, never touching the page's own source/medium/campaign
// values (preserves any existing GA4 reports built on those).
// ⛔ OPERATOR FIX (2026-08-24, real live incident, audit-confirmed): this used
// to append our utm_string onto whatever query string candidate.link already
// had, with no check for pre-existing utm_source/utm_medium keys. Some
// es_article canonical URLs ARE themselves a Beehiiv post URL (e.g. niche
// single-team newsletters like Buckeye Daily) and already carry Beehiiv's own
// "?utm_source=buckeye-daily.beehiiv.com&utm_medium=referral&utm_campaign=..."
// — appending ours after that produced a URL with utm_source/utm_medium each
// appearing TWICE. Confirmed live on Ohio State Wireline and Colorado Prime
// Time posts: real readers were clicking through (large real `sessions`
// totals on the dashboard), but GA4 attributed the session to whichever
// duplicate key it read first — Beehiiv's own pre-existing "referral" tag,
// not ours — so this pipeline's own dashboard showed near-zero attributed
// clicks for real, working links. Stripping any tracking params the source
// URL already carries before appending ours makes our tag authoritative
// every time, regardless of what the link happened to arrive with.
function stripExistingTracking(url: string): string {
  try {
    const u = new URL(url);
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].forEach((k) => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return url; // malformed URL — leave it untouched, caller's own validation handles that case
  }
}

export function buildReplyLink(candidate: Candidate, page: PageConfig): string | null {
  const utm = page.threads?.utm_string;
  if (!utm) return null;
  const contentTag = candidate.source === "beehiiv_newsletter" || candidate.linkContext === "subscribe" ? "&utm_content=reply_link" : "";
  const cleanLink = stripExistingTracking(candidate.link);
  const sep = cleanLink.includes("?") ? "&" : "?";
  return `${cleanLink}${sep}${utm}${contentTag}&utm_term=autopost`;
}
