// Real narrative caption generation — a genuine Claude call via the Vercel AI
// Gateway (Anthropic under the hood), per the operator's explicit 2026-08-07
// instruction: "texts work a lot on Threads... captions should be descriptive
// and cause intrigue, not random 3-4 lines just giving the same info as the
// infographic. Captions should narrate the story." Deterministic templating
// (caption.ts's buildCaption) cannot produce real narrative prose — this is
// exactly the "separate activity whose OUTPUT still passes through checks"
// caption.ts's own header comment already anticipated. The LLM call NEVER
// posts directly; buildNarrativeCaptionText validates the result below and
// falls back to the deterministic template on any failure or violation —
// never trusted blindly, never blocks a post over caption-generation issues.

import { Candidate, PageConfig } from "./types";
import { buildCaption } from "./caption";

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const MODEL = "anthropic/claude-sonnet-4-5";

// Explicit engagement-bait ban — Meta/Threads demonetize this pattern, and
// it's a standing operator policy across every ES page, not specific to this
// pipeline. Genuine, specific questions tied to the real story are fine;
// generic "smash that like" style asks are not.
const ENGAGEMENT_BAIT_PATTERNS = [
  /\blike\s+(this|below|if)\b/i,
  /\bcomment\s+(below|your|if)\b/i,
  /\bshare\s+(this|with)\b/i,
  /\btag\s+(a|someone|your)\b/i,
  /\bdouble\s+tap\b/i,
  /\bsmash\s+that\b/i,
  /\breact\s+(with|below)\b/i,
  /\bfollow\s+for\s+more\b/i,
];

const REFUSAL_PATTERNS = [/^i\s+(cannot|can't|won't)\b/i, /\bas an ai\b/i, /\bi'm not able to\b/i];

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function stripWrappingQuotesAndMarkdown(text: string): string {
  let t = text.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t.replace(/\*\*/g, "").replace(/^#+\s*/gm, "");
}

function violatesPolicy(text: string, charLimit: number): string | null {
  if (!text.trim()) return "EMPTY";
  if (text.length > charLimit) return `OVER_CHAR_LIMIT:${text.length}/${charLimit}`;
  if (REFUSAL_PATTERNS.some((re) => re.test(text))) return "MODEL_REFUSAL";
  const bait = ENGAGEMENT_BAIT_PATTERNS.find((re) => re.test(text));
  if (bait) return `ENGAGEMENT_BAIT:${bait.source}`;
  return null;
}

async function callGateway(prompt: string, apiKey: string): Promise<string> {
  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 400,
      temperature: 0.8,
    }),
  });
  if (!res.ok) throw new Error(`AI gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`AI gateway returned no text content: ${JSON.stringify(json).slice(0, 300)}`);
  return stripWrappingQuotesAndMarkdown(content);
}

function buildPrompt(candidate: Candidate, page: PageConfig, athleteNames: string[], charLimit: number, retryNote?: string): string {
  const voice = page.threads?.caption_voice_mode || "fan";
  const voiceInstruction =
    voice === "brand"
      ? "an editorial sports outlet's account — confident, informed, slightly detached"
      : "a genuinely obsessed fan account for this team/sport — casual, opinionated, in the trenches with the fanbase";
  // ⛔ LEARNING PORTED (2026-08-08, ES_Threads_Automation_Playbook.md Section
  // 7): "Replies are the most powerful ranking signal — every caption must
  // force a reply." Section 6 splits this by voice: the brand account (ES
  // Main) closes on a genuine DEBATE QUESTION that forces a reader to pick a
  // side; fan accounts close on a strong DECLARATIVE "stand" — a real
  // opinion, not a question ("This dude is built different fr 🔥", not "Do
  // you think he's good?"). Applied here across every page via the existing
  // caption_voice_mode field, not just the accounts the old routine covered.
  const replyForcingInstruction =
    voice === "brand"
      ? `must end on a genuine DEBATE QUESTION that forces the reader to take a side — a real, specific question tied to this exact story, never a generic "thoughts?"`
      : `must end on a strong DECLARATIVE TAKE, not a question — a real opinion stated as fact, in this account's own voice, that a reader will want to argue with or co-sign in the replies`;

  const facts = [
    `Headline: ${stripHtml(candidate.headline)}`,
    candidate.rawText ? `Additional detail: ${stripHtml(candidate.rawText)}` : null,
    athleteNames.length > 0 ? `Key people/teams involved: ${athleteNames.join(", ")}` : null,
    `Source: ${
      candidate.source === "beehiiv_newsletter"
        ? "our own newsletter"
        : candidate.source === "es_article"
        ? "our own published article"
        : candidate.source === "web_search"
        ? "a real news article found via search"
        : candidate.source === "social_search"
        ? "a real social media post (Reddit/X) found via search"
        : candidate.source === "evergreen_search"
        ? "a real news article found via search"
        : "a news story"
    }`,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    `Write a Threads post (the main post, not the reply) for a sports fan page, voiced as ${voiceInstruction}.`,
    ``,
    `Here are the ONLY facts you know about this story — do not invent any detail, quote, number, or context beyond what's given:`,
    facts,
    ``,
    `Structure it in FOUR moves, same discipline as EssentiallySports's caption architecture:`,
    ``,
    `1. HOOK (1 line) — must emotionally charge or surprise the reader. This must be a DIFFERENT angle than the headline, never a rephrasing of it — if the hook and the headline say the same thing, the reader has no reason to keep reading. Examples of the right register: "No one expected her to say that in front of the cameras." / "Just hours after it happened, he did something that left people speechless." Lead with the emotion/stakes, not a label.`,
    `2. THE STORY (2 short paragraphs, conversational, NOT a copied or lightly-reworded headline) — narrate what actually happened using ONLY the given facts, cutting filler, highlighting the human stakes. First paragraph: the core of what happened. Second paragraph: why it matters / the real context or consequence. Write it the way you'd tell a friend, not like a blog intro. This is the substance of the post — go deeper than a one-line summary, using everything genuinely available in the given facts.`,
    `3. CLIFFHANGER + REPLY HOOK (1-2 lines) — tease the part of the story you're deliberately NOT explaining, so there's a real reason to tap through, THEN ${replyForcingInstruction}. Give nothing away in the tease itself. Examples of the right register for the tease: "But what happened next is the part that changed everything." / "And there's one detail here most people are going to miss."`,
    candidate.linkContext === "subscribe"
      ? `4. CTA (1 short line) — the link in the reply is NOT this specific story, it's our newsletter — do not claim "full story in the reply" or imply the reply covers this exact story, that would be misleading. Instead frame it as "want more like this? subscribe below" in your own words, genuinely tied to the story's topic.`
      : `4. CTA (1 short line) — point at the link in the reply below, tied to what's specifically waiting there. E.g. "(Full story in the reply below)" style, adapted to fit naturally after the cliffhanger.`,
    ``,
    `Formatting: aim for roughly 6-7 lines total across these four moves (a real, substantive post, not a 3-line skeleton) — but NEVER pad with filler or repeat yourself just to hit a line count. If the given facts genuinely don't support that much substance, a shorter, honest post beats a padded one. The ${charLimit}-character hard limit below is non-negotiable and takes priority over hitting 6-7 lines — write tighter sentences rather than overflow it; a well-edited 5-line post beats a 7-line post that gets discarded for going over.`,
    `Use short paragraphs with a blank line between each of the four moves — never one dense wall of text.`,
    `- Do NOT ask people to like, comment, share, tag someone, double-tap, or react — that's banned engagement-bait, not a genuine hook.`,
    `- Never invent a detail, quote, or number not in the facts above just to make the post feel more substantive — a true, well-chosen detail from the real facts beats a fabricated dramatic one.`,
    `- Never reveal in the CTA/cliffhanger something you already fully explained in move 2 — the whole point is an open loop, not a redundant recap.`,
    `- Plain text only. No markdown, no hashtags, no emoji spam (one or two is fine if it fits the voice).`,
    `- Hard limit: ${charLimit} characters total, including spaces — use as much of that space as the real facts support.`,
    retryNote ? `\nIMPORTANT — your previous attempt failed because: ${retryNote}. Fix that specifically.` : "",
    ``,
    `Output ONLY the caption text, nothing else — no preamble, no explanation.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface NarrativeCaptionResult {
  text: string;
  usedFallback: boolean;
  violation?: string;
}

// Falls back to the deterministic template (never throws, never blocks a
// post) on: missing API key, any gateway/network error, or the model's
// output failing policy checks twice in a row.
export async function buildNarrativeCaptionText(
  candidate: Candidate,
  page: PageConfig,
  athleteNames: string[]
): Promise<NarrativeCaptionResult> {
  const apiKey = process.env.VERCEL_AI_GATEWAY_KEY;
  const charLimit = page.threads?.char_limit || 500;
  const fallback = buildCaption(candidate, page);

  if (!apiKey) return { text: fallback, usedFallback: true, violation: "NO_API_KEY" };

  let retryNote: string | undefined;
  let lastOverLimitText: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const prompt = buildPrompt(candidate, page, athleteNames, charLimit, retryNote);
      const text = await callGateway(prompt, apiKey);
      const violation = violatesPolicy(text, charLimit);
      if (!violation) return { text, usedFallback: false };
      if (violation.startsWith("OVER_CHAR_LIMIT")) lastOverLimitText = text;
      retryNote =
        violation.startsWith("OVER_CHAR_LIMIT")
          ? `your last attempt was ${violation.split(":")[1]} characters, ${text.length - charLimit} OVER the ${charLimit} limit — cut a full sentence or trim the story section, don't just shorten word choices`
          : `your last attempt violated: ${violation} — fix that specifically`;
      console.error(`buildNarrativeCaptionText: attempt ${attempt + 1} violated policy (${violation}) for ${page.page_id}`);
    } catch (e) {
      console.error(`buildNarrativeCaptionText: attempt ${attempt + 1} failed for ${page.page_id}: ${(e as Error).message}`);
    }
  }

  // ⛔ OPERATOR FIX (2026-08-07): the model overshot the limit on every one
  // of 3 attempts on real live pages (p45, p47) despite exact-overage retry
  // feedback — discarding the whole narrative caption for the old generic
  // template every time it runs a little long throws away real quality for
  // a fixable formatting problem. One last deterministic trim: real
  // narrative content beats a templated fallback, as long as trimming can
  // still produce a genuinely coherent, non-truncated-mid-sentence result.
  if (lastOverLimitText) {
    const trimmed = trimToFit(lastOverLimitText, charLimit);
    if (trimmed) return { text: trimmed, usedFallback: false, violation: "TRIMMED_AFTER_RETRY" };
  }

  return { text: fallback, usedFallback: true, violation: "FAILED_AFTER_RETRY" };
}

// Preserves the CTA line (always the last non-empty paragraph) and trims
// preceding paragraphs to the last complete sentence that fits — never
// cuts mid-sentence, matching the same completeness rule as extractQuotedPhrase
// in activities/index.ts. Returns null if even the CTA alone can't fit
// (pathological case — let the caller fall back to the template).
function trimToFit(text: string, charLimit: number): string | null {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  if (paragraphs.length === 0) return null;
  const cta = paragraphs[paragraphs.length - 1];
  const body = paragraphs.slice(0, -1);
  const budgetForBody = charLimit - cta.length - 2; // 2 chars for the blank-line separator
  if (budgetForBody <= 0) return null;

  const kept: string[] = [];
  let used = 0;
  for (const para of body) {
    const remaining = budgetForBody - used - (kept.length > 0 ? 2 : 0);
    if (remaining <= 0) break;
    if (para.length <= remaining) {
      kept.push(para);
      used += para.length + (kept.length > 1 ? 2 : 0);
      continue;
    }
    // Doesn't fully fit — cut this paragraph at the last complete sentence
    // that does, then stop (never include a further, even-shorter paragraph
    // after truncating one, to avoid a disjointed result).
    const sentenceEnd = /[.!?]\s/g;
    let lastGoodCut = -1;
    let m: RegExpExecArray | null;
    while ((m = sentenceEnd.exec(para))) {
      if (m.index + 1 <= remaining) lastGoodCut = m.index + 1;
      else break;
    }
    if (lastGoodCut > 0) kept.push(para.slice(0, lastGoodCut).trim());
    break;
  }
  if (kept.length === 0) return null;
  return [...kept, cta].join("\n\n");
}
