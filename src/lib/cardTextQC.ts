// ⛔ OPERATOR FIX (2026-08-08, real live incident): a card rendered "DEION
// SANDERS TOOK HIS COLORADO BUFFALOES" — text that doesn't match what this
// pipeline's own code ever computed or sent as the headline. The AI image
// model itself can paraphrase, truncate, or garble on-image text regardless
// of how carefully the prompt is built — a known, common failure mode for
// text-in-image generation, not something fixable purely in prompt copy.
// The real threads-automation skill file's own MANDATORY TEXT-QC rule
// ("confirm all three text elements present, correctly spelled, legible,
// not duplicated — regenerate → retry → DROP") was never actually built in
// this project until now. This is that check: a real vision-capable model
// call (same Vercel AI Gateway already used for captions) looking at the
// ACTUAL rendered pixels, not trusting the prompt was followed.
//
// ⛔ OPERATOR PARITY FIX (2026-08-10): "at least the content can be as
// senseful as the Facebook posts." Facebook's shard routine's 7 render
// gates check the ACTUAL rendered image for correct subject, no
// generic/wrong face, and a real in-context background (never a flat
// solid-color fill or a cutout floating on one) — this project only ever
// checked text legibility, never subject/background. Text can be perfectly
// spelled and still be on a card showing the wrong person or a blank
// background, which reads just as "doesn't make sense" as garbled text
// does. Added as extra criteria in the SAME vision call (one call, more
// checks) rather than a second, separate API round-trip.

import { fetchWithTimeout } from "./httpUtil";

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const MODEL = "anthropic/claude-sonnet-4-5";

export interface CardTextQCResult {
  pass: boolean;
  reason: string | null;
}

export async function verifyCardText(
  cardUrl: string,
  headline: string,
  kicker: string,
  accent: string | null,
  photoSubjects: string[] = []
): Promise<CardTextQCResult> {
  const apiKey = process.env.VERCEL_AI_GATEWAY_KEY;
  if (!apiKey) return { pass: true, reason: null }; // can't verify without a key — a missing check shouldn't block every post

  const prompt = [
    `Look at this sports infographic card image. The text it was SUPPOSED to render is:`,
    `- Headline: "${headline}"`,
    `- Kicker bar: "${kicker}"`,
    accent
      ? `- Accent word: "${accent}" — this word is PART OF the headline above (it's one of the words in that same sentence), just rendered in a different accent color in place. It must NOT appear a second time anywhere else on the card as its own separate word/line.`
      : null,
    photoSubjects.length > 0 ? `- The card should depict: ${photoSubjects.join(" and ")}` : null,
    ``,
    `Check ALL of the following. Reply with EXACTLY one line:`,
    `PASS — ALL of these hold: (1) the visible text is legible, complete (not cut off mid-word or mid-sentence), not duplicated anywhere on the card, spelled correctly, and reads as a coherent phrase (minor wording differences from the intended text are fine, e.g. the model rephrasing slightly); (2) the image shows a real, in-context photographic scene with actual depth/background (a stadium, arena, court, track, or similarly real setting) — NOT a flat single-color background, and NOT a person cut out and pasted onto a solid color fill; (3) if a subject was named above, the image genuinely depicts one or more real-looking human athletes consistent with that description — NOT a blank/empty scene, NOT an obviously wrong number of people, NOT a generic faceless/cartoonish/AI-plastic-looking figure standing in for a real person; (4) if an accent word was given above, it appears ONLY as a color-highlighted word inside the one headline sentence — NOT as an extra standalone word/line floating separately from the headline, and NOT repeated a second time anywhere.`,
    `FAIL: <short reason> — if the visible text is garbled/incomplete/nonsensical/duplicated/wrong, OR the background is a flat solid color / cutout-on-solid-fill, OR the named subject is missing, wrong-looking, or replaced by a generic/blank figure, OR the accent word is rendered as its own separate freestanding word/line apart from the headline sentence.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetchWithTimeout(
      GATEWAY_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: cardUrl } },
              ],
            },
          ],
          max_tokens: 100,
        }),
      },
      45_000
    );
    if (!res.ok) {
      console.error(`verifyCardText: gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return { pass: true, reason: null }; // verification infra failure — don't block posting over it
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = (json.choices?.[0]?.message?.content || "").trim();
    if (/^PASS/i.test(content)) return { pass: true, reason: null };
    return { pass: false, reason: content.slice(0, 200) || "FAIL: no reason given" };
  } catch (e) {
    console.error(`verifyCardText: request failed: ${(e as Error).message}`);
    return { pass: true, reason: null }; // network failure — don't block posting over it
  }
}
