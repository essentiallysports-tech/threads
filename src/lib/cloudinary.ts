// Cloudinary preprocessing — every raw ES-MCP photo URL passes through here
// before reaching Orshot.
//
// ⛔ CONFIRMED live 2026-08-06, the hard way: `g_face` (Cloudinary's
// automatic face-gravity) does NOT reliably isolate one subject the way
// its name suggests. A real busy action-shot test case (Luka Doncic,
// defender, and a crowd member all in frame) had THREE faces detected by
// Cloudinary's own `faces:true` info — [[679,214,119,150],[120,92,62,80],
// [937,70,84,158]] — and the crop stayed identically wide/busy across
// z_1.1 through z_2.5 (verified — literally byte-identical framing at every
// zoom level tested), meaning the automatic gravity was never actually
// isolating a single face the way `zoom` assumes.
//
// Fix: don't trust the opaque gravity algorithm at all. Request face
// coordinates directly (`faces: true` on upload, no eager yet), pick the
// LARGEST detected face ourselves (the real subject is normally the
// closest/most prominent person in a sports photo), and compute an
// EXPLICIT pixel crop rectangle around it — positioned so the face sits in
// the lower-middle of the frame (roughly 38% down), leaving the top ~35%
// genuinely clear for the headline/kicker text both card templates place
// there (see cardRegistry.ts — HERO/NEWS_TEMPLATE element geometry, headline
// occupies roughly y:30-360 of a 1350px-tall canvas). Falls back to a
// centered crop (no face reference) only when Cloudinary detects nothing —
// still a real, deliberate choice, not a silent default.

import { createHash } from "crypto";
import { fetchWithTimeout } from "./httpUtil";

function sign(params: Record<string, string | number | boolean>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1").update(toSign + apiSecret).digest("hex");
}

function requireCreds() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET must all be set");
  }
  return { cloudName, apiKey, apiSecret };
}

interface UploadInfo {
  publicId: string;
  origWidth: number;
  origHeight: number;
  faces: Array<[number, number, number, number]>; // [x, y, w, h] in original px
}

async function uploadAndDetect(sourceUrl: string): Promise<UploadInfo> {
  const { cloudName, apiKey, apiSecret } = requireCreds();
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = "es-threads-temporal";
  const signedParams = { faces: "true", folder, timestamp };
  const signature = sign(signedParams, apiSecret);

  const form = new URLSearchParams({
    file: sourceUrl,
    api_key: apiKey,
    timestamp: String(timestamp),
    faces: "true",
    folder,
    signature,
  });

  const res = await fetchWithTimeout(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form },
    30_000
  );
  if (!res.ok) throw new Error(`Cloudinary upload -> ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as {
    public_id?: string;
    width?: number;
    height?: number;
    faces?: Array<[number, number, number, number]>;
  };
  if (!data.public_id || !data.width || !data.height) {
    throw new Error(`Cloudinary upload returned incomplete data: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { publicId: data.public_id, origWidth: data.width, origHeight: data.height, faces: data.faces || [] };
}

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Shared between computeFaceCrop's positioning and faceFullyContained's
// validation — MUST stay in sync (see the "confirmed live" note below on
// why a too-small margin lets clipped-head crops through undetected).
// 0.6x the larger face dimension gives enough room for hair/headwear/ears
// that extend well past Cloudinary's tight eyes-nose-mouth bounding box.
function faceMargin(fw: number, fh: number): number {
  return Math.max(fw, fh) * 0.6;
}

// Pure, independently-testable — the actual "where does the crop go" logic.
//
// `faceHeightMultiplier` controls how tight the crop is around the largest
// detected face: ~6x gives a head-to-waist headshot (used for the small
// circular inset); a much larger multiplier (~16x) gives a wide, full-bleed
// context shot (used for the hero). Confirmed live 2026-08-07: feeding the
// SAME tight 6x inset crop into the hero slot caused the hero to be a tiny
// pixel region stretched to fill the whole 1080x1350+ canvas — visible as
// blur or, when that tight region happened to land on a dark/background
// patch, crushed-black mush. Hero and inset must always use different
// multipliers even when they're cropped from the same source photo.
export function computeFaceCrop(
  origWidth: number,
  origHeight: number,
  faces: Array<[number, number, number, number]>,
  targetWidth: number,
  targetHeight: number,
  faceHeightMultiplier: number = 6
): CropRect {
  const aspect = targetWidth / targetHeight;

  if (faces.length === 0) {
    // No face reference — centered crop at the target aspect, clamped to
    // the source image. A deliberate, visible fallback, not a silent guess.
    const h = Math.min(origHeight, origWidth / aspect);
    const w = h * aspect;
    return { x: (origWidth - w) / 2, y: (origHeight - h) / 2, w, h };
  }

  // Largest detected face by area — the real subject in a sports photo is
  // normally the closest/most prominent person, not necessarily first in
  // the array.
  const [fx, fy, fw, fh] = faces.reduce((a, b) => (a[2] * a[3] >= b[2] * b[3] ? a : b));
  const faceCenterX = fx + fw / 2;
  const faceCenterY = fy + fh / 2;

  let cropH = fh * faceHeightMultiplier;
  let cropW = cropH * aspect;

  // ⛔ Requirement (2026-08-07): the athlete's face must be 100% visible —
  // never cropped off at a frame edge. Cloudinary's face bbox only covers
  // eyes/nose/mouth, not the full head — hair/headwear/jaw routinely extend
  // 50-70% of a face-box dimension beyond it — so the crop must be big
  // enough to contain the face PLUS a real margin (faceMargin, shared with
  // faceFullyContained's validation below — they must agree).
  //
  // ⛔ CONFIRMED LIVE 2026-08-07 (two bugs, in order): (1) a too-small
  // margin still let visibly clipped heads through (Anthony Davis, first
  // fix). (2) bumping the margin then caused the FIXED multiplier-derived
  // cropW/H — sized before ever checking whether it could actually contain
  // that margin — to be too small for some tightly-framed source photos,
  // so positioning could never satisfy containment and the crop stayed
  // clipped anyway. Fix: grow cropW/H to guarantee they can contain the
  // face+margin BEFORE positioning, not just before the source-bounds
  // shrink. Only when the source image ITSELF is smaller than what the
  // face+margin needs does this become genuinely infeasible.
  const margin = faceMargin(fw, fh);
  const requiredW = fw + margin * 2;
  const requiredH = fh + margin * 2;
  if (cropW < requiredW) {
    cropW = requiredW;
    cropH = cropW / aspect;
  }
  if (cropH < requiredH) {
    cropH = requiredH;
    cropW = cropH * aspect;
  }

  // Shrink to fit the source image (keeping aspect) — must happen before
  // face-containment positioning below, otherwise a too-big crop window
  // gets shrunk afterward and can slice back into the face.
  if (cropW > origWidth) {
    cropH *= origWidth / cropW;
    cropW = origWidth;
  }
  if (cropH > origHeight) {
    cropW *= origHeight / cropH;
    cropH = origHeight;
  }

  // ⛔ CONFIRMED LIVE 2026-08-07 (bug #3): shrinking to fit the source can
  // undo the requiredW/H growth above — e.g. a 1200x800 source photo where
  // the face already fills ~50% of the frame has no room for a 12x-hero
  // crop AND full containment at once. When that happens, cropW/H below
  // the requirement means no position can satisfy containment (the clamp
  // further down silently no-ops), and the render ships with a clipped
  // face anyway. Genuinely infeasible at this multiplier — fall back to
  // the WHOLE source image, which trivially contains the entire face by
  // definition (its coordinates are within the source by API contract).
  // Final aspect-fit (cropTo's c_fill) may crop some background on the
  // long axis, but the face itself is guaranteed never clipped.
  if (cropW < requiredW - 0.5 || cropH < requiredH - 0.5) {
    return { x: 0, y: 0, w: Math.round(origWidth), h: Math.round(origHeight) };
  }

  // Position the face vertically at ~28% down the crop, leaving the top
  // clear for headline/kicker text (see the module comment above).
  //
  // ⛔ CONFIRMED LIVE 2026-08-07: some pages apply their own object-fit
  // ("cover" + "center top" anchor with a source aspect very different
  // from ours) that effectively crops off the BOTTOM of whatever we send —
  // a golf single-subject page did exactly this and the text banner ended
  // up overlapping the athlete's eyes even though our own crop math looked
  // fine in isolation. We can't reverse-engineer every page's object-fit
  // behavior individually, so bias the face higher (28% instead of 38%)
  // as a global safety margin — costs a little headroom on pages that
  // don't do this, buys real insurance on ones that do.
  let cropY = faceCenterY - cropH * 0.28;
  let cropX = faceCenterX - cropW / 2;

  // Clamp position so the full face bounding box (with margin) stays
  // inside the crop window, BEFORE clamping to the source image bounds —
  // face-containment takes priority over the ideal 38%-down placement.
  const minX = fx + fw + margin - cropW; // crop's left edge must be <= this for the face's right edge to stay in
  const maxX = fx - margin; // crop's left edge must be >= this for the face's left edge to stay in
  const minY = fy + fh + margin - cropH;
  const maxY = fy - margin;
  if (minX <= maxX) cropX = Math.min(Math.max(cropX, minX), maxX);
  if (minY <= maxY) cropY = Math.min(Math.max(cropY, minY), maxY);

  // Finally clamp to the source image bounds (crop window can't request
  // pixels outside the source). Since cropW/H already fit within the
  // source and are larger than the face bbox + margin, this does not
  // reintroduce face-cropping in the normal case.
  cropX = Math.min(Math.max(cropX, 0), origWidth - cropW);
  cropY = Math.min(Math.max(cropY, 0), origHeight - cropH);

  return { x: Math.round(cropX), y: Math.round(cropY), w: Math.round(cropW), h: Math.round(cropH) };
}

export interface CloudinaryCropResult {
  url: string;
}

// An uploaded, face-detected source photo — call `cropTo` on it as many
// times as needed (hero wide shot, inset tight headshot, whatever) without
// re-uploading. Exposed so one entity's photo can serve multiple crops, and
// so two DIFFERENT entities' photos (hero subject + quote speaker) are
// never accidentally forced to share one upload.
export interface PickedPhoto {
  cloudName: string;
  publicId: string;
  origWidth: number;
  origHeight: number;
  faces: Array<[number, number, number, number]>;
}

export function cropTo(photo: PickedPhoto, width: number, height: number, faceHeightMultiplier: number = 6): CloudinaryCropResult {
  const rect = computeFaceCrop(photo.origWidth, photo.origHeight, photo.faces, width, height, faceHeightMultiplier);
  const transformation = `c_crop,x_${rect.x},y_${rect.y},w_${rect.w},h_${rect.h}/c_fill,w_${width},h_${height}/q_auto,f_auto`;
  return { url: `https://res.cloudinary.com/${photo.cloudName}/image/upload/${transformation}/${photo.publicId}` };
}

// ⛔ Confirmed live 2026-08-07: computeFaceCrop's face-containment clamp can
// still get overridden by the final "stay inside the source image" clamp —
// when the SOURCE photo itself already frames the subject with their face
// close to its own edge, there just aren't pixels to extend into, and the
// face ends up clipped in the final render (an Anthony Davis hero shot
// where half his face ran off the left edge of the 1080x1350 canvas). No
// amount of crop math can add pixels that don't exist in the source — the
// fix is to detect this per-candidate and skip to the next search result
// rather than ship a render with a clipped face.
function faceFullyContained(
  rect: CropRect,
  face: [number, number, number, number]
): boolean {
  const [fx, fy, fw, fh] = face;
  const margin = faceMargin(fw, fh);
  return (
    fx - margin >= rect.x &&
    fy - margin >= rect.y &&
    fx + fw + margin <= rect.x + rect.w &&
    fy + fh + margin <= rect.y + rect.h
  );
}

export async function cropForCard(sourceUrl: string, width: number, height: number): Promise<CloudinaryCropResult> {
  const photo = await pickPhoto([sourceUrl], width, height);
  if (!photo) throw new Error(`Cloudinary: source unreachable or face would be clipped: ${sourceUrl}`);
  return cropTo(photo, width, height);
}

// ⛔ REVERTED live 2026-08-06 — a real render surfaced a worse bug than the
// one this was meant to fix: "exactly one face detected" does NOT mean it's
// the RIGHT face. A photo where a bystander's face was clearly detected
// (scoring Infinity) beat a photo where the actual queried athlete's face
// was correctly detected alongside others (scoring lower under the old
// dominanceScore heuristic) — a Luka Doncic search rendered a random
// stranger's face because that candidate happened to have only one
// detectable face. Cloudinary's face API returns bounding boxes, not
// identity — it cannot tell us WHICH face is the athlete we searched for.
// ES-MCP's own relevance ranking is the only real signal for "is this photo
// actually about the right subject" — trust it. A busy-but-correct-subject
// photo is always better than a clean-but-wrong-subject one. This function
// just tries candidates in ES-MCP's own ranked order and uses the first
// reachable one; face-detection is still used (via computeFaceCrop/cropTo)
// to frame WITHIN that chosen photo, never to pick BETWEEN photos.
//
// `width`/`height`/`faceHeightMultiplier` are the crop this photo is being
// picked FOR — required (not just cosmetic) because whether a face can be
// fully contained depends on the actual target crop, not just reachability
// (see faceFullyContained's module comment). A candidate whose largest face
// would end up clipped at THIS target is skipped in favor of the next
// ranked candidate, same as an unreachable URL.
// ⛔ OPERATOR FIX (2026-08-12): "use the MLB sport image or the team logo
// rather than fabricating an image." When a story genuinely has no
// depictable person (extractEntityViaAI confirmed none), the render prompt
// used to ask the AI to invent a generic "richly textured sports scene"
// from scratch with nothing real to anchor it — better to use a REAL
// league/team logo or generic sport image from ES-MCP instead. pickPhoto
// above hard-rejects any zero-face candidate (correct for player photos —
// a photo with no visible face can't be the athlete), which makes it
// structurally unusable here: a logo has zero faces by definition. This is
// the same reachability-check loop with that one requirement dropped —
// cropTo/computeFaceCrop already have a real, deliberate zero-face
// fallback (a centered crop at the target aspect), so nothing downstream
// needs to change to accept this result.
export async function pickGenericPhoto(candidateUrls: string[]): Promise<PickedPhoto | null> {
  const { cloudName } = requireCreds();
  for (const url of candidateUrls) {
    try {
      const info = await uploadAndDetect(url);
      return { cloudName, ...info };
    } catch {
      continue;
    }
  }
  return null;
}

export async function pickPhoto(
  candidateUrls: string[],
  width: number,
  height: number,
  faceHeightMultiplier: number = 6
): Promise<PickedPhoto | null> {
  const { cloudName } = requireCreds();
  for (const url of candidateUrls) {
    try {
      const info = await uploadAndDetect(url);
      // ⛔ Confirmed live 2026-08-07: a personal family-portrait photo (5
      // unrelated people + a toddler) ranked high enough in ES-MCP's own
      // results for "Micah Parsons" to win every time — it's reachable and
      // his face passes containment fine, it's just editorially wrong for
      // a card. This is NOT the dominance-scoring bug from before (that
      // was re-ranking WHICH face is the subject across candidates); this
      // is a blunt floor on obviously-non-editorial group/family photos,
      // applied absolutely, not used to reorder anything relative to
      // ES-MCP's own ranking among the photos that pass it.
      if (info.faces.length >= 5) continue;
      // ⛔ Confirmed live 2026-08-07: a zero-face candidate (a ball going
      // through the hoop, no player visible at all) was passing through
      // unconditionally — the containment check only ran "if faces.length
      // > 0", so "no face detected" was silently treated as "nothing to
      // validate" instead of "this photo doesn't show the athlete at all."
      // The hard rule is the athlete's face must be visible — a photo with
      // no detected face can never satisfy that, so it must be rejected,
      // not waved through.
      if (info.faces.length === 0) continue;
      const largestFace = info.faces.reduce((a, b) => (a[2] * a[3] >= b[2] * b[3] ? a : b));
      const rect = computeFaceCrop(info.origWidth, info.origHeight, info.faces, width, height, faceHeightMultiplier);
      // ⛔ OPERATOR FIX (2026-08-08, real live incident): confirmed live that
      // computeFaceCrop's own "genuinely infeasible at this multiplier, fall
      // back to the whole source image" path (its comment: "trivially
      // contains the entire face by definition") was NOT actually trivial —
      // faceFullyContained still requires the face PLUS a real margin
      // (0.6x its size) to fit inside the rect, and when the source photo
      // itself frames the face close to ITS OWN edge (common for tightly-
      // cropped press headshots — confirmed live: a real, single-clean-face
      // Conor McGregor photo, face at y:24 of a 920px-tall source), no crop
      // — including the full source image — can satisfy that margin, because
      // the pixels simply don't exist beyond the source's own bounds. Every
      // one of 6 real ES-MCP candidates for two different real athletes
      // (Conor McGregor, Islam Makhachev) failed this exact way, permanently
      // blocking those pages' render step for days. When computeFaceCrop has
      // already fallen back to the whole source image, that IS the maximum
      // any crop can offer from this source — rejecting it in favor of
      // "try the next candidate" discards a genuinely good, correctly-
      // identified single-face photo for a margin the source can never
      // provide, not for any real quality problem.
      const isWholeSourceFallback = rect.x === 0 && rect.y === 0 && rect.w === info.origWidth && rect.h === info.origHeight;
      if (!isWholeSourceFallback && !faceFullyContained(rect, largestFace)) continue; // this photo can't give a full-face crop at this size — try the next candidate
      return { cloudName, ...info };
    } catch {
      continue; // unreachable/broken source — try the next ranked candidate
    }
  }
  return null; // every candidate was unreachable or would clip the face
}
