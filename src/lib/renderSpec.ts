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

export type TemplateId = "hero" | "standard_editorial" | "dramatic_news" | "comparison" | "quote";

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

const CATEGORY_PLACEHOLDERS = new Set([
  "nascar", "nfl", "nba", "mlb", "nhl", "ufc", "mma", "wnba", "f1", "golf",
  "tennis", "boxing", "pickleball", "football", "basketball", "baseball",
  "sports", "celebrities", "sports celebrities", "athletes", "legends",
]);

export function isCategoryPlaceholder(subject: string): boolean {
  return CATEGORY_PLACEHOLDERS.has(String(subject ?? "").trim().toLowerCase());
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
        ? `Transform the supplied reference photo into this card: keep the photo real and candid, recomposed as a headshot or upper body in press-photo style.`
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
        ? `Transform the supplied reference photo into this card: keep the photo real and candid, face visible, recomposed for a split-frame comparison.`
        : nameRealPeople
        ? `Left half: ${spec.photo_subjects[0]} — real likeness, correct current team kit, face visible, knees-up. Right half: ${spec.photo_subjects[1]} — real likeness, correct current team kit, face visible, knees-up.`
        : `Left half and right half each show ${describedSubjects.replace("two ", "one ")}, correct current team kit for this sport, face visible, knees-up.`,
      `A bold vertical accent-color #${spec.accent_hex} divider with a "VS" mark sits between the two halves.`,
      `Setting: a real in-context scene with depth on both sides — crowd bokeh, stadium lights, natural candid press-photo look. NEVER a flat single-color background.`,
      `THE CARD MUST CARRY THESE TEXT ELEMENTS, RENDERED LARGE AND PERFECTLY SPELLED:`,
      `1. Headline in giant white condensed ALL-CAPS across the top under a dark scrim: "${spec.headline}"`,
      ...(spec.accent ? [`2. One accent word in #${spec.accent_hex}: "${spec.accent}" — a DIFFERENT word from the kicker below, never the same text repeated.`] : []),
      `${spec.accent ? "3" : "2"}. A kicker bar — solid #${spec.accent_hex} strip with white ALL-CAPS text: "${spec.kicker}"`,
      `High contrast (scrim or box behind text), nothing covering either subject's face, no truncation.`
    );
  } else {
    const layoutFraming =
      spec.layout === "hero"
        ? `full-bleed dominant hero shot filling the lower ~65% of the frame, heroic low angle, knees-up, real blurred crowd/stadium background — this is a milestone/hero card, not a plain news card`
        : spec.layout === "dramatic_news"
        ? `tight upper-body shot with high-drama directional lighting and deep shadow, moody real in-context background — this is a dramatic single-subject news card, not a standard editorial card`
        : `knees-up framing in the lower two thirds, natural candid press-photo look — this is a standard editorial card`;
    lines.push(
      `A premium sports fan-page infographic card, portrait 3:4, full-bleed, magazine-grade. Layout: ${spec.layout.toUpperCase().replace(/_/g, " ")}.`,
      fromReference
        ? `Transform the supplied reference photo into this card: keep the photo real and candid, face visible, recomposed with ${layoutFraming}.`
        : spec.photo_subjects.length > 0
        ? nameRealPeople
          ? `Subject: ${namedSubjects} — real likeness${spec.photo_subjects.length > 1 ? ", ALL named people visibly present" : ""}, correct current team kit, face visible, ${layoutFraming}.`
          : `Subject: ${describedSubjects}${spec.photo_subjects.length > 1 ? ", both visibly present" : ""}, correct current team kit for this sport, face visible, ${layoutFraming}.`
        : `No person is depicted: a clean typographic treatment over a real, richly textured sports scene (stadium, track, course) — never a fake or generic face.`,
      `Setting: a real in-context scene with depth — crowd bokeh, stadium lights, natural candid press-photo look. NEVER a flat single-color background, never a cut-out on a solid fill, never a plastic over-smoothed AI look.`,
      `THE CARD MUST CARRY THESE TEXT ELEMENTS, RENDERED LARGE AND PERFECTLY SPELLED:`,
      `1. Headline in giant white condensed ALL-CAPS under a dark scrim: "${spec.headline}"`,
      ...(spec.accent ? [`2. One accent word in #${spec.accent_hex}: "${spec.accent}" — a DIFFERENT word from the kicker below, never the same text repeated.`] : []),
      `${spec.accent ? "3" : "2"}. A kicker bar — solid #${spec.accent_hex} strip with white ALL-CAPS text: "${spec.kicker}"`,
      `High contrast (scrim or box behind text), nothing covering the subject's face, no truncation.`,
      ...(spec.accent ? [] : [`Do NOT render the kicker word a second time anywhere else on the card — it appears exactly once, in the kicker bar only.`])
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
  }
  if (spec.photo_subjects.length > 0 && !spec.reference_photo_url) problems.push("named_subject_without_reference_photo");
  problems.push(...promptViolations(buildRenderPrompt(spec)).map(() => "banned_prompt_phrase"));
  return problems;
}
