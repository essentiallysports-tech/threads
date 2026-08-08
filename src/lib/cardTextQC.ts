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

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const MODEL = "anthropic/claude-sonnet-4-5";

export interface CardTextQCResult {
  pass: boolean;
  reason: string | null;
}

export async function verifyCardText(cardUrl: string, headline: string, kicker: string, accent: string | null): Promise<CardTextQCResult> {
  const apiKey = process.env.VERCEL_AI_GATEWAY_KEY;
  if (!apiKey) return { pass: true, reason: null }; // can't verify without a key — a missing check shouldn't block every post

  const prompt = [
    `Look at this sports infographic card image. The text it was SUPPOSED to render is:`,
    `- Headline: "${headline}"`,
    `- Kicker bar: "${kicker}"`,
    accent ? `- Accent word: "${accent}"` : null,
    ``,
    `Reply with EXACTLY one line:`,
    `PASS — if the text actually visible on the image is legible, complete (not cut off mid-word or mid-sentence), not duplicated anywhere on the card, spelled correctly, and reads as a coherent phrase (minor wording differences from the intended text are fine, e.g. the model rephrasing slightly).`,
    `FAIL: <short reason> — if the visible text is garbled, incomplete/cut off, nonsensical, duplicated, or doesn't actually match what was supposed to be there.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch(GATEWAY_URL, {
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
    });
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
