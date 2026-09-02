// OpenArt integration — full-card generation as the PRIMARY rendering
// engine, with Orshot as fallback (operator direction, 2026-08-07).
//
// Auth + call shape verified against the sibling `es-automation-engine-backend`
// repo's own tested implementation (src/lib/render/index.ts,
// src/lib/mcp/oauth.ts, commit "Feat: Feature completion end to end + tested
// core steps (render test...)") rather than guessed — that project has a
// working render chain already exercising this exact server. Ported here:
// default tool names (openart_generate_image / openart_creation_get), the
// image2image param shape, and the OAuth refresh-race handling.
//
// Auth: OpenArt has no public API (confirmed live — enterprise-inquiry
// only). The only viable server-side path is the OAuth client set up in the
// S3 config file this module reads/writes below.
//
// ⛔ CONFIRMED LIVE 2026-08-07: this endpoint does REFRESH TOKEN ROTATION —
// every refresh call returns a new refresh value and invalidates the old
// one. Two processes refreshing concurrently can race: one wins, the other's
// write is now stale. On a refresh failure this re-reads S3 once (another
// process may have just rotated it) before giving up, mirroring the sibling
// repo's `accessTokenFor`. A static value in .env.local is only a one-time
// bootstrap for when S3 is unreadable — after the first rotation, S3 is the
// only place the current value lives.
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { fetchWithTimeout } from "./httpUtil";

const TOKEN_ENDPOINT_DEFAULT = process.env.OPENART_TOKEN_ENDPOINT || "https://openart.ai/suite/api/auth/oauth/token";
const MCP_RESOURCE_DEFAULT = process.env.OPENART_MCP_RESOURCE || "https://mcp.openart.ai/mcp";
const OAUTH_S3_BUCKET = process.env.S3_BUCKET || "essentiallysports-images-v2prod";
const OAUTH_S3_KEY = "config/fb-automation/openart_oauth.json";

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! },
});

interface OAuthConfig {
  client_id: string;
  refresh_token: string;
  access_token?: string;
  expires_at?: string;
  token_endpoint: string;
  resource: string;
  obtained_at?: string;
}

async function readOAuthConfig(): Promise<OAuthConfig> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: OAUTH_S3_BUCKET, Key: OAUTH_S3_KEY }));
    return JSON.parse(await res.Body!.transformToString());
  } catch {
    const clientId = process.env.OPENART_CLIENT_ID;
    const refreshToken = process.env.OPENART_REFRESH_TOKEN;
    if (!clientId || !refreshToken) throw new Error("OpenArt OAuth config unreadable from S3 and OPENART_CLIENT_ID/OPENART_REFRESH_TOKEN not set");
    return { client_id: clientId, refresh_token: refreshToken, token_endpoint: TOKEN_ENDPOINT_DEFAULT, resource: MCP_RESOURCE_DEFAULT };
  }
}

async function writeOAuthConfig(config: OAuthConfig): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: OAUTH_S3_BUCKET, Key: OAUTH_S3_KEY, Body: JSON.stringify(config, null, 2), ContentType: "application/json" }));
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(endpoint: string, form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    },
    20_000
  );
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`oauth_token_${res.status}: ${json.error ?? ""} ${json.error_description ?? ""}`.trim());
  }
  return json;
}

async function refreshAndStore(config: OAuthConfig): Promise<string> {
  const tokens = await postToken(config.token_endpoint || TOKEN_ENDPOINT_DEFAULT, {
    grant_type: "refresh_token",
    refresh_token: config.refresh_token,
    client_id: config.client_id,
    resource: config.resource || MCP_RESOURCE_DEFAULT,
  });
  const expiresAt = Date.now() + (tokens.expires_in ? tokens.expires_in * 1000 : 55 * 60 * 1000);
  const next: OAuthConfig = {
    ...config,
    access_token: tokens.access_token!,
    // A server that rotates gives us a new one; one that doesn't, keeps ours.
    refresh_token: tokens.refresh_token || config.refresh_token,
    expires_at: new Date(expiresAt).toISOString(),
    obtained_at: new Date().toISOString(),
  };
  cachedAccessToken = next.access_token!;
  cachedExpiresAt = expiresAt;
  await writeOAuthConfig(next);
  return next.access_token!;
}

const EXPIRY_MARGIN_MS = 60_000; // refresh this far before actual expiry so a call can't expire mid-flight

let cachedAccessToken: string | null = null;
let cachedExpiresAt = 0; // epoch ms

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedExpiresAt - EXPIRY_MARGIN_MS) return cachedAccessToken;

  const config = await readOAuthConfig();
  if (config.access_token && config.expires_at && new Date(config.expires_at).getTime() - EXPIRY_MARGIN_MS > Date.now()) {
    cachedAccessToken = config.access_token;
    cachedExpiresAt = new Date(config.expires_at).getTime();
    return cachedAccessToken;
  }

  try {
    return await refreshAndStore(config);
  } catch (err) {
    // Another process may have rotated the refresh token between our read
    // and our use of it — re-read once before giving up.
    const fresh = await readOAuthConfig();
    if (fresh.refresh_token && fresh.refresh_token !== config.refresh_token) {
      if (fresh.access_token && fresh.expires_at && new Date(fresh.expires_at).getTime() - EXPIRY_MARGIN_MS > Date.now()) {
        cachedAccessToken = fresh.access_token;
        cachedExpiresAt = new Date(fresh.expires_at).getTime();
        return cachedAccessToken;
      }
      return refreshAndStore(fresh);
    }
    throw new Error(`OpenArt OAuth refresh failed: ${(err as Error).message}. Re-run npm run openart:login in es-automation-engine-backend.`);
  }
}

// ⛔ OPERATOR FIX (2026-08-12, real live incident): live logs confirmed a
// real Cloudflare 502 ("origin_bad_gateway") from mcp.openart.ai itself at
// 2026-08-12T10:13:26Z. Before this fix, that single transient blip threw
// immediately and burned an entire reroll slot (a full new image-generation
// attempt, up to 90s + real OpenArt credits) for what a 502/503/504 usually
// is: a few-second edge-network hiccup, not a real outage. One quick,
// cheap retry here recovers most of those for free, before falling back to
// the expensive reroll machinery renderChain.ts already has.
async function mcpCall(method: string, params: Record<string, unknown>, _isRetry = false): Promise<any> {
  const token = await getAccessToken();
  // Generous — this covers real image2image generation calls, which can
  // legitimately take a while. Still a hard ceiling: no call here can hang
  // forever regardless of how unresponsive OpenArt's server is.
  const res = await fetchWithTimeout(
    MCP_RESOURCE_DEFAULT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    150_000
  );
  if (!res.ok) {
    if (!_isRetry && [502, 503, 504].includes(res.status)) {
      await new Promise((r) => setTimeout(r, 2_000));
      return mcpCall(method, params, true);
    }
    throw new Error(`OpenArt MCP ${method} -> ${res.status}: ${await res.text()}`);
  }

  const raw = await res.text();
  const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
  const jsonText = dataLine ? dataLine.slice(6) : raw;
  const parsed = JSON.parse(jsonText);
  if (parsed.error) throw new Error(`OpenArt MCP ${method} error: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await mcpCall("tools/call", { name, arguments: args });
  const content = result?.content as Array<{ type: string; text?: string }> | undefined;
  const text = (content || []).map((c) => c.text || "").join("\n") || JSON.stringify(result || {});
  return { isError: Boolean(result?.isError), text };
}

/** Pull the first image URL out of a tool-result text (JSON or prose). */
export function extractImageUrl(text: string): string | null {
  try {
    const json = JSON.parse(text);
    for (const key of ["url", "image_url", "imageUrl", "output_url"]) {
      const value = json?.[key] ?? json?.data?.[key] ?? json?.images?.[0]?.[key] ?? json?.images?.[0];
      if (typeof value === "string" && /^https?:\/\//.test(value)) return value;
    }
  } catch {
    /* not JSON — scan as prose */
  }
  const match = text.match(/https?:\/\/[^\s"')]+\.(?:png|jpe?g|webp)[^\s"')]*/i) ?? text.match(/https?:\/\/[^\s"')]+/);
  return match ? match[0] : null;
}

/** First `historyId`-shaped value in a tool result. */
export function extractHistoryId(text: string): string | null {
  try {
    const json = JSON.parse(text);
    for (const key of ["historyId", "history_id", "id"]) {
      const value = json?.[key] ?? json?.data?.[key] ?? json?.result?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
    /* fall through to a text scan */
  }
  const match = text.match(/history[_-]?id["'\s:]+([A-Za-z0-9_-]{6,})/i);
  return match ? match[1] : null;
}

export function isTerminalFailure(text: string): boolean {
  return /\b(FAILED|CANCELLED|CANCELED|ERROR|REJECTED|BLOCKED)\b/i.test(text);
}

export const OPENART_POLL_INTERVAL_MS = 5_000;
// ⛔ OPERATOR FIX (2026-08-12, real live incident): confirmed live — a single
// stuck OpenArt generation burning the full 300s poll timeout, multiplied
// across up to 2 rerolls x 2 outer renderAndVerifyText attempts, was the
// dominant cause of runs missing the 13-post floor (every BELOW_RUN_FLOOR
// log tonight shows "hit the time budget", not genuine rejections). With
// PAGE_CONCURRENCY=6, one page stuck like this occupies a worker slot for
// most of the run, starving every other page behind it. A real success
// completes in well under 90s in practice; if it hasn't finished by then
// it's effectively stuck, and failing fast to let the pipeline try the next
// path/candidate/page beats waiting out a 5-minute hang on a doomed render.
export const OPENART_POLL_TIMEOUT_MS = 90_000;

export interface OpenArtCardResult {
  imageUrl: string;
}

// ⛔ OPERATOR OVERRIDE (2026-08-07): the prompt is now built by
// renderSpec.ts's buildRenderPrompt — ported verbatim from the sibling
// es-automation-engine-backend repo's own tested prompt template ("the
// threads templates"), not hand-rolled here. This function only handles
// the MCP call/poll mechanics; renderChain.ts owns spec -> prompt -> here.
//
// image2image with a real reference photo is what keeps this from
// inventing a fake photo of a real person — the reference photo carries
// the likeness, so the prompt (per the template) says nothing about the
// subject's face/appearance in that mode. quality:"low" per operator
// direction (~7 credits/image).
// ⛔ OPERATOR FIX (2026-08-12): "make sure 7 credits are used per image
// generation only, that is GPT image 2's I2I model only." This used to
// silently fall back to mode:"text2image" whenever no reference photo was
// available — a different OpenArt capability than the one costed and
// approved at ~7 credits/low-quality. I2I-only now: no reference photo
// means no OpenArt render is attempted at all (the caller's existing
// try/catch treats this as a failed path and moves on), rather than
// spending credits on an uncosted, unapproved mode.
async function pollForImage(historyId: string, startedText: string): Promise<OpenArtCardResult> {
  const immediate = extractImageUrl(startedText);
  if (immediate) return { imageUrl: immediate };
  if (!historyId) throw new Error(`OpenArt generate_image: no historyId in result: ${startedText.slice(0, 300)}`);

  const pollTool = process.env.OPENART_MCP_POLL_TOOL?.trim() || "openart_creation_get";
  const deadline = Date.now() + OPENART_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, OPENART_POLL_INTERVAL_MS));
    const poll = await callTool(pollTool, { historyId });
    if (poll.isError) throw new Error(`OpenArt poll tool error: ${poll.text.slice(0, 200)}`);
    const url = extractImageUrl(poll.text);
    if (url) return { imageUrl: url };
    if (isTerminalFailure(poll.text)) throw new Error(`OpenArt generation did not complete: ${poll.text.slice(0, 300)}`);
  }
  throw new Error(`OpenArt poll timeout: historyId=${historyId} after ${OPENART_POLL_TIMEOUT_MS / 1000}s`);
}

export async function renderViaOpenArtPrompt(prompt: string, referencePhotoUrl: string | null): Promise<OpenArtCardResult> {
  if (!referencePhotoUrl) {
    throw new Error("openart_i2i_only: no reference photo available — text2image is not an approved fallback");
  }
  const generateTool = process.env.OPENART_MCP_TOOL?.trim() || "openart_generate_image";

  const started = await callTool(generateTool, {
    model: "gpt-image-2",
    mode: "image2image",
    params: {
      prompt,
      imageCount: 1,
      aspectRatio: "3:4",
      resolutionTier: "1k",
      quality: "low",
      autoEnhancePrompt: false,
      visualReferences: [{ type: "image", id: "subject", url: referencePhotoUrl, label: "subject reference" }],
    },
  });
  if (started.isError) throw new Error(`OpenArt generate_image tool error: ${started.text.slice(0, 300)}`);
  return pollForImage(extractHistoryId(started.text) || "", started.text);
}

// ⛔ OPERATOR FIX (2026-08-17, real live incident, explicit operator
// directive "do whatever it takes"): the image2image path above submits the
// real athlete photo to a moderation-gated edit call, which rejects ~46% of
// real, well-sourced candidates (confirmed live — the block is on editing a
// real identifiable photo, not the prompt wording, verified via a live A/B
// test against the same photo). This generates ONLY the background/text
// layer via text2image — no real photo submitted, no identity-edit
// moderation category involved — for renderChain.ts to composite the real,
// UNMODIFIED reference photo onto afterward via code (compositeRealPhoto in
// composite.ts). Verified via openart_model_cost: text2image at this exact
// config is 5 credits, UNDER the 7-credit/image budget the operator set
// (previously I2I-only because text2image was an uncosted, unapproved mode
// — it's now priced and confirmed cheaper, so the original cost concern no
// longer applies).
export async function renderBackgroundViaOpenArt(prompt: string): Promise<OpenArtCardResult> {
  const generateTool = process.env.OPENART_MCP_TOOL?.trim() || "openart_generate_image";

  const started = await callTool(generateTool, {
    model: "gpt-image-2",
    mode: "text2image",
    params: {
      prompt,
      imageCount: 1,
      aspectRatio: "3:4",
      resolutionTier: "1k",
      quality: "low",
      autoEnhancePrompt: false,
    },
  });
  if (started.isError) throw new Error(`OpenArt generate_image (text2image) tool error: ${started.text.slice(0, 300)}`);
  return pollForImage(extractHistoryId(started.text) || "", started.text);
}
