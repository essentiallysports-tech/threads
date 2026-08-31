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
