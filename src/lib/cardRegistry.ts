// Card template registry.
//
// ⛔ OPERATOR OVERRIDE (2026-08-06): the two generic "Universal" templates
// (13948/13949) are RETIRED — rejected as poor quality (headline text
// dominating over the photo, thin secondary text washing out). ONLY the 6
// real, hand-picked Orshot templates below are used — all reskins of the
// same ~44-52 page template family (workspace 3924).
//
// ⛔ OPERATOR OVERRIDE (2026-08-07): the family's page 1 ("Quote-1") — one
// full-bleed hero photo + one small circular inset + a quote banner — was
// being used for EVERY story regardless of content. That's wrong: this
// layout only makes sense when the story genuinely has TWO entities, one
// (in the small circle) commenting/reacting about the other (the big
// background photo). Confirmed live: for plain single-subject news
// ("Cowboys bench coach", "Judge nears franchise record") there is no
// second entity, so forcing the quote layout meant faking a second photo
// slot with nothing meaningful to put there. Fixed by mapping a second,
// real "single-subject-news" page per template (one photo, one headline,
// no inset) via 5 parallel agent dumps of each template's full page list —
// use QUOTE_TEMPLATES only when there are two distinct matched entities and
// one is genuinely quoted about the other; use NEWS_TEMPLATES otherwise.
//
// ⛔ CRITICAL, CONFIRMED LIVE 2026-08-06 THE HARD WAY: every one of these 6
// reskins has its OWN parameter names — NOT a shared naming scheme across
// the family. A render using one template's key names against another
// silently renders the template's own saved DEFAULT content instead
// (Orshot ignores unknown modification keys with just a warning, not an
// error). Every param name below was verified per-template via
// orshot_get_studio_template / orshot_get_studio_template_modifications —
// never hardcode a flat modifications object again for this family.

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;

const TRANSPARENT_1PX = "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png";

interface QuoteParams {
  templateId: number;
  heroParam: string; // full-bleed background — the entity being commented ON
  insetParam: string; // small circle — the entity doing the commenting
  logoParam?: string;
}

interface NewsParams {
  page: number;
  photoParam: string;
  headlineParam: string;
  kickerParam?: string;
  logoParam?: string;
}

// hero param | hero size (confirms full-bleed) | inset param | logo param
// 16059 Women of Motorsports | image_4 | (oversized, bleeds past canvas) | image   | image_2_copy_copy_copy
// 16124 New England Ledger   | image   | 1080x1350 (exact canvas)        | image_2 | (none)
// 16055 Cheesehead Central   | image   | 1080x1350 (exact canvas)        | image_2 | image_2_copy
// 16053 Beyond the Clark     | image_3 | 1937x1291 (oversized)           | image   | (none)
// 16061 Fore the Money       | image_2 | 1993x1570 (oversized)           | image   | (none)
// 16065 Greenside Gossip     | image_2 | 1993x1570 (oversized)           | image   | (none)
// Quote text params ARE consistent across all 6: "text" (quote, bottom
// banner) and "text_copy_copy_copy" (attribution line below it).
const QUOTE_TEMPLATES: Record<"womenOfMotorsports" | "newEnglandLedger" | "cheeseheadCentral" | "beyondTheClark" | "foreTheMoney" | "greensideGossip", QuoteParams> = {
  womenOfMotorsports: { templateId: 16059, heroParam: "image_4", insetParam: "image", logoParam: "image_2_copy_copy_copy" },
  newEnglandLedger: { templateId: 16124, heroParam: "image", insetParam: "image_2" },
  cheeseheadCentral: { templateId: 16055, heroParam: "image", insetParam: "image_2", logoParam: "image_2_copy" },
  beyondTheClark: { templateId: 16053, heroParam: "image_3", insetParam: "image" },
  foreTheMoney: { templateId: 16061, heroParam: "image_2", insetParam: "image" },
  greensideGossip: { templateId: 16065, heroParam: "image_2", insetParam: "image" },
};

type TemplateKey = keyof typeof QUOTE_TEMPLATES;

// Verified 2026-08-07 via 5 parallel agents reading each template's full
// get_studio_template_modifications dump (40-55 pages each) — the single
// best "one real photo + one headline, no second image slot" page per
// template. Every one of these happened to land on the same underlying
// family page ("TRADE RUMORS"/"REPORT" style single-subject card), just at
// a different page NUMBER per reskin (family drift, same as the quote page).
const NEWS_TEMPLATES: Record<TemplateKey, NewsParams> = {
  womenOfMotorsports: { page: 32, photoParam: "image", headlineParam: "text", kickerParam: "text_copy_1_copy_copy", logoParam: "image_2_copy_copy_copy" },
  newEnglandLedger: { page: 32, photoParam: "image", headlineParam: "text", kickerParam: "text_copy_1_copy_copy" },
  cheeseheadCentral: {
    page: 31,
    photoParam: "image",
    headlineParam: "text",
    kickerParam: "text_copy_1_copy_copy",
    logoParam: "image_2_copy_copy_copy_copy_copy_copy_copy_copy_copy_copy_copy_copy",
  },
  // ⛔ CONFIRMED BROKEN live 2026-08-07, Orshot-side, not our code: page30@image
  // silently keeps the template's own default stock photo (a basketball
  // going through a hoop) no matter what real photo URL is sent — no
  // warning, no error, just ignored. Verified NOT a Cloudinary-domain issue
  // (a Wikipedia image URL applied fine on the same param) and NOT a
  // wrong-param-name issue (Orshot's own template-modifications listing
  // confirms "image" is correct and matches its zIndex-1 full-bleed
  // element). page1's hero/inset DO correctly accept Cloudinary photos on
  // this same template, so it's isolated to specific elements on specific
  // pages, not the whole template. page36@text also throws an Orshot
  // warning claiming that param "is on page 1" instead — this template has
  // real internal parameter-binding bugs on Orshot's side. Routing
  // beyondTheClark's news-mode pages through cheeseheadCentral instead
  // (see PAGE_TEMPLATE) until this is fixed upstream — do not re-enable
  // beyondTheClark for NEWS mode without re-verifying page30 directly.
  beyondTheClark: { page: 30, photoParam: "image", headlineParam: "text", kickerParam: "text_copy_1_copy_copy" },
  foreTheMoney: { page: 30, photoParam: "image", headlineParam: "text", kickerParam: "text_copy_1_copy_copy" },
  greensideGossip: { page: 21, photoParam: "image", headlineParam: "text", kickerParam: "text_copy" },
};

// Per-page assignment — real thematic fit where one exists; the rest rotate
// across the 6 confirmed templates (never falling back to a retired
// Universal template).
const PAGE_TEMPLATE: Record<string, TemplateKey> = {
  p35: "cheeseheadCentral", // Michigan Football Fanatics
  p37: "newEnglandLedger", // Purple & Gold Pride (Lakers)
  p38: "womenOfMotorsports", // Forever the Intimidator Fan Club
  p39: "foreTheMoney", // Golf Syndicate
  p44: "greensideGossip", // second golf-themed reskin — alternates with foreTheMoney so golf content isn't always the same template
  p40: "cheeseheadCentral", // Detroit Lions Community
  p41: "newEnglandLedger", // Dallas Cowboys Community
  p42: "cheeseheadCentral", // Essentially WNBA — was beyondTheClark, rerouted (see NEWS_TEMPLATES.beyondTheClark note: page30@image confirmed broken on Orshot's side for news mode)
  p43: "cheeseheadCentral", // NFL Gossips
  p45: "womenOfMotorsports", // ES NASCAR Central
  p46: "womenOfMotorsports", // Vintage NASCAR Vault
  p47: "womenOfMotorsports", // JGR Racing Digest
  p48: "newEnglandLedger", // Baltimore Ravens Community
  p49: "cheeseheadCentral", // Philadelphia Eagles Community
  p50: "newEnglandLedger", // Bay Area Hoops
  p51: "cheeseheadCentral", // Kings Court Chronicles
  p52: "newEnglandLedger", // Kobe 8/24 Legacy
  p53: "cheeseheadCentral", // ES NBA Newsroom
  p54: "newEnglandLedger", // Conor McGregor UFC Fanpage
  p55: "cheeseheadCentral", // Fearless Female Fighters
  p56: "newEnglandLedger", // Boxing Bulletin
  p57: "cheeseheadCentral", // On The Ropes Combat
  p58: "newEnglandLedger", // New York Yankees Community
  p59: "cheeseheadCentral", // ES MLB Newsroom
  p60: "foreTheMoney", // Ohio State Wireline — was beyondTheClark, rerouted (see NEWS_TEMPLATES.beyondTheClark note)
  p61: "newEnglandLedger", // Colorado Prime Time
};

function templateKeyForPage(pageId: string): TemplateKey {
  return PAGE_TEMPLATE[pageId] ?? "cheeseheadCentral"; // sport-agnostic default for any unmapped page
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= maxWords ? text.trim() : words.slice(0, maxWords).join(" ");
}

function truncateToSentence(text: string, maxWords: number): string {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  if (words.length <= maxWords) return trimmed;
  const truncated = words.slice(0, maxWords).join(" ");
  const lastSentenceEnd = Math.max(truncated.lastIndexOf("."), truncated.lastIndexOf("!"), truncated.lastIndexOf("?"));
  if (lastSentenceEnd > 0) return truncated.slice(0, lastSentenceEnd + 1);
  return truncated + "…";
}

export interface CardPlan {
  templateId: number;
  page: number;
  modifications: Record<string, string>;
}

export interface NewsCardInputs {
  mode: "news";
  pageId: string;
  headline: string;
  kicker?: string; // e.g. "TRADE RUMORS" / "REPORT" — defaults to the page's own default kicker if omitted
  photoUrl: string;
}

export interface QuoteCardInputs {
  mode: "quote";
  pageId: string;
  headline: string; // the quote itself
  attribution: string; // who said it — goes under the small circular inset
  heroPhotoUrl: string; // the entity being commented ON — full-bleed background
  insetPhotoUrl: string; // the entity doing the commenting — small circle. MUST be a
  // different photo from heroPhotoUrl: these are two distinct entities.
}

// Verified 2026-08-07 against 16124 (New England Ledger) ONLY — a
// head-to-head "X vs Y / DEBATE" layout: two peer photos side by side, a
// player-name label under each, "Vs" and "DEBATE" badges. Only wired for
// this one template (not the full 6-template family like QUOTE/NEWS above)
// — verifying per-template geometry for every extra layout style is
// expensive (each check has cost real render-time bugs earlier this
// session) and this is a "show me the style" request, not a page rotation
// that needs every template represented.
const VS_TEMPLATE = {
  templateId: 16124,
  page: 42,
  photoAParam: "image_copy",
  photoBParam: "image_copy_copy",
  nameAParam: "text_copy_copy_copy",
  nameBParam: "text_copy_copy_copy_copy",
  questionParam: "text",
  // Default content is "Link in First Comment" — a CTA implying a real
  // link exists. This mode has no link, so it must be overridden to
  // something that isn't a false promise, never left at its default.
  ctaParam: "cta_text_copy_copy_copy_copy",
};

// Verified 2026-08-07 against 16124 page 44 — a 3-option reader-poll bar
// chart. Same one-template caveat as VS_TEMPLATE above.
const POLL_TEMPLATE = {
  templateId: 16124,
  page: 44,
  questionParam: "text",
  headerParam: "text_copy_copy_copy_copy_copy_copy_copy", // "READER POLL" label
  footerParam: "footer_copy",
  options: [
    { labelParam: "opt1_label_copy", pctParam: "opt1_pct_copy", barParam: "opt1_bar_copy" },
    { labelParam: "opt2_label_copy", pctParam: "opt2_pct_copy", barParam: "opt2_bar_copy" },
    { labelParam: "opt3_label_copy", pctParam: "opt3_pct_copy", barParam: "opt3_bar_copy" },
  ],
};

// The bar's fill width comes from a gradient color-stop, not a plain
// percentage/width style — the template represents "40% filled" as a hard
// color transition at the 40% stop. Confirmed live 2026-08-07: setting only
// the *_pct_copy text left every bar at the template's own default stop
// (41%), so all three bars rendered the same visual length regardless of
// what the percentage text said.
function pollBarFill(pct: number): string {
  const p = Math.round(pct);
  return `linear-gradient(90deg, rgba(185,14,47,1) 0%, rgba(185,14,47,1) ${p}%, rgba(185,14,47,0) ${p}%, RGB(20, 47, 71) 100%)`;
}

export interface VsCardInputs {
  mode: "vs";
  question: string; // e.g. "WHO WINS THE MVP RACE?"
  nameA: string;
  nameB: string;
  photoAUrl: string;
  photoBUrl: string;
}

export interface PollOption {
  label: string;
  pct: number; // 0-100
}

export interface PollCardInputs {
  mode: "poll";
  question: string;
  options: [PollOption, PollOption, PollOption];
  footer?: string;
}

export type CardInputs = NewsCardInputs | QuoteCardInputs | VsCardInputs | PollCardInputs;

export function buildCardPlan(inputs: CardInputs): CardPlan {
  if (inputs.mode === "vs") {
    const t = VS_TEMPLATE;
    const modifications: Record<string, string> = {
      [`page${t.page}@${t.photoAParam}`]: inputs.photoAUrl,
      [`page${t.page}@${t.photoBParam}`]: inputs.photoBUrl,
      [`page${t.page}@${t.nameAParam}`]: truncateWords(inputs.nameA, 4),
      [`page${t.page}@${t.nameBParam}`]: truncateWords(inputs.nameB, 4),
      [`page${t.page}@${t.questionParam}`]: truncateToSentence(inputs.question, 14),
      [`page${t.page}@${t.ctaParam}`]: "WHO YOU GOT?",
    };
    return { templateId: t.templateId, page: t.page, modifications };
  }

  if (inputs.mode === "poll") {
    const t = POLL_TEMPLATE;
    const modifications: Record<string, string> = {
      [`page${t.page}@${t.questionParam}`]: truncateToSentence(inputs.question, 16),
    };
    if (inputs.footer) modifications[`page${t.page}@${t.footerParam}`] = truncateWords(inputs.footer, 14);
    inputs.options.forEach((opt, i) => {
      modifications[`page${t.page}@${t.options[i].labelParam}`] = truncateWords(opt.label, 6);
      modifications[`page${t.page}@${t.options[i].pctParam}`] = `${Math.round(opt.pct)}%`;
      modifications[`page${t.page}@${t.options[i].barParam}`] = pollBarFill(opt.pct);
    });
    return { templateId: t.templateId, page: t.page, modifications };
  }

  const key = templateKeyForPage(inputs.pageId);

  if (inputs.mode === "news") {
    const t = NEWS_TEMPLATES[key];
    const modifications: Record<string, string> = {
      [`page${t.page}@${t.photoParam}`]: inputs.photoUrl,
      [`page${t.page}@${t.headlineParam}`]: truncateToSentence(inputs.headline, 14),
    };
    if (t.kickerParam && inputs.kicker) modifications[`page${t.page}@${t.kickerParam}`] = truncateWords(inputs.kicker, 4);
    if (t.logoParam) modifications[`page${t.page}@${t.logoParam}`] = TRANSPARENT_1PX;
    return { templateId: QUOTE_TEMPLATES[key].templateId, page: t.page, modifications };
  }

  const t = QUOTE_TEMPLATES[key];
  const modifications: Record<string, string> = {
    [`page1@${t.heroParam}`]: inputs.heroPhotoUrl,
    [`page1@${t.insetParam}`]: inputs.insetPhotoUrl,
    "page1@text": truncateToSentence(inputs.headline, 14),
    "page1@text_copy_copy_copy": truncateWords(inputs.attribution, 8),
  };
  if (t.logoParam) modifications[`page1@${t.logoParam}`] = TRANSPARENT_1PX;
  return { templateId: t.templateId, page: 1, modifications };
}
