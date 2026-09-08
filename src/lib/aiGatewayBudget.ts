// ⛔ OPERATOR FIX (2026-09-08, real live incident): a $10/day Vercel AI
// Gateway budget was blown through in a few hours (73 repair-pass-maxed
// dailyRunWorkflow executions — see that file's own fix for the root
// cause) with nothing in THIS codebase even aware a budget existed, let
// alone able to stay under it. The only enforcement was Vercel's own
// per-key cutoff, which fails every AI call open (no vision QC, no
// coherence check, no fact-check — every one of these functions is
// designed to "not block posting over an infra failure") for the rest of
// the day the instant it's hit, silently recreating the exact
// "every quality check is a no-op and nobody notices" blind spot the dead
// placeholder key already caused once today.
//
// Tracks REAL spend using the `cost` field every gateway response already
// returns (confirmed live: {"usage":{...,"cost":0.000111}}) against a
// configurable daily ceiling, deliberately set BELOW whatever the actual
// Vercel-side budget is so this graceful, loggable stop triggers first —
// same circuit-breaker shape already proven twice today (esDirect.ts's WP
// breaker, dailyRunWorkflow.ts's repair-pass breaker), applied to spend
// instead of failure count. Persisted to S3 (not in-memory) so a pm2
// restart mid-day, or the fact that the main and firehose workers are
// separate processes, can't reset or fragment the count — both need to
// see the SAME running total. Not perfectly race-free under concurrent
// writes from multiple processes (a real distributed counter is more
// machinery than a SOFT safety margin below a harder external cap
// justifies) — undercounting by a few cents on a given day is an
// acceptable trade for not adding a new shared-lock dependency.
import { getObject, putObject } from "./s3registry";

const DAILY_BUDGET_USD = Number(process.env.AI_GATEWAY_DAILY_BUDGET_USD || 8);
const SPEND_KEY_PREFIX = "pool/ai_gateway_spend_";
const REFRESH_INTERVAL_MS = 60_000; // re-check S3 (for the OTHER worker process's spend) at most once/minute — every call re-fetching would be its own waste

interface SpendRecord {
  totalUsd: number;
  callCount: number;
  lastUpdated: string;
}

let cached: { dateISO: string; record: SpendRecord; loadedAt: number } | null = null;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

async function loadTodaySpend(dateISO: string): Promise<SpendRecord> {
  const now = Date.now();
  if (cached && cached.dateISO === dateISO && now - cached.loadedAt < REFRESH_INTERVAL_MS) return cached.record;

  const raw = await getObject(`${SPEND_KEY_PREFIX}${dateISO}.json`);
  const record: SpendRecord = raw ? JSON.parse(raw) : { totalUsd: 0, callCount: 0, lastUpdated: new Date().toISOString() };
  cached = { dateISO, record, loadedAt: now };
  return record;
}

// Called at the top of every AI-gateway-calling function, before the
// network request — a call skipped here costs nothing, unlike one that
// reaches Vercel and gets rejected AFTER already being billed for whatever
// partial processing occurred.
export async function isDailyBudgetExceeded(): Promise<boolean> {
  try {
    const record = await loadTodaySpend(todayISO());
    return record.totalUsd >= DAILY_BUDGET_USD;
  } catch (e) {
    console.error(`isDailyBudgetExceeded: check failed, allowing the call through: ${(e as Error).message}`);
    return false; // can't verify — fail open on the CHECK itself, same policy as every check this guards
  }
}

// Called after a successful gateway response with its real usage.cost.
export async function recordGatewaySpend(usd: number | undefined): Promise<void> {
  if (!usd || usd <= 0) return;
  const dateISO = todayISO();
  try {
    const record = await loadTodaySpend(dateISO);
    record.totalUsd += usd;
    record.callCount += 1;
    record.lastUpdated = new Date().toISOString();
    cached = { dateISO, record, loadedAt: Date.now() };
    await putObject(`${SPEND_KEY_PREFIX}${dateISO}.json`, JSON.stringify(record));
    if (record.totalUsd >= DAILY_BUDGET_USD && record.totalUsd - usd < DAILY_BUDGET_USD) {
      console.error(`aiGatewayBudget: daily budget of $${DAILY_BUDGET_USD} crossed (now $${record.totalUsd.toFixed(4)}, ${record.callCount} calls) — further AI-gateway calls will short-circuit until ${dateISO} rolls over`);
    }
  } catch (e) {
    console.error(`recordGatewaySpend: failed to persist, spend tracking may undercount: ${(e as Error).message}`);
  }
}
