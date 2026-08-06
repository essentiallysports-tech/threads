// Direct/embedded Gemini image generation — the render path for this system.
// Chosen specifically because OpenArt has NO self-serve REST API key feature
// (confirmed by the user 2026-08-06: "OPENART DOESNT HAVE API KEY FEATURE
// WE WOULD SOMEHOW NEED TO USE MCP ONLY") and MCP connectors are only
// reachable from inside an authenticated Claude agent session — never from a
// standalone Node/Temporal worker process with no session context. This
// endpoint is a genuine REST API, callable from anywhere with just an HTTP
// call, which is what full determinism requires here. Same embedded key
// already documented as a working last-resort fallback in the old ES
// Facebook skill file (render_fallback_chain), reused here as the PRIMARY
// path since this service has no Beehiiv-Gemini-primary / Postiz-quota
// layer in front of it.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent";

export interface CardTextSlots {
  kicker?: string; // small label above the headline, e.g. sport/entity name
  headline: string; // the main on-image text — never dropped
  accent?: string; // short supporting line, e.g. a stat or quote fragment
}

// Builds the image-generation prompt. Hard requirement enforced in the
// prompt text itself (not just a passive hope): NO logos/watermarks of any
// kind, but the headline/kicker/accent text must be legibly rendered ON the
// image — this is the exact split the user specified ("No logos,but text to
// be there on infographic").
function buildPrompt(slots: CardTextSlots, pageTheme: string): string {
  const lines = [
    `Design a bold sports-news social media infographic card for a "${pageTheme}" themed page.`,
    slots.kicker ? `Small kicker label at the top: "${slots.kicker}".` : null,
    `Large, highly legible main headline text on the image: "${slots.headline}".`,
    slots.accent ? `A short supporting accent line: "${slots.accent}".` : null,
    "Sports-photography-style background relevant to the headline, high contrast typography, professional editorial sports-media layout.",
    "STRICT: absolutely no logos, watermarks, brand marks, or text attributing any organization anywhere on the image — only the headline/kicker/accent text specified above.",
  ].filter(Boolean);
  return lines.join(" ");
}

export async function generateCardImage(slots: CardTextSlots, pageTheme: string): Promise<Buffer> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set — required for the direct-Gemini render fallback");
  const res = await fetch(`${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(slots, pageTheme) }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });

  if (!res.ok) throw new Error(`Gemini image generation -> ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
  };
  const b64 = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
  if (!b64) throw new Error("Gemini image generation returned no inline image data");
  return Buffer.from(b64, "base64");
}
