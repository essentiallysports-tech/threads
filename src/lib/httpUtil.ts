// ⛔ OPERATOR FIX (2026-08-10, real live incidents): 7 hourly-run crashes this
// morning and a 2+ hour stall this afternoon were BOTH caused by the same
// bug pattern, found independently in checks.ts and socialSearch.ts — a bare
// `fetch(url, init)` with no client-side abort/timeout. Temporal's own
// activity-level StartToClose timeout only tells the WORKFLOW to retry; it
// does nothing to cancel the real in-flight promise still running in this
// Node process, so a slow/hanging remote server (Apify, a linked article's
// origin server, an AI gateway) can leave a zombie call running indefinitely,
// blocking real forward progress and, once it finally resolves, trying to
// report a completion Temporal has already abandoned. Every fetch() call
// anywhere in this codebase should go through this instead of the bare
// global — a swept audit (2026-08-10) found 14 call sites with this exact
// gap; this is the single shared fix applied to all of them.
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ⛔ OPERATOR FIX (2026-08-29, real live incident): a multi-day OpenArt outage
// left every page simultaneously below its 5/day floor, so on recovery all 6
// shards ran repair passes for every page at once — same shape of problem as
// esMcp.ts's own 2026-08-23 incident (documented there: ~27 pages concurrent
// caused "operation was aborted" storms on that ONE shared, static-token
// endpoint), just far larger this time (41+ pages, all repair-passing at
// once instead of one entity-cap change). That fix only added timeout +
// retry, which helps transient blips but not a SUSTAINED overload — retrying
// into an already-saturated endpoint just adds more load on top of the exact
// pressure causing the failures (confirmed live: Beehiiv 429 RATE_LIMIT_EXCEEDED
// 6,000+ times, ES-MCP aborts across nearly every page, in the same window).
// A per-process concurrency limiter is the standard complementary fix for
// sustained overload: it doesn't reduce total work, it just bounds how many
// requests to ONE shared dependency are in flight at once, queuing the rest
// instead of firing them all simultaneously and having most get rejected or
// time out. Deliberately per-dependency (each caller creates its own
// limiter instance) since Beehiiv and ES-MCP have different real capacities
// — a single shared limit would either starve one or under-protect the other.
export function createLimiter(maxConcurrent: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  function release() {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  }

  return function withLimit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        fn().then(resolve, reject).finally(release);
      };
      if (active < maxConcurrent) {
        active++;
        run();
      } else {
        queue.push(run);
      }
    });
  };
}

// ⛔ OPERATOR FIX (2026-08-30, real live incident): confirmed live — Apify's
// account-wide "Monthly usage hard limit exceeded" (403,
// platform-feature-disabled) took out sourceFromTwitter AND sourceFromReddit
// simultaneously (1,292 failed calls each in one day, identical error), and
// Tavily hit an analogous per-plan usage-limit exhaustion the same week
// (sourceFromEvergreenBank). Both are HARD, non-transient vendor quota
// exhaustions — unlike a timeout or a 5xx, retrying does not help and won't
// until the vendor's own billing cycle resets, so every single page/repair-
// pass kept re-attempting a call that was never going to succeed, wasting a
// real (if individually small) network round-trip thousands of times a day
// with no visible signal beyond scattered per-call error logs. A circuit
// breaker keyed by vendor/quota-scope (not per-actor — Twitter and Reddit
// share ONE Apify account, so either one tripping protects both) skips the
// call entirely once this exact signal is seen, logs ONCE when it trips
// (not on every subsequent skip), and self-clears on the next worker
// restart — cheap to re-discover if a plan upgrade actually fixed it,
// no permanent state to remember to revert.
const circuitBreakers = new Map<string, number>(); // key -> cooldown-until epoch ms

export function isCircuitOpen(key: string): boolean {
  const until = circuitBreakers.get(key);
  return until !== undefined && Date.now() < until;
}

export function tripCircuit(key: string, cooldownMs: number, reason: string): void {
  const alreadyTripped = isCircuitOpen(key);
  circuitBreakers.set(key, Date.now() + cooldownMs);
  if (!alreadyTripped) {
    console.error(`CIRCUIT_BREAKER_TRIPPED: "${key}" disabled for ${Math.round(cooldownMs / 60_000)}min — ${reason}`);
  }
}

// Bounded-concurrency map, used where a fan-out would otherwise open an
// unbounded number of simultaneous remote calls.
//
// The shared Athena concurrency quota is account-wide, so an unbounded fan-out
// here can exhaust capacity that other consumers depend on. Callers that swallow
// their own query errors then treat a quota rejection as "no result found",
// which degrades output quality silently as well as wasting spend.
//
// Total work, result ordering and Promise.all rejection semantics are unchanged;
// only the number in flight at any moment differs.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const bound = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: bound }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
