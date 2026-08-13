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
