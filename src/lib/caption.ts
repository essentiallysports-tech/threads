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
      : `Full story linked in the reply.`;

  return [part1, "", part2, "", part3].join("\n");
}

// Returns null (never throws) when the page has no registered UTM string —
// this is an expected, real business condition (confirmed live: p50 Bay Area
// Hoops genuinely has none registered), not an unexpected failure. Throwing
// here made Temporal retry the activity 3 times pointlessly and then crash
// the whole workflow run — confirmed live, caught and fixed same session.
// Never auto-generate a substitute UTM; the caller must drop the candidate.
export function buildReplyLink(candidate: Candidate, page: PageConfig): string | null {
  const utm = page.threads?.utm_string;
  if (!utm) return null;
  const contentTag = candidate.source === "beehiiv_newsletter" ? "&utm_content=reply_link" : "";
  const sep = candidate.link.includes("?") ? "&" : "?";
  return `${candidate.link}${sep}${utm}${contentTag}`;
}
