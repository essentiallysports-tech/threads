// Real Postiz public API client. ⛔ CONFIRMED LIVE (2026-08-05, the hard way,
// during es-page-registry's threads-guard cron): this API wants the RAW key
// in the Authorization header, NO "Bearer " prefix — "Bearer <key>" returns
// "Invalid API key" even with a perfectly valid key. Do not "fix" this to
// look more standard.

import { fetchWithTimeout } from "./httpUtil";

const BASE = "https://api.postiz.com/public/v1";
const KEY = process.env.POSTIZ_API_KEY!;

async function postizFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithTimeout(
    `${BASE}${path}`,
    { ...init, headers: { Authorization: KEY, "Content-Type": "application/json", ...(init?.headers || {}) } },
    30_000
  );
  if (!res.ok) throw new Error(`Postiz ${path} -> ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface PostizIntegration {
  id: string;
  name: string;
  identifier: string;
}

export async function listIntegrations(): Promise<PostizIntegration[]> {
  return postizFetch<PostizIntegration[]>("/integrations");
}

// CONFIRMED against Postiz's real public docs (2026-08-06, docs.postiz.com/
// public-api and .../providers/threads) — NOT a guess. Our card already
// lives at a public Orshot storage URL (see lib/orshot.ts), but Postiz's
// own /upload endpoint wants raw multipart file bytes and hands back the
// {id, path} a post's image array actually needs — passing the bare card
// URL directly is not a valid image reference per their schema.
async function uploadImageFromUrl(imageUrl: string): Promise<{ id: string; path: string }> {
  const imageRes = await fetchWithTimeout(imageUrl, {}, 30_000);
  if (!imageRes.ok) throw new Error(`Fetching card image for Postiz upload -> ${imageRes.status}`);
  const blob = await imageRes.blob();
  const form = new FormData();
  form.append("file", blob, "card.png");
  const res = await fetchWithTimeout(`${BASE}/upload`, { method: "POST", headers: { Authorization: KEY }, body: form }, 30_000);
  if (!res.ok) throw new Error(`Postiz /upload -> ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ id: string; path: string }>;
}

// Schedules a real Threads post. CONFIRMED schema (2026-08-06,
// docs.postiz.com/public-api/providers/threads): settings live per-post
// (`{__type:"threads"}`, no other Threads-specific fields exist), content/
// image live inside `posts[].value[]`, and a reply-in-thread is a SECOND
// item in that same `value` array — NOT a `settings.replyContent` field,
// which was this file's previous (wrong, never-live-tested) guess.
// ⛔ CONFIRMED LIVE 2026-08-07: the response shape assumed here (`{id}` at
// the top level) was WRONG — a real live post was created correctly on
// Postiz (verified via GET /posts afterward: real post_id, correct
// content/timing/integration, state QUEUE) but this function returned
// `{id: undefined}`, which then got written into the S3 posted-log,
// degrading its dedup data. Postiz's real response for a `type:"schedule"`
// call nests the actual per-integration post(s) — the top-level object is
// NOT the post itself. Parse defensively across the shapes actually seen/
// documented rather than assuming one, and throw loudly if none match
// instead of silently returning undefined — a caller that gets a real
// error can retry or flag it; one that gets `{id: undefined}` silently
// corrupts the dedup log with no signal anything went wrong.
// ⛔ CONFIRMED LIVE 2026-08-07 (second finding, same run): the real shape is
// a TOP-LEVEL ARRAY, one entry per scheduled post, each carrying `postId`
// (not `id`) — e.g. `[{"postId":"...", "integration":"..."}]`. The object-
// shaped guesses above were kept as fallbacks in case a different call
// shape (e.g. multi-post schedule) responds differently — never remove a
// working parse path without live evidence it's wrong, only add to it.
type ScheduleResponseCandidate =
  | { id?: string; postId?: string; posts?: Array<{ id?: string; postId?: string }> }
  | Array<{ id?: string; postId?: string }>;

function extractPostId(json: ScheduleResponseCandidate): string {
  const first = Array.isArray(json) ? json[0] : json;
  const id = first?.id || first?.postId || (!Array.isArray(json) ? json.posts?.[0]?.id || json.posts?.[0]?.postId : undefined);
  if (!id) throw new Error(`Postiz schedule response had no recognizable post id: ${JSON.stringify(json).slice(0, 300)}`);
  return id;
}

export async function scheduleThreadsPost(
  integrationId: string,
  mainPostHtml: string,
  cardUrl: string | null,
  replyLinkHtml: string,
  postTimeUtc: Date
): Promise<{ id: string }> {
  const image = cardUrl ? [await uploadImageFromUrl(cardUrl)] : [];
  const json = await postizFetch<ScheduleResponseCandidate>("/posts", {
    method: "POST",
    body: JSON.stringify({
      type: "schedule",
      date: postTimeUtc.toISOString(),
      // ⛔ OPERATOR FIX (2026-08-15, real live incident, severe): confirmed
      // live — Postiz's shortLink feature shortens every reply link through
      // tinyurl.com internally, and that shortening step silently DROPS
      // utm_term (and likely other params) from the destination it
      // redirects to. Verified by resolving a real live shortlink: our own
      // buildReplyLink always builds the full, correct URL (confirmed via
      // the posted-log's own reply_url field, which has utm_term=autopost
      // every time) — but the live tinyurl redirect landed on
      // "...?utm_source=threads&utm_medium=cfb_fan_page_osu" with
      // utm_term=autopost missing entirely. Since utm_term=autopost is the
      // ONLY signal this whole pipeline's dashboards/GA4 queries use to
      // separate autopost-driven clicks from anything else under the same
      // medium, this was silently zeroing out "autopost sessions" for every
      // page using shortLink — even pages with large real reach (Ohio
      // State Wireline: 563,934 views/7d, 0 attributed autopost sessions).
      // The 2026-08-08 "always use shortLink" rule predates the
      // utm_term=autopost signal (added 2026-08-12) — it was never
      // validated against this need. Turning it off restores the full,
      // untruncated URL end-to-end; Threads auto-links a long raw URL in
      // reply text regardless, so this costs only cosmetic link length.
      shortLink: false,
      tags: [],
      posts: [
        {
          integration: { id: integrationId },
          value: [
            { content: mainPostHtml, image },
            { content: replyLinkHtml, image: [] },
          ],
          settings: { __type: "threads" },
        },
      ],
    }),
  });
  return { id: extractPostId(json) };
}

// ⛔ OPERATOR ADD (2026-08-27, "sports news daily" firehose page): unlike
// scheduleThreadsPost, which ALWAYS builds a 2-item value[] (main post +
// reply), this page posts the article link directly IN the main post body —
// an explicit operator choice, not the reply-link pattern every other page
// uses. scheduleThreadsPost has no way to omit the second value[] item
// (passing an empty replyLinkHtml would still create a real, empty-content
// reply post — untested and almost certainly wrong), so this is a genuinely
// separate function, not a parameter tweak. Same schema/auth/shortLink-off
// reasoning as scheduleThreadsPost above, just a single-item posts[].value[].
export async function scheduleSinglePostThreads(integrationId: string, postHtml: string, postTimeUtc: Date): Promise<{ id: string }> {
  const json = await postizFetch<ScheduleResponseCandidate>("/posts", {
    method: "POST",
    body: JSON.stringify({
      type: "schedule",
      date: postTimeUtc.toISOString(),
      shortLink: false,
      tags: [],
      posts: [
        {
          integration: { id: integrationId },
          value: [{ content: postHtml, image: [] }],
          settings: { __type: "threads" },
        },
      ],
    }),
  });
  return { id: extractPostId(json) };
}

// ⛔ LEARNING PORTED, NOT YET LIVE-VERIFIED (2026-08-08,
// ES_Threads_Automation_Playbook.md Section 8 "Write-Then-Delete Pattern"):
// a hashtag is appended to the caption temporarily so Threads registers the
// topic channel, then removed from the visible post right after — this
// boosts discoverability without a hashtag cluttering the final post. Real
// value, but UNLIKE every other function in this file, this endpoint/schema
// has never been confirmed against Postiz's real API (every other guess in
// this file that skipped that step turned out wrong at least once — see the
// file header and `extractPostId`'s history). `PATCH /posts/{id}` with a
// `value` array mirroring the create schema is the most likely shape per
// Postiz's public docs structure, but is a BEST GUESS. Gated behind
// `POSTIZ_HASHTAG_STRIP_VERIFIED==='true'` (default off) so this can be
// merged and reviewed without silently taking an unverified action against
// real, live Threads accounts — flip the env var only after confirming the
// real schema against a disconnected/test integration first, the same
// discipline every other Postiz call in this file was held to.
export function hashtagStripVerified(): boolean {
  return process.env.POSTIZ_HASHTAG_STRIP_VERIFIED === "true";
}

export async function stripHashtagFromPost(postId: string, integrationId: string, contentWithoutHashtag: string): Promise<void> {
  if (!hashtagStripVerified()) {
    throw new Error("stripHashtagFromPost: POSTIZ_HASHTAG_STRIP_VERIFIED is not 'true' — this schema is unverified, caller must not invoke this without explicit confirmation first");
  }
  await postizFetch(`/posts/${postId}`, {
    method: "PATCH",
    body: JSON.stringify({
      posts: [{ integration: { id: integrationId }, value: [{ content: contentWithoutHashtag }] }],
    }),
  });
}
