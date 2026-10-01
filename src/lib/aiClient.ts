// ⛔ OPERATOR DECISION (2026-10-01): move the pipeline's AI calls from the
// Vercel AI Gateway to Amazon Bedrock. Every Claude call in the pipeline now
// goes through callModel(), which sends the same request (same model, prompt,
// system block, max_tokens, temperature) to whichever provider is active:
//
//   AI_PROVIDER=bedrock + AWS_BEARER_TOKEN_BEDROCK  -> Amazon Bedrock
//   otherwise, VERCEL_AI_GATEWAY_KEY                -> Vercel AI Gateway (as before)
//
// so rolling back is removing AI_PROVIDER from the worker's env. Bedrock uses
// the `global.` cross-region inference profiles, which bill at Anthropic's
// list price (the `us.` regional profiles cost 10% more).
//
// Two Bedrock differences handled here, invisible to callers:
//   - it has no URL image source, so images are downloaded and sent as base64;
//   - it reports token usage, not dollars, so the spend recorded against the
//     daily cap (aiGatewayBudget.ts) is computed from tokens at list price.
//
// Web search (webSearch.ts) is not routed through here — it runs on the web
// search microservice.
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import { fetchWithTimeout } from "./httpUtil";
import { isDailyBudgetExceeded, recordGatewaySpend } from "./aiGatewayBudget";

export type AiModel = "sonnet" | "haiku";
export type AiPart = { type: "text"; text: string } | { type: "image"; url: string };

export interface AiRequest {
  tag: string; // spend attribution, see aiGatewayBudget.ts
  model: AiModel;
  system?: string; // sent as one cacheable system block
  content: string | AiPart[];
  maxTokens: number;
  temperature?: number;
  timeoutMs: number;
}

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const GATEWAY_MODELS: Record<AiModel, string> = { sonnet: "anthropic/claude-sonnet-4-5", haiku: "anthropic/claude-haiku-4-5" };
const BEDROCK_MODELS: Record<AiModel, string> = {
  sonnet: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
  haiku: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
};
// USD per million tokens — Anthropic list price, which Bedrock's global
// endpoints charge. Cache writes are the 5-minute (ephemeral) rate.
const PRICE_PER_MTOK: Record<AiModel, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};
const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // Claude's per-image limit for base64 input
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

export function aiProvider(): "bedrock" | "gateway" | null {
  if (process.env.AI_PROVIDER === "bedrock" && process.env.AWS_BEARER_TOKEN_BEDROCK) return "bedrock";
  if (process.env.VERCEL_AI_GATEWAY_KEY) return "gateway";
  return null;
}

export function aiConfigured(): boolean {
  return aiProvider() !== null;
}

// Returns the model's text. Throws on any failure — every caller already
// catches and applies its own fail-open/fallback policy, exactly as it did
// for gateway errors.
export async function callModel(req: AiRequest): Promise<string> {
  const provider = aiProvider();
  if (!provider) throw new Error("no AI provider configured (AWS_BEARER_TOKEN_BEDROCK or VERCEL_AI_GATEWAY_KEY)");
  if (await isDailyBudgetExceeded()) throw new Error("AI gateway daily budget exceeded — see aiGatewayBudget.ts");
  return provider === "bedrock" ? callBedrock(req) : callGateway(req);
}

async function callGateway(req: AiRequest): Promise<string> {
  const messages: unknown[] = [];
  if (req.system) messages.push({ role: "system", content: req.system, cache_control: { type: "ephemeral" } });
  messages.push({
    role: "user",
    content:
      typeof req.content === "string"
        ? req.content
        : req.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: p.url } })),
  });
  const res = await fetchWithTimeout(
    GATEWAY_URL,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.VERCEL_AI_GATEWAY_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GATEWAY_MODELS[req.model],
        messages,
        max_tokens: req.maxTokens,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      }),
    },
    req.timeoutMs
  );
  if (!res.ok) throw new Error(`AI gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { cost?: number } };
  recordGatewaySpend(json.usage?.cost, req.tag);
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`AI gateway returned no text content: ${JSON.stringify(json).slice(0, 300)}`);
  return content;
}

let bedrock: AnthropicBedrock | null = null;
function bedrockClient(): AnthropicBedrock {
  if (!bedrock) {
    bedrock = new AnthropicBedrock({
      apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK,
      awsRegion: process.env.AWS_BEDROCK_REGION || "us-east-1",
      maxRetries: 2, // throttling/5xx back off and retry instead of failing open straight away
    });
  }
  return bedrock;
}

function sniffImageType(buf: Buffer, header: string | null): ImageType | null {
  const h = (header || "").split(";")[0].trim().toLowerCase();
  if ((IMAGE_TYPES as readonly string[]).includes(h)) return h as ImageType;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

async function imageBlock(url: string, timeoutMs: number) {
  const res = await fetchWithTimeout(url, {}, timeoutMs);
  if (!res.ok) throw new Error(`image fetch ${res.status} for ${url.slice(0, 120)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > IMAGE_MAX_BYTES) throw new Error(`image is ${(buf.length / 1048576).toFixed(1)} MB, over the 5 MB limit: ${url.slice(0, 120)}`);
  const mediaType = sniffImageType(buf, res.headers.get("content-type"));
  if (!mediaType) throw new Error(`unsupported image type for ${url.slice(0, 120)}`);
  return { type: "image" as const, source: { type: "base64" as const, media_type: mediaType, data: buf.toString("base64") } };
}

async function callBedrock(req: AiRequest): Promise<string> {
  const started = Date.now();
  const content =
    typeof req.content === "string"
      ? req.content
      : await Promise.all(req.content.map((p) => (p.type === "text" ? { type: "text" as const, text: p.text } : imageBlock(p.url, req.timeoutMs))));
  const remaining = Math.max(5_000, req.timeoutMs - (Date.now() - started));
  const msg = await bedrockClient().messages.create(
    {
      model: BEDROCK_MODELS[req.model],
      max_tokens: req.maxTokens,
      ...(req.system ? { system: [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }] } : {}),
      messages: [{ role: "user", content }],
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    },
    { timeout: remaining }
  );
  const p = PRICE_PER_MTOK[req.model];
  const u = msg.usage;
  const costUsd =
    ((u.input_tokens || 0) * p.input +
      (u.output_tokens || 0) * p.output +
      (u.cache_creation_input_tokens || 0) * p.cacheWrite +
      (u.cache_read_input_tokens || 0) * p.cacheRead) /
    1e6;
  recordGatewaySpend(costUsd, req.tag);
  const text = msg.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text) throw new Error(`Bedrock returned no text content (stop_reason=${msg.stop_reason})`);
  return text;
}
