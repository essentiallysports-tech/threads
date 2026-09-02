// Render spec and prompt template — ported verbatim from the sibling
// es-automation-engine-backend repo's src/lib/render/spec.ts (its own
// tested implementation, "the threads templates" the operator meant, NOT
// an Orshot visual template). Deterministic by design: a template cannot
// accidentally emit a banned "no text overlays" instruction the way an
// LLM-written prompt once did there.
//
// The banned-phrase scan stays even though this template cannot produce
// those phrases — the sibling repo's own comment: the scan is mandated on
// every prompt regardless of origin.

export type TemplateId = "hero" | "standard_editorial" | "dramatic_news" | "comparison" | "quote" | "retro";

export type RenderSpec = {
  page_id: string;
  headline: string; // ≤6 words on-image headline
  accent: string | null; // one accent word — null when the headline has no genuine power word to highlight (never duplicate the kicker as a fake accent)
  kicker: string; // short kicker line
  story_type: string;
  // Which of the canonical templates (ES-Threads-Automation-Skill-v1.md's
  // "full canonical set") this card renders as — drives composition/framing
  // below. Distinct from story_type, which is just descriptive prose for the
  // prompt. Added 2026-08-07: every prior live card used the same "breaking"
  // layout regardless of story shape — this is the fix.
  layout: TemplateId;
  accent_hex: string;
  photo_subjects: string[]; // real person(s) the card must depict. Empty = typographic/scene-only.
  reference_photo_url: string | null;
  is_quote: boolean; // true for two-person exchange/rivalry quote cards
  quote_text: string | null;
  quote_attribution: string | null;
};

const BANNED_PROMPT_PHRASES = [/no\s+text(\s+overlays?)?/i, /no\s+watermarks?/i, /clean\s+photo\s+only/i, /without\s+(any\s+)?text/i, /text-?free/i];

export function promptViolations(prompt: string): string[] {
  return BANNED_PROMPT_PHRASES.filter((re) => re.test(prompt)).map((re) => String(re));
}

// ⛔ OPERATOR FIX (2026-08-12, real live incident): a page's own registered
// entity list had a slot named "PGA Tour, LPGA" with keywords ["golf",
// "pga tour", "pga", "lpga"] — a generic tour/league bucket registered as
// if it were a real athlete entity. "LPGA" contains "pga" as a literal
// substring, so a SINGLE mention of "LPGA" in a headline matched BOTH
// keywords — two "hits" from one real event, counted as two distinct
// people. That tripped the comparison/VS template and searched ES-MCP for
// photos of "lpga" and "pga", neither a real depictable person, which is
// why the same generic golfer stock photo landed on both sides of the
// card. Exported so checks.ts's matchedEntityNames can filter these out
// before they're ever treated as a real, distinct subject — tour/league
// names are legitimate for broad relevance matching (that's what they're
// FOR), never for "is this a two-person story" or "whose photo do I
// search for."
export const CATEGORY_PLACEHOLDERS = new Set([
  "nascar", "nfl", "nba", "mlb", "nhl", "ufc", "mma", "wnba", "f1", "golf",
  "tennis", "boxing", "pickleball", "football", "basketball", "baseball",
  "sports", "celebrities", "sports celebrities", "athletes", "legends",
  "pga", "lpga", "pga tour", "lpga tour", "atp", "wta", "atp tour", "wta tour",
]);

export function isCategoryPlaceholder(subject: string): boolean {
  return CATEGORY_PLACEHOLDERS.has(String(subject ?? "").trim().toLowerCase());
}

// ⛔ OPERATOR FIX (2026-08-11, real live incidents): "COACH: THAT'S WEILI'S
// BELT" / "CLAIMED" and "LAKERS FACE LUKA DONCIC EXIT WARNING" / "WARNING"
// both rendered the accent word as its own disconnected line, separate
// from (and in one case literally duplicating) the actual headline
// sentence. The user's framing: the power word must be ONE WORD FROM THE
// SENTENCE, highlighted in place — never written apart from it. Same
// word-presence check narrativeRenderSpec.ts's `violates()` now enforces
// on the AI-authored path; duplicated here (not imported, to avoid a
// circular dependency between the two files) so the deterministic path's
// spec is held to the identical standard before it ever reaches a prompt.
export function accentIsWordInHeadline(accent: string, headline: string): boolean {
  const words = headline.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
  return words.includes(accent.trim().toLowerCase());
}

export interface PromptOptions {
  nameRealPeople?: boolean;
  subjectFromReference?: boolean;
}

export function buildRenderPrompt(spec: RenderSpec, options: PromptOptions = {}): string {
  const lines: string[] = [];
  const fromReference = options.subjectFromReference === true;
  const nameRealPeople = options.nameRealPeople !== false && !fromReference;
  const namedSubjects = spec.photo_subjects.join(" and ");
  const describedSubjects = spec.photo_subjects.length > 1 ? `two professional athletes in this sport` : `a professional athlete in this sport`;
  const subjectPhrase = nameRealPeople ? namedSubjects : describedSubjects;

  if (spec.is_quote && spec.quote_text) {
    lines.push(
      `A premium sports fan-page QUOTE card, portrait 3:4, full-bleed.`,
      fromReference
        ? `Use the supplied reference photo as-is — do not edit, alter, or regenerate the person: their face, body, pose, and expression stay completely unchanged. Only extend/composite a real in-context background and card framing (headshot or upper body, press-photo style) around the existing photo.`
        : `Subject: ${subjectPhrase || "the quoted person"} — ${nameRealPeople ? "real likeness, " : ""}headshot or upper body, current look, candid press-photo style.`,
      `A giant opening quotation mark in #${spec.accent_hex} sits top-left or behind the text block.`,
      `THE QUOTE ITSELF MUST BE RENDERED AS LARGE, HIGH-CONTRAST, PERFECTLY SPELLED TEXT filling the middle third of the card: "${spec.quote_text}"`,
      `Below the quote, a smaller attribution line rendered as text: "— ${spec.quote_attribution ?? spec.photo_subjects[0] ?? ""}"`,
      `Accent color #${spec.accent_hex} applies ONLY to the quote mark and attribution; the photo stays real and untouched.`
    );
  } else if (spec.layout === "comparison" && spec.photo_subjects.length > 1) {
    lines.push(
      `A premium sports fan-page COMPARISON card, portrait 3:4, full-bleed, split-frame head-to-head layout — NOT the same layout as a generic breaking-news card.`,
      fromReference
        ? `Use the supplied reference photo as-is — do not edit, alter, or regenerate the person: their face, body, pose, and expression stay completely unchanged. Only extend/composite a real in-context background and split-frame comparison framing around the existing photo.`
        : nameRealPeople
        ? `Left half: ${spec.photo_subjects[0]} — real likeness, correct current team kit, face visible, knees-up. Right half: ${spec.photo_subjects[1]} — real likeness, correct current team kit, face visible, knees-up.`
        : `Left half and right half each show ${describedSubjects.replace("two ", "one ")}, correct current team kit for this sport, face visible, knees-up.`,
      `A bold vertical accent-color #${spec.accent_hex} divider with a "VS" mark sits between the two halves.`,
      `Setting: a real in-context scene with depth on both sides — crowd bokeh, stadium lights, natural candid press-photo look. NEVER a flat single-color background.`,
      `THE CARD MUST CARRY THESE TEXT ELEMENTS, RENDERED LARGE AND PERFECTLY SPELLED:`,
      `1. Headline in giant white condensed ALL-CAPS across the top under a dark scrim: "${spec.headline}"${
        spec.accent
          ? ` — this is ONE CONTINUOUS SENTENCE. Within it, render the single word "${spec.accent.toUpperCase()}" in accent color #${spec.accent_hex} instead of white; every other word in the sentence stays white. Do NOT render "${spec.accent.toUpperCase()}" as a second, separate word anywhere else on the card — it is a color change applied in place to the word that already sits inside this headline, not an additional line of text.`
          : ``
      }`,
      `2. A kicker bar — solid #${spec.accent_hex} strip with white ALL-CAPS text: "${spec.kicker}"`,
      `High contrast (scrim or box behind text), nothing covering either subject's face, no truncation.`
    );
  } else {
    const layoutFraming =
      spec.layout === "hero"
        ? `full-bleed dominant hero shot filling the lower ~65% of the frame, heroic low angle, knees-up, real blurred crowd/stadium background — this is a milestone/hero card, not a plain news card`
        : spec.layout === "dramatic_news"
        ? `tight upper-body shot with high-drama directional lighting and deep shadow, moody real in-context background — this is a dramatic single-subject news card, not a standard editorial card`
        : spec.layout === "retro"
        ? `knees-up framing in the lower two thirds, warm sepia/faded-archival color grade over the whole photo, soft vintage film grain, muted contrast — this is a retrospective/nostalgia throwback card, deliberately styled to look OLD and revisited, never current-day breaking-news styling`
        : `knees-up framing in the lower two thirds, natural candid press-photo look — this is a standard editorial card`;
    lines.push(
      `A premium sports fan-page infographic card, portrait 3:4, full-bleed, magazine-grade. Layout: ${spec.layout.toUpperCase().replace(/_/g, " ")}.`,
      fromReference
        ? `Use the supplied reference photo as-is — do not edit, alter, or regenerate the person: their face, body, pose, and expression stay completely unchanged. Only extend/composite a real in-context background and card framing (${layoutFraming}) around the existing photo.`
        : spec.photo_subjects.length > 0
        ? nameRealPeople
          ? `Subject: ${namedSubjects} — real likeness${spec.photo_subjects.length > 1 ? ", ALL named people visibly present" : ""}, correct current team kit, face visible, ${layoutFraming}.`
          : `Subject: ${describedSubjects}${spec.photo_subjects.length > 1 ? ", both visibly present" : ""}, correct current team kit for this sport, face visible, ${layoutFraming}.`
        : // ⛔ OPERATOR FIX (2026-08-12): "use the MLB sport image or the
          // team logo rather than fabricating an image." A story with no
          // real depictable person used to tell the model to invent an
          // unanchored generic scene from nothing — if a real league/team
          // logo or sport image was actually supplied as the reference
          // (see activities/index.ts's pickGenericPhoto path), use THAT
          // real image instead of fabricating one; only fall through to a
          // fully invented scene when no real reference exists at all.
        spec.reference_photo_url
        ? `No specific person is depicted. Use the supplied real reference image (a league/team logo or generic sport scene) as the visual foundation — integrate it naturally into a typographic layout, never replace it with an invented scene.`
        : `No person is depicted: a clean typographic treatment over a real, richly textured sports scene (stadium, track, course) — never a fake or generic face.`,
      `Setting: a real in-context scene with depth — crowd bokeh, stadium lights, natural candid press-photo look. NEVER a flat single-color background, never a cut-out on a solid fill, never a plastic over-smoothed AI look.`,
      `THE CARD MUST CARRY THESE TEXT ELEMENTS, RENDERED LARGE AND PERFECTLY SPELLED:`,
      `1. Headline in giant white condensed ALL-CAPS under a dark scrim: "${spec.headline}"${
        spec.accent
          ? ` — this is ONE CONTINUOUS SENTENCE. Within it, render the single word "${spec.accent.toUpperCase()}" in accent color #${spec.accent_hex} instead of white; every other word in the sentence stays white. Do NOT render "${spec.accent.toUpperCase()}" as a second, separate word anywhere else on the card — it is a color change applied in place to the word that already sits inside this headline, not an additional line of text.`
          : ``
      }`,
      `2. A kicker bar — solid #${spec.accent_hex} strip with white ALL-CAPS text: "${spec.kicker}"`,
      `High contrast (scrim or box behind text), nothing covering the subject's face, no truncation.`,
      `Do NOT render the kicker word a second time anywhere else on the card — it appears exactly once, in the kicker bar only.`
    );
  }

  lines.push(
    `Story type: ${spec.story_type}.`,
    `Palette discipline: #${spec.accent_hex} appears only on the accent word, kicker bar and emphasis — never as the whole background.`,
    `Keep the entire card free of any drawn badge, shield, circular emblem, watermark or logo — top-right, top-center, anywhere. Do not render the word "LOGO" or any placeholder label.`
  );

  return lines.join("\n");
}

// ⛔ OPERATOR FIX (2026-08-17, real live incident, explicit operator
// directive "text2image only to be used when i2i fails twice"): last-resort
// path when both image2image attempts on a real reference photo get
// rejected by the provider's identity-edit safety system. Describes NO
// person at all — the real, unmodified photo gets composited on top by
// code afterward (composite.ts) — and instead tells the model to leave an
// explicit clean region open, at the exact same fractional position
// composite.ts's REGION_BY_LAYOUT places the real photo into, so the two
// pieces actually line up.
const REGION_DESCRIPTION: Record<TemplateId, string> = {
  hero: "the entire lower two-thirds of the frame",
  standard_editorial: "a large centered panel across the middle-to-lower two-thirds of the frame, with a small margin on each side",
  dramatic_news: "a tall centered panel across the middle-to-lower two-thirds of the frame",
  // Same geometry as standard_editorial — retro differs by color grade/tone
  // (see buildRenderPrompt's layoutFraming), not by photo placement.
  retro: "a large centered panel across the middle-to-lower two-thirds of the frame, with a small margin on each side",
  quote: "a smaller square-ish panel in the upper-left area of the frame",
  comparison: "the left and right halves of the frame (two separate open panels, split by the center divider)",
};

export function buildBackgroundOnlyPrompt(spec: RenderSpec): string {
  const lines: string[] = [];
  const regionDesc = REGION_DESCRIPTION[spec.layout] ?? REGION_DESCRIPTION.standard_editorial;

  if (spec.is_quote && spec.quote_text) {
    lines.push(
      `A premium sports fan-page QUOTE card background, portrait 3:4, full-bleed.`,
      `Do NOT draw any person, face, silhouette, or figure anywhere on this card — leave ${regionDesc} as a clean, empty, softly blurred real-scene background (stadium/arena bokeh or a solid brand-color panel) with nothing drawn on top of it. A real photo of the subject will be placed there separately — your job is only the surrounding design.`,
      `A giant opening quotation mark in #${spec.accent_hex} sits top-left or behind the text block, OUTSIDE the empty panel.`,
      `THE QUOTE ITSELF MUST BE RENDERED AS LARGE, HIGH-CONTRAST, PERFECTLY SPELLED TEXT filling the middle third of the card: "${spec.quote_text}"`,
      `Below the quote, a smaller attribution line rendered as text: "— ${spec.quote_attribution ?? spec.photo_subjects[0] ?? ""}"`,
      `Accent color #${spec.accent_hex} applies ONLY to the quote mark and attribution.`
    );
  } else if (spec.layout === "comparison") {
    lines.push(
      `A premium sports fan-page COMPARISON card background, portrait 3:4, full-bleed, split-frame head-to-head layout.`,
      `Do NOT draw any person, face, silhouette, or figure anywhere on this card — leave ${regionDesc} as clean, empty, softly blurred real-scene backgrounds (stadium/arena bokeh) with nothing drawn on top of either half. Real photos of both subjects will be placed there separately — your job is only the surrounding design.`,
      `A bold vertical accent-color #${spec.accent_hex} divider with a "VS" mark sits between the two halves.`,
      `THE CARD MUST CARRY THESE TEXT ELEMENTS, RENDERED LARGE AND PERFECTLY SPELLED:`,
      `1. Headline in giant white condensed ALL-CAPS across the top under a dark scrim: "${spec.headline}"${
        spec.accent
          ? ` — this is ONE CONTINUOUS SENTENCE. Within it, render the single word "${spec.accent.toUpperCase()}" in accent color #${spec.accent_hex} instead of white; every other word in the sentence stays white.`
          : ``
      }`,
      `2. A kicker bar — solid #${spec.accent_hex} strip with white ALL-CAPS text: "${spec.kicker}"`,
      `High contrast (scrim or box behind text), no truncation.`
    );
  } else {
    lines.push(
      `A premium sports fan-page infographic card background, portrait 3:4, full-bleed, magazine-grade. Layout: ${spec.layout.toUpperCase().replace(/_/g, " ")}.`,
      `Do NOT draw any person, face, silhouette, or figure anywhere on this card — leave ${regionDesc} as a clean, empty, softly blurred real-scene background (crowd bokeh, stadium lights) with nothing drawn on top of it. A real photo of the subject will be placed there separately by a later step — your job is only the surrounding design and text.`,
      `Setting outside that empty panel: a real in-context scene with depth — crowd bokeh, stadium lights. NEVER a flat single-color background, never a plastic over-smoothed AI look.`,
      `THE CARD MUST CARRY THESE TEXT ELEMENTS, RENDERED LARGE AND PERFECTLY SPELLED:`,
      `1. Headline in giant white condensed ALL-CAPS under a dark scrim: "${spec.headline}"${
        spec.accent
          ? ` — this is ONE CONTINUOUS SENTENCE. Within it, render the single word "${spec.accent.toUpperCase()}" in accent color #${spec.accent_hex} instead of white; every other word in the sentence stays white.`
          : ``
      }`,
      `2. A kicker bar — solid #${spec.accent_hex} strip with white ALL-CAPS text: "${spec.kicker}"`,
      `High contrast (scrim or box behind text), no truncation.`,
      `Do NOT render the kicker word a second time anywhere else on the card.`
    );
  }

  lines.push(
    `Story type: ${spec.story_type}.`,
    `Palette discipline: #${spec.accent_hex} appears only on the accent word, kicker bar and emphasis — never as the whole background.`,
    `Keep the entire card free of any drawn badge, shield, circular emblem, watermark or logo — top-right, top-center, anywhere. Do not render the word "LOGO" or any placeholder label.`
  );

  return lines.join("\n");
}

export function specViolations(spec: RenderSpec): string[] {
  const problems: string[] = [];
  for (const subject of spec.photo_subjects) {
    if (isCategoryPlaceholder(subject)) problems.push(`category_placeholder_subject:${subject}`);
  }
  if (spec.is_quote) {
    if (!spec.quote_text?.trim()) problems.push("quote_card_without_quote");
    if (spec.photo_subjects.length === 0) problems.push("quote_card_without_person");
  } else {
    if (!spec.headline.trim()) problems.push("missing_headline");
    if (!spec.kicker.trim()) problems.push("missing_kicker");
    if (spec.headline.trim().split(/\s+/).length > 6) problems.push("headline_over_6_words");
    if (spec.accent && !accentIsWordInHeadline(spec.accent, spec.headline)) problems.push("accent_not_in_headline");
  }
  if (spec.photo_subjects.length > 0 && !spec.reference_photo_url) problems.push("named_subject_without_reference_photo");
  problems.push(...promptViolations(buildRenderPrompt(spec)).map(() => "banned_prompt_phrase"));
  return problems;
}
