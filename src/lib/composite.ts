// Deterministic photo compositing — the last-resort render path (used only
// after 2 image2image attempts fail, per operator directive). AI generates
// ONLY the background/text layer via text2image (no real photo submitted,
// so no identity-edit moderation category applies); this module composites
// the real, completely unmodified reference photo on top via code. Never
// used to "build the card" (the operator's Pillow ban is about that) — it
// only places an already-finished real photo onto an already-finished
// AI-designed background, the same class of operation as the existing
// logo-overlay pass, just for a bigger real asset.
import sharp, { Sharp, Metadata } from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { fetchWithTimeout } from "./httpUtil";
import { TemplateId } from "./renderSpec";

const S3_BUCKET = process.env.S3_BUCKET || "essentiallysports-images-v2prod";
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const s3 = new S3Client({ region: AWS_REGION, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! } });

// Fractional bounding box (0-1 of the background's actual width/height) —
// where the real photo gets placed. Mirrors the framing language already
// used in renderSpec.ts's buildBackgroundOnlyPrompt so the AI-left gap and
// the code-placed photo line up.
interface PhotoRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

const REGION_BY_LAYOUT: Record<TemplateId, PhotoRegion> = {
  hero: { x: 0, y: 0.33, w: 1, h: 0.67 },
  standard_editorial: { x: 0.04, y: 0.32, w: 0.92, h: 0.64 },
  dramatic_news: { x: 0.08, y: 0.3, w: 0.84, h: 0.62 },
  retro: { x: 0.04, y: 0.32, w: 0.92, h: 0.64 }, // same placement as standard_editorial — retro differs by color grade, not geometry
  quote: { x: 0.08, y: 0.06, w: 0.42, h: 0.34 },
  comparison: { x: 0, y: 0.14, w: 0.5, h: 0.72 }, // left half; right half computed by mirroring x
};

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetchWithTimeout(url, {}, 30_000);
  if (!res.ok) throw new Error(`COMPOSITE_FETCH_FAILED: ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// Resizes the real photo to COVER the target region (never stretches or
// distorts it) and composites it in place. A thin real-color border helps
// it read as an intentional inset rather than a mis-sized paste.
async function compositeOnePhoto(background: Sharp, meta: Metadata, photoBuffer: Buffer, region: PhotoRegion): Promise<Sharp> {
  const bgW = meta.width!;
  const bgH = meta.height!;
  const regionW = Math.round(region.w * bgW);
  const regionH = Math.round(region.h * bgH);
  const left = Math.round(region.x * bgW);
  const top = Math.round(region.y * bgH);

  // ⛔ OPERATOR FIX (2026-08-19, real live incident): confirmed live — a
  // real posted card showed only a subject's legs/shoes against a mostly
  // empty court floor, face and torso entirely cropped out. `position:
  // "attention"` uses sharp's generic entropy/saliency heuristic to guess
  // which part of the image to keep — it has no concept of faces, and on a
  // real sports photo it can easily rate court markings, shoes, or a jersey
  // number as more "interesting" than the athlete's face. The incoming
  // photoBuffer here is ALREADY a face-centered crop from cloudinary.ts's
  // cropTo() (every caller passes `cropTo(photo, CARD_WIDTH, CARD_HEIGHT,
  // ...).url`), so the face is reliably positioned in the upper portion of
  // THIS specific buffer — biasing the second crop toward the top, instead
  // of re-guessing from scratch, reliably keeps the face/torso instead of
  // gambling on generic saliency. Not a perfect fix (the real fix is
  // threading the original PickedPhoto + face bbox through to request an
  // exact-region Cloudinary crop directly, avoiding a second crop
  // altogether) but a safe, immediate one for a bug that was actively
  // posting broken cards.
  const resizedPhoto = await sharp(photoBuffer)
    .resize(regionW, regionH, { fit: "cover", position: "top" })
    .png()
    .toBuffer();

  return background.composite([{ input: resizedPhoto, left, top }]);
}

export interface CompositeInput {
  page_id: string;
  layout: TemplateId;
  backgroundUrl: string;
  referencePhotoUrls: string[]; // 1 for most layouts, 2 for comparison
}

export async function compositeRealPhoto(input: CompositeInput): Promise<string> {
  const [backgroundBuffer, ...photoBuffers] = await Promise.all([
    fetchBuffer(input.backgroundUrl),
    ...input.referencePhotoUrls.map(fetchBuffer),
  ]);

  const baseImage = sharp(backgroundBuffer);
  const meta = await baseImage.metadata();
  if (!meta.width || !meta.height) throw new Error("COMPOSITE_BACKGROUND_NO_DIMENSIONS");

  let composited: Sharp;
  if (input.layout === "comparison" && photoBuffers.length === 2) {
    const leftRegion = REGION_BY_LAYOUT.comparison;
    const rightRegion: PhotoRegion = { ...leftRegion, x: 0.5 };
    composited = await compositeOnePhoto(baseImage, meta, photoBuffers[0], leftRegion);
    composited = await compositeOnePhoto(composited, meta, photoBuffers[1], rightRegion);
  } else {
    const region = REGION_BY_LAYOUT[input.layout] || REGION_BY_LAYOUT.standard_editorial;
    composited = await compositeOnePhoto(baseImage, meta, photoBuffers[0], region);
  }

  const finalBuffer = await composited.png().toBuffer();
  const key = `cards/es_card_composite_${Date.now()}_${input.page_id}.png`;
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: finalBuffer, ContentType: "image/png" }));
  const url = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;

  const check = await fetchWithTimeout(url, { method: "HEAD" }, 15_000).catch((err) => {
    throw new Error(`COMPOSITE_URL_UNREACHABLE: ${url} — ${(err as Error).message}`);
  });
  if (check.status < 200 || check.status >= 300) throw new Error(`COMPOSITE_URL_NOT_PUBLIC: HEAD ${url} returned ${check.status}`);
  return url;
}
