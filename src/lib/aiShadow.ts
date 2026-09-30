// ⛔ OPERATOR DECISION (2026-09-30): 24h side-by-side test of Haiku 4.5 on
// the narrow AI jobs before any of them is switched off Sonnet. The
// 2026-09-08 fleet-wide Haiku switch was never validated and preceded a
// click collapse (see narrativeCaption.ts's MODEL comment), so this time the
// decision is made from measured agreement, not assumed.
//
// Shadow only: the Sonnet answer is always the one the pipeline uses. The
// shadow call runs after the primary call has returned, is never awaited by
// the caller, and any failure in it is swallowed. It logs one `AI_SHADOW`
// line per comparison and records its spend under `shadow_<tag>`.
//
// A slice of shadow calls uses Sonnet itself as the shadow model — these
// prompts run at temperature 0.3-0.8, so Sonnet doesn't always agree with
// itself, and Haiku's agreement rate only means something next to that
// baseline.
//
// Switches itself off at SHADOW_UNTIL, so it can't keep spending if nobody
// removes it.
import { fetchWithTimeout } from "./httpUtil";
import { isDailyBudgetExceeded, recordGatewaySpend } from "./aiGatewayBudget";

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
export const HAIKU_MODEL = "anthropic/claude-haiku-4-5";
const SONNET_MODEL = "anthropic/claude-sonnet-4-5";
const SHADOW_UNTIL = Date.parse("2026-10-01T06:00:00Z");
const SHADOW_SAMPLE = Number(process.env.AI_SHADOW_SAMPLE ?? 0.3);
const SONNET_BASELINE_SHARE = 0.2;

export function shadowActive(): boolean {
  return Date.now() < SHADOW_UNTIL && Math.random() < SHADOW_SAMPLE;
}

interface ShadowRequest {
  tag: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens: number;
  temperature: number;
  primaryAnswer: string;
  // Reduces a raw model reply to the one decision being compared, e.g. the
  // `coherent` boolean or the chosen layout name.
  decide: (raw: string) => string;
  detail?: string;
  extra?: Record<string, string>;
}

export async function callGatewayRaw(model: string, messages: ShadowRequest["messages"], maxTokens: number, temperature: number, tag: string): Promise<string> {
  const apiKey = process.env.VERCEL_AI_GATEWAY_KEY;
  if (!apiKey) throw new Error("no gateway key");
  if (await isDailyBudgetExceeded()) throw new Error("AI gateway daily budget exceeded");
  const res = await fetchWithTimeout(
    GATEWAY_URL,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
    },
    45_000
  );
  if (!res.ok) throw new Error(`AI gateway ${res.status}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { cost?: number } };
  recordGatewaySpend(json.usage?.cost, tag);
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("no text content");
  return content;
}

function clean(raw: string): string {
  const t = raw.trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return m ? m[1].trim() : t;
}

export function jsonField(field: string): (raw: string) => string {
  return (raw) => {
    try {
      return String(JSON.parse(clean(raw))?.[field]);
    } catch {
      return "UNPARSEABLE";
    }
  };
}

export function runShadow(req: ShadowRequest): void {
  const model = Math.random() < SONNET_BASELINE_SHARE ? SONNET_MODEL : HAIKU_MODEL;
  const label = model === HAIKU_MODEL ? "haiku" : "sonnet_baseline";
  void callGatewayRaw(model, req.messages, req.maxTokens, req.temperature, `shadow_${req.tag}`)
    .then((raw) => {
      const primary = req.decide(req.primaryAnswer);
      const shadow = req.decide(raw);
      const extra = Object.entries(req.extra || {}).map(([k, v]) => ` ${k}=${v}`).join("");
      console.error(
        `AI_SHADOW tag=${req.tag} model=${label} primary=${primary} shadow=${shadow} agree=${primary === shadow ? 1 : 0}${extra}${req.detail ? ` detail=${JSON.stringify(req.detail.slice(0, 160))}` : ""}`
      );
    })
    .catch(() => {});
}

// The code-only candidate for the coherence check's third failure mode (a
// headline ending on a word that needs something after it). Logged next to
// each coherence comparison so the rule's agreement with Sonnet is measured
// too; nothing acts on it.
const DANGLING_LAST_WORDS = new Set([
  "a", "an", "the", "of", "to", "for", "with", "as", "at", "by", "from", "into", "onto", "and", "or", "but", "nor",
  "if", "that", "than", "his", "her", "their", "its", "my", "our", "your", "he", "she", "they", "we",
  "is", "was", "are", "were", "will", "would", "could", "should", "can", "has", "have", "had",
]);
export function danglingEndingRule(headline: string): "reject" | "pass" {
  const last = (headline.trim().split(/\s+/).pop() || "").replace(/[.!?,;:")\]”]+$/u, "");
  if (/['’]s$|s['’]$/iu.test(last)) return "reject"; // possessive with nothing after it
  const bare = last.replace(/^['"“‘(]+|['"’]+$/gu, "").toLowerCase();
  return DANGLING_LAST_WORDS.has(bare) ? "reject" : "pass";
}

// The caption shortener has no sampling: it only fires on an over-length
// first draft, which is already a small share of calls.
export function shadowWindowOpen(): boolean {
  return Date.now() < SHADOW_UNTIL;
}
