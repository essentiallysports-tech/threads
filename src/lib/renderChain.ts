// The render chain — three paths, tried in order, ported from the sibling
// es-automation-engine-backend repo's src/lib/render/index.ts (its own
// tested implementation). ⛔ OPERATOR OVERRIDE (2026-08-07): Orshot is
// REMOVED from this pipeline entirely, matching that repo's explicit rule
// ("Pillow and Orshot are banned as card builders") — this is "the threads
// templates" the operator meant: a deterministic AI prompt template
// (renderSpec.ts), not an Orshot visual template.
//
// A. OpenArt via MCP: gpt-image-2 image2image with a real reference photo.
// B. OpenAI gpt-image-2 direct: same model, different availability domain.
// C. Gemini gemini-3-pro-image direct: last resort, prompt-only (never
//    names a real person — it reproducibly refuses that).
//
// Every attempt is recorded; a `null` result with a full attempts array
// means every configured path failed, not that a path was silently
// skipped.

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { renderViaOpenArtPrompt } from "./openart";
import { RenderSpec, buildRenderPrompt, promptViolations } from "./renderSpec";

export type RenderAttempt = { path: string; result: string };
export type RenderOutcome = { card_url: string | null; render_path: string | null; render_attempts: RenderAttempt[] };

const S3_BUCKET = process.env.S3_BUCKET || "essentiallysports-images-v2prod";
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const s3 = new S3Client({ region: AWS_REGION, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! } });

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Path A: OpenArt over MCP ────────────────────────────────────────────────

function openartAvailable(): boolean {
  return Boolean(process.env.OPENART_MCP_RESOURCE?.trim() || process.env.OPENART_CLIENT_ID?.trim());
}

async function renderViaOpenArt(spec: RenderSpec, prompt: string): Promise<string> {
  if (!spec.reference_photo_url) {
    console.warn(`OPENART_NO_REFERENCE: ${spec.page_id} rendering text2image — likeness is unverified by construction`);
  }
  const result = await renderViaOpenArtPrompt(prompt, spec.reference_photo_url);
  return result.imageUrl;
}

// ── Path B: OpenAI gpt-image-2 direct ───────────────────────────────────────

function openaiAvailable(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

async function renderViaOpenAi(spec: RenderSpec, prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY!.trim();
  const model = process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2";

  let response: Response;
  if (spec.reference_photo_url) {
    const photo = await fetchWithTimeout(spec.reference_photo_url, {}, 30_000);
    if (!photo.ok) throw new Error(`openai_reference_fetch_${photo.status}`);
    const blob = await photo.blob();
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("size", "1024x1536");
    form.append("image[]", blob, "reference.png");
    response = await fetchWithTimeout("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form }, 180_000);
  } else {
    response = await fetchWithTimeout(
      "https://api.openai.com/v1/images/generations",
      { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, prompt, size: "1024x1536" }) },
      180_000
    );
  }

  if (!response.ok) throw new Error(`openai_${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
  const json = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const first = json.data?.[0];
  if (first?.url) return first.url;
  if (first?.b64_json) return uploadCard(Buffer.from(first.b64_json, "base64"), spec.page_id);
  throw new Error("openai_no_image_in_response");
}

// ── Path C: Gemini direct ───────────────────────────────────────────────────

function geminiAvailable(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

async function renderViaGemini(spec: RenderSpec): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY!.trim();
  const model = process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-3-pro-image";
  const prompt = buildRenderPrompt(spec, { nameRealPeople: false });

  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["IMAGE"] } }) },
    120_000
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 429) throw new Error(`gemini_credits_exhausted: add credits for this key — ${body.slice(0, 200)}`);
    throw new Error(`gemini_${response.status}: ${body.slice(0, 300)}`);
  }
  const json = (await response.json()) as { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ inlineData?: { data?: string } }> } }> };
  const candidate = json.candidates?.[0];
  const b64 = candidate?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
  if (!b64) throw new Error(`gemini_no_image: finishReason=${candidate?.finishReason ?? "unknown"}`);
  return uploadCard(Buffer.from(b64, "base64"), spec.page_id);
}

// ── Card hosting ────────────────────────────────────────────────────────────

async function uploadCard(bytes: Buffer, pageId: string): Promise<string> {
  const key = `cards/es_card_${Date.now()}_${pageId}.png`;
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: bytes, ContentType: "image/png" }));
  const url = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
  await assertPubliclyFetchable(url);
  return url;
}

async function assertPubliclyFetchable(url: string): Promise<void> {
  let status: number;
  try {
    status = (await fetchWithTimeout(url, { method: "HEAD" }, 15_000)).status;
  } catch (err) {
    throw new Error(`CARD_URL_UNREACHABLE: ${url} — ${(err as Error).message}`);
  }
  if (status < 200 || status >= 300) throw new Error(`CARD_NOT_PUBLIC: HEAD ${url} returned ${status}. Fix the bucket policy for the cards/ prefix.`);
}

// ── The chain ───────────────────────────────────────────────────────────────

export function anyRenderPathAvailable(): boolean {
  return openartAvailable() || openaiAvailable() || geminiAvailable();
}

export function isSafetyRefusal(message: string): boolean {
  return /safety system|content[_ ]policy|safety[_ ]violation|rejected by the safety|moderation[_ ]blocked/i.test(message);
}

export async function renderCardViaAi(spec: RenderSpec): Promise<RenderOutcome> {
  const prompt = buildRenderPrompt(spec);
  const attempts: RenderAttempt[] = [];

  const referencePrompt = buildRenderPrompt(spec, { subjectFromReference: true });
  const describedPrompt = buildRenderPrompt(spec, { nameRealPeople: false });
  const hasReference = Boolean(spec.reference_photo_url);

  const violations = [...promptViolations(prompt), ...promptViolations(describedPrompt), ...promptViolations(referencePrompt)];
  if (violations.length > 0) {
    attempts.push({ path: "prompt_guard", result: `banned_phrases:${[...new Set(violations)].join(",")}` });
    return { card_url: null, render_path: null, render_attempts: attempts };
  }

  const paths: Array<{ name: string; available: boolean; run: (p: string) => Promise<string>; retriesDescribed: boolean }> = [
    { name: "openart_mcp", available: openartAvailable(), run: (p) => renderViaOpenArt(spec, hasReference ? referencePrompt : p), retriesDescribed: !hasReference },
    { name: "openai_direct", available: openaiAvailable(), run: (p) => renderViaOpenAi(spec, hasReference ? referencePrompt : p), retriesDescribed: !hasReference },
    { name: "gemini_direct", available: geminiAvailable(), run: () => renderViaGemini(spec), retriesDescribed: false },
  ];

  for (const path of paths) {
    if (!path.available) {
      attempts.push({ path: path.name, result: "skipped: not configured" });
      continue;
    }
    try {
      const url = await path.run(prompt);
      attempts.push({ path: path.name, result: "ok" });
      return { card_url: url, render_path: path.name, render_attempts: attempts };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      attempts.push({ path: path.name, result: `error: ${message}` });

      if (hasReference && path.name !== "gemini_direct" && isSafetyRefusal(message)) {
        let rerolled = false;
        for (let attempt = 1; attempt <= 2 && !rerolled; attempt++) {
          try {
            const url = await path.run(prompt);
            attempts.push({ path: `${path.name}_reroll${attempt}`, result: "ok" });
            return { card_url: url, render_path: `${path.name}_reroll${attempt}`, render_attempts: attempts };
          } catch (retryErr) {
            const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
            attempts.push({ path: `${path.name}_reroll${attempt}`, result: `error: ${retryMessage}` });
            if (!isSafetyRefusal(retryMessage)) rerolled = true;
          }
        }
        continue;
      }

      if (path.retriesDescribed && isSafetyRefusal(message)) {
        try {
          const url = await path.run(describedPrompt);
          attempts.push({ path: `${path.name}_described`, result: "ok" });
          return { card_url: url, render_path: `${path.name}_described`, render_attempts: attempts };
        } catch (retryErr) {
          attempts.push({ path: `${path.name}_described`, result: `error: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}` });
        }
      }
    }
  }

  return { card_url: null, render_path: null, render_attempts: attempts };
}
