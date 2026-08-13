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

// ⛔ OPERATOR FIX (2026-08-12): I2I-only per operator direction — see
// openart.ts's renderViaOpenArtPrompt, which now throws rather than
// silently falling back to a differently-priced text2image mode when no
// reference photo exists. That failure is caught by the try/catch in the
// path-attempt loop below like any other render error, so the chain still
// moves on to the next available path (or drops the candidate) normally.
async function renderViaOpenArt(spec: RenderSpec, prompt: string): Promise<string> {
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

// ⛔ OPERATOR FIX (2026-08-12, real live incident): the poll-timeout cut
// (openart.ts) closes the single-call cost, but the path/reroll matrix
// below can still stack several calls back to back. `deadlineMs` is a
// second, independent ceiling on the WHOLE chain — checked before every
// path attempt and every reroll/described retry, so no combination of
// rerolls and slow calls can ever exceed it. Optional and defaults to no
// deadline so any other caller's behavior is unchanged.
export async function renderCardViaAi(spec: RenderSpec, deadlineMs?: number): Promise<RenderOutcome> {
  const deadlinePassed = () => deadlineMs !== undefined && Date.now() > deadlineMs;
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
    // ⛔ OPERATOR FIX (2026-08-10, real live incident): a real reference photo
    // existed (from ES-MCP) for a named athlete, but OpenArt/OpenAI both
    // failed for unrelated reasons, so the chain silently fell through to
    // Gemini — which by design NEVER uses the reference photo and NEVER
    // names the real person (see renderViaGemini above). The result posted
    // as a normal success: a fully generic, no-likeness image standing in
    // for a real person, with nothing distinguishing it from a proper
    // render. This is exactly the "never substitute a generic/unrelated
    // stock image" rule this project already enforces for missing photos
    // (sourcing.ts's sourceFromEvergreenBank) — a real reference existing
    // means Gemini's blind, unnamed fallback would misrepresent the actual
    // subject, so it's not an acceptable substitute here. When a reference
    // photo exists, Gemini is not offered as a fallback at all — if
    // OpenArt and OpenAI both fail, the whole render fails and the caller
    // tries the next candidate, per the existing pool-retry design, rather
    // than post a wrong-looking image.
    { name: "gemini_direct", available: geminiAvailable() && !hasReference, run: () => renderViaGemini(spec), retriesDescribed: false },
  ];

  for (const path of paths) {
    if (deadlinePassed()) {
      attempts.push({ path: "deadline", result: "render deadline exceeded — stopping before trying further paths" });
      break;
    }
    if (!path.available) {
      const reason = path.name === "gemini_direct" && geminiAvailable() && hasReference
        ? "skipped: reference photo exists — Gemini's no-reference fallback would misrepresent the real subject"
        : "skipped: not configured";
      attempts.push({ path: path.name, result: reason });
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
          if (deadlinePassed()) {
            attempts.push({ path: `${path.name}_reroll${attempt}`, result: "skipped: render deadline exceeded" });
            break;
          }
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

      if (path.retriesDescribed && isSafetyRefusal(message) && !deadlinePassed()) {
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
