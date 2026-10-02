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

import { isDailyBudgetExceeded } from "./aiGatewayBudget";
import { callModel, aiConfigured } from "./aiClient";

// ⛔ OPERATOR FIX (2026-09-12, real live incident): the 2026-09-08 fleet-wide
// Haiku switch was never validated against production output before
// shipping — entityResolution.ts's and checks.ts's matching comments
// document the same switch tanking real autopost volume (9,896 -> 484
// sessions Sep8-10) on other judgment-gate calls, both since reverted to
// Sonnet. This file's three vision-judgment calls (text/subject/background
// QC, the actual photo-subject match, and the generic-logo match) are the
// same class of call — a real pass/fail judgment gating whether a card
// ships at all, not a cheap formatting task — so they get the same fix.
// Daily AI Gateway spend was $3.20-7.01 against the $12 soft cap / real $13
// hard cap the days around this fix, full headroom for Sonnet's ~3x cost.
// (2026-10-01: the model is now picked in aiClient.ts — still Sonnet 4.5.)

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
  if (!aiConfigured()) return { pass: true, reason: null }; // can't verify without a key — a missing check shouldn't block every post
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
    const content = (
      await callModel({ tag: "card_text_qc", model: "sonnet", content: [{ type: "text", text: prompt }, { type: "image", url: cardUrl }], maxTokens: 100, timeoutMs: 45_000 })
    ).trim();
    if (/^PASS/i.test(content)) return { pass: true, reason: null };
    return { pass: false, reason: content.slice(0, 200) || "FAIL: no reason given" };
  } catch (e) {
    console.error(`verifyCardText: request failed: ${(e as Error).message}`);
    return { pass: true, reason: null }; // verification infra failure — don't block posting over it
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

export async function verifyPhotoSubject(imageUrl: string, subjectName: string, caption?: string): Promise<boolean> {
  const cacheKey = `${imageUrl}::${subjectName.toLowerCase()}`;
  const hit = photoSubjectCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PHOTO_SUBJECT_CACHE_TTL_MS) return hit.value;

  const value = verifyPhotoSubjectUncached(imageUrl, subjectName, caption);
  photoSubjectCache.set(cacheKey, { at: Date.now(), value });
  value.catch(() => {
    const current = photoSubjectCache.get(cacheKey);
    if (current && current.value === value) photoSubjectCache.delete(cacheKey);
  });
  return value;
}

// ⛔ OPERATOR FIX (2026-10-02, real live incidents, team-reported twice):
// two Alex Eala Fan Club cards showed other players. (1) The reference was a
// doubles photo — caption "USA's Iva Jovic and Philippines' Alexandra Eala
// during the doubles…" — which passed every check because Eala really is in
// it; the image model then turned a two-person photo into a one-person card
// and kept Jovic. (2) The reference was captioned "Alycia Parks … celebrates
// her victory over Alexandra Eala" and went out while this check was failing
// open on an exhausted AI budget. So this check no longer asks one vague
// "plausibly them?" question with a PASS-when-unsure default. It asks for
// facts as JSON, and the code decides:
//   - a person's card needs a photo with exactly ONE person in focus;
//   - when there's a caption, the first person it names as pictured must be
//     the subject (agency captions name the pictured person first);
//   - with no caption, "unsure" is a FAIL — the model can't identify people
//     by face, so nothing else can vouch for who it is;
//   - teams/organisations skip the one-person rule (team photos show several
//     players);
//   - and it fails CLOSED: no AI, no budget, an error or an unreadable answer
//     all mean "don't use this photo". Posting nothing beats the wrong player.
// The earlier intimate-contact (2026-09-09, Stafford) and vehicle-dominant
// (2026-09-14, NASCAR) rules are kept as their own fields below.
function surnameOf(name: string): string {
  const parts = name.toLowerCase().replace(/[^a-z\s'-]/g, " ").split(/\s+/).filter((t) => t.length >= 2);
  return parts[parts.length - 1] || name.toLowerCase();
}

interface PhotoSubjectFacts {
  subject_is_team?: boolean;
  people_in_focus?: number;
  caption_names_pictured?: string[];
  depicts_subject?: "yes" | "no" | "unsure";
  intimate_contact?: boolean;
  vehicle_dominant?: boolean;
}

export function decidePhotoSubject(facts: PhotoSubjectFacts, subjectName: string, hasCaption: boolean): { pass: boolean; reason: string } {
  if (facts.intimate_contact) return { pass: false, reason: "intimate contact" };
  if (facts.vehicle_dominant) return { pass: false, reason: "vehicle, not the person, is the subject" };
  if (facts.depicts_subject === "no") return { pass: false, reason: "does not depict the subject" };
  if (facts.subject_is_team) return { pass: true, reason: "team photo" };
  const people = typeof facts.people_in_focus === "number" ? facts.people_in_focus : NaN;
  if (people !== 1) return { pass: false, reason: `${Number.isNaN(people) ? "unknown" : people} people in focus — a one-person card needs one` };
  const named = (facts.caption_names_pictured || []).filter((n) => typeof n === "string" && n.trim());
  const surname = surnameOf(subjectName);
  if (hasCaption && named.length > 0 && !named[0].toLowerCase().includes(surname)) return { pass: false, reason: `caption names ${named[0]} as pictured first` };
  if (hasCaption && named.length > 0) return { pass: true, reason: "caption names the subject first" };
  if (facts.depicts_subject === "yes") return { pass: true, reason: hasCaption ? "caption names no one; photo depicts the subject" : "no caption; photo depicts the subject" };
  return { pass: false, reason: "can't confirm it's the subject" };
}

async function verifyPhotoSubjectUncached(imageUrl: string, subjectName: string, caption?: string): Promise<boolean> {
  if (!aiConfigured()) return false; // fail closed — see the 2026-10-02 comment above
  if (await isDailyBudgetExceeded()) return false; // fail closed — see the 2026-10-02 comment above

  const hasCaption = !!caption && caption.trim().length > 0;
  const prompt = [
    `This photo was found by searching a sports media library for "${subjectName}". It will be the reference image for a card about ${subjectName}.`,
    hasCaption ? `The library's metadata for this photo (title | caption | alt text) reads: "${caption!.slice(0, 600)}". Agency captions name the pictured person first.` : `The photo has no caption in the library.`,
    `Answer with facts about the photo as one JSON object, nothing else:`,
    `{`,
    `  "subject_is_team": true if "${subjectName}" is a team, club, league or organization rather than one individual person, else false,`,
    `  "people_in_focus": the number of people who are clear main subjects of the photo — count every player/person in sharp focus in the foreground; do NOT count blurred background crowds, spectators, officials or ball kids,`,
    `  "caption_names_pictured": ${hasCaption ? `the names of the people the caption says are pictured, in the order the caption names them (e.g. "A and B during the doubles" -> ["A", "B"]; "A celebrates her victory over B" -> ["A"]); [] if it names no one as pictured` : `[]`},`,
    `  "depicts_subject": "yes" if the photo plausibly shows ${subjectName} (a person: them; a team: its players, jersey or branding in a relevant context), "no" if it clearly shows something unrelated (unrelated people, a generic crowd/press/memorial scene, a different team), "unsure" otherwise — you cannot identify real people by their face, so without a caption naming them say "unsure" unless the photo itself makes it unambiguous (e.g. their name or number clearly visible),`,
    `  "intimate_contact": true if the photo shows kissing, making out or other intimate/romantic physical contact (normal athletic contact — hugs, high-fives, team celebrations, handshakes — is false),`,
    `  "vehicle_dominant": true if a car/vehicle, not a person, is the photo's dominant subject and ${subjectName} isn't plainly visible as a person in it`,
    `}`,
  ].join("\n");

  try {
    const content = await callModel({ tag: "photo_verify", model: "sonnet", content: [{ type: "text", text: prompt }, { type: "image", url: imageUrl }], maxTokens: 200, timeoutMs: 20_000 });
    const json = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    const facts = JSON.parse(json.slice(json.indexOf("{"), json.lastIndexOf("}") + 1)) as PhotoSubjectFacts;
    const decision = decidePhotoSubject(facts, subjectName, hasCaption);
    if (!decision.pass) console.error(`verifyPhotoSubject: FAIL "${subjectName}" (${decision.reason}) ${imageUrl.slice(-80)}`);
    return decision.pass;
  } catch (e) {
    console.error(`verifyPhotoSubject: check failed, rejecting the photo: ${(e as Error).message}`);
    return false; // fail closed — see the 2026-10-02 comment above
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
  if (!aiConfigured()) return true; // can't verify without a key — a missing check shouldn't block every post, matches verifyCardText's own policy
  if (await isDailyBudgetExceeded()) return true; // over today's soft AI-gateway budget — see aiGatewayBudget.ts

  const prompt = [
    `This photo was found by searching a sports media library for "${subjectName} logo".`,
    `Look at it and answer: does it actually, plausibly show a genuine logo, crest, uniform/jersey, mascot, or venue associated with "${subjectName}" — generic sport/team imagery, NOT a photo of a specific identifiable person?`,
    `Reply FAIL if it instead shows a different team/league's logo or branding, an unrelated scene, or anything else that just happens to be captioned with this name without actually depicting it.`,
    `Reply with EXACTLY one line: "PASS" or "FAIL: <short reason>". When genuinely uncertain, answer PASS — this check exists to catch obviously wrong/mismatched logos or imagery, not to make a strict call you can't reliably make.`,
  ].join("\n");

  try {
    const content = (
      await callModel({ tag: "generic_photo_verify", model: "sonnet", content: [{ type: "text", text: prompt }, { type: "image", url: imageUrl }], maxTokens: 60, timeoutMs: 20_000 })
    ).trim();
    return /^PASS/i.test(content);
  } catch (e) {
    console.error(`verifyGenericPhotoSubject: request failed: ${(e as Error).message}`);
    return true; // verification infra failure — don't block posting over it
  }
}
