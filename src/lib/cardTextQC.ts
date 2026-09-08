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
import { isDailyBudgetExceeded, recordGatewaySpend } from "./aiGatewayBudget";

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const MODEL = "anthropic/claude-haiku-4-5";

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
  if (await isDailyBudgetExceeded()) return { pass: true, reason: null }; // over today's soft AI-gateway budget — see aiGatewayBudget.ts

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
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { cost?: number } };
    recordGatewaySpend(json.usage?.cost);
    const content = (json.choices?.[0]?.message?.content || "").trim();
    if (/^PASS/i.test(content)) return { pass: true, reason: null };
    return { pass: false, reason: content.slice(0, 200) || "FAIL: no reason given" };
  } catch (e) {
    console.error(`verifyCardText: request failed: ${(e as Error).message}`);
    return { pass: true, reason: null }; // network failure — don't block posting over it
  }
}

// ⛔ OPERATOR FIX (2026-09-08, real live incident, user-reported "half of
// the images are absurd"): a Kobe Bryant story rendered with a source
// photo of two unrelated men in suits walking past barricades — plausibly
// an old memorial/press-event wire photo whose caption happened to mention
// "Kobe Bryant" for some unrelated reason. Root cause traced to
// esDirect.ts's metadataMatchesSubject: the ONLY subject-correctness check
// in this pipeline is "does the candidate's title+caption TEXT contain the
// searched name" — pure substring matching, zero verification the photo's
// actual pixels depict that person. This gap became load-bearing on
// 2026-08-29 when Cloudinary's face-detection-based rejection was removed
// from the render path (see activities/index.ts's own comment on that
// change) — before that, a wrong-subject photo had a second, independent
// filter; after it, a caption coincidence sails straight through to
// OpenArt, which is explicitly instructed to preserve the reference photo
// "as-is." This is a REAL vision check on the CANDIDATE photo itself,
// before it's ever accepted as reference_photo_url — same gateway/model as
// verifyCardText above, one more call in the same family, not a new
// dependency. Deliberately narrow ("could plausibly be this person," not a
// strict face-match the model can't reliably do either) — the goal is
// catching the "obviously unrelated scene" failure this incident is,  not
// building unreliable facial recognition.
const PHOTO_SUBJECT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const photoSubjectCache = new Map<string, { at: number; value: Promise<boolean> }>();

export async function verifyPhotoSubject(imageUrl: string, subjectName: string): Promise<boolean> {
  const cacheKey = `${imageUrl}::${subjectName.toLowerCase()}`;
  const hit = photoSubjectCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PHOTO_SUBJECT_CACHE_TTL_MS) return hit.value;

  const value = verifyPhotoSubjectUncached(imageUrl, subjectName);
  photoSubjectCache.set(cacheKey, { at: Date.now(), value });
  value.catch(() => {
    const current = photoSubjectCache.get(cacheKey);
    if (current && current.value === value) photoSubjectCache.delete(cacheKey);
  });
  return value;
}

async function verifyPhotoSubjectUncached(imageUrl: string, subjectName: string): Promise<boolean> {
  const apiKey = process.env.VERCEL_AI_GATEWAY_KEY;
  if (!apiKey) return true; // can't verify without a key — a missing check shouldn't block every post, matches verifyCardText's own policy
  if (await isDailyBudgetExceeded()) return true; // over today's soft AI-gateway budget — see aiGatewayBudget.ts

  const prompt = [
    `This photo was found by searching a sports media library for "${subjectName}".`,
    `Look at it and answer: does it actually, plausibly depict ${subjectName} — a recognizable photo of them (portrait, action shot, court/field/press-conference appearance), or clearly their jersey/memorabilia in a relevant context?`,
    `Reply FAIL if it instead shows unrelated people, a generic crowd/press/memorial scene with no clear visual connection to ${subjectName}, or anything else that just happens to be captioned with this name without the photo actually being "about" them.`,
    `Reply with EXACTLY one line: "PASS" or "FAIL: <short reason>". When genuinely uncertain, answer PASS — this check exists to catch obviously wrong/unrelated photos, not to make a strict facial-identity call you can't reliably make.`,
  ].join("\n");

  try {
    const res = await fetchWithTimeout(
      GATEWAY_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageUrl } }] }],
          max_tokens: 60,
        }),
      },
      20_000
    );
    if (!res.ok) {
      console.error(`verifyPhotoSubject: gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return true; // verification infra failure — don't block posting over it
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { cost?: number } };
    recordGatewaySpend(json.usage?.cost);
    const content = (json.choices?.[0]?.message?.content || "").trim();
    return /^PASS/i.test(content);
  } catch (e) {
    console.error(`verifyPhotoSubject: request failed: ${(e as Error).message}`);
    return true; // network failure — don't block posting over it
  }
}

// ⛔ OPERATOR FIX (2026-09-08, comprehensive audit): the generic/logo
// fallback path (renderCard, when searchTerms is empty — no real depictable
// person for this story) called pickReachableUrl with no verifySubject
// callback at all, unlike searchAndPick's normal path just above — the one
// content category with zero visual verification. Can't reuse
// verifyPhotoSubject as-is: its prompt is written entirely for "is this a
// recognizable photo of a PERSON," which would ~always FAIL a genuine team/
// league logo (correctly rejecting itself). Separate prompt, same fail-open
// policy and caching shape.
const genericPhotoSubjectCache = new Map<string, { at: number; value: Promise<boolean> }>();

export async function verifyGenericPhotoSubject(imageUrl: string, subjectName: string): Promise<boolean> {
  const cacheKey = `${imageUrl}::${subjectName.toLowerCase()}`;
  const hit = genericPhotoSubjectCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PHOTO_SUBJECT_CACHE_TTL_MS) return hit.value;

  const value = verifyGenericPhotoSubjectUncached(imageUrl, subjectName);
  genericPhotoSubjectCache.set(cacheKey, { at: Date.now(), value });
  value.catch(() => {
    const current = genericPhotoSubjectCache.get(cacheKey);
    if (current && current.value === value) genericPhotoSubjectCache.delete(cacheKey);
  });
  return value;
}

async function verifyGenericPhotoSubjectUncached(imageUrl: string, subjectName: string): Promise<boolean> {
  const apiKey = process.env.VERCEL_AI_GATEWAY_KEY;
  if (!apiKey) return true; // can't verify without a key — a missing check shouldn't block every post, matches verifyCardText's own policy
  if (await isDailyBudgetExceeded()) return true; // over today's soft AI-gateway budget — see aiGatewayBudget.ts

  const prompt = [
    `This photo was found by searching a sports media library for "${subjectName} logo".`,
    `Look at it and answer: does it actually, plausibly show a genuine logo, crest, uniform/jersey, mascot, or venue associated with "${subjectName}" — generic sport/team imagery, NOT a photo of a specific identifiable person?`,
    `Reply FAIL if it instead shows a different team/league's logo or branding, an unrelated scene, or anything else that just happens to be captioned with this name without actually depicting it.`,
    `Reply with EXACTLY one line: "PASS" or "FAIL: <short reason>". When genuinely uncertain, answer PASS — this check exists to catch obviously wrong/mismatched logos or imagery, not to make a strict call you can't reliably make.`,
  ].join("\n");

  try {
    const res = await fetchWithTimeout(
      GATEWAY_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageUrl } }] }],
          max_tokens: 60,
        }),
      },
      20_000
    );
    if (!res.ok) {
      console.error(`verifyGenericPhotoSubject: gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return true; // verification infra failure — don't block posting over it
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { cost?: number } };
    recordGatewaySpend(json.usage?.cost);
    const content = (json.choices?.[0]?.message?.content || "").trim();
    return /^PASS/i.test(content);
  } catch (e) {
    console.error(`verifyGenericPhotoSubject: request failed: ${(e as Error).message}`);
    return true; // network failure — don't block posting over it
  }
}
