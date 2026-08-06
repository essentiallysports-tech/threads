// Real Postiz public API client. ⛔ CONFIRMED LIVE (2026-08-05, the hard way,
// during es-page-registry's threads-guard cron): this API wants the RAW key
// in the Authorization header, NO "Bearer " prefix — "Bearer <key>" returns
// "Invalid API key" even with a perfectly valid key. Do not "fix" this to
// look more standard.

const BASE = "https://api.postiz.com/public/v1";
const KEY = process.env.POSTIZ_API_KEY!;

async function postizFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: KEY, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
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
// lives at a public S3 URL (see uploadCardImage), but Postiz's own /upload
// endpoint wants raw multipart file bytes and hands back the {id, path} a
// post's image array actually needs — passing the bare S3 URL directly is
// not a valid image reference per their schema.
async function uploadImageFromUrl(imageUrl: string): Promise<{ id: string; path: string }> {
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) throw new Error(`Fetching card image for Postiz upload -> ${imageRes.status}`);
  const blob = await imageRes.blob();
  const form = new FormData();
  form.append("file", blob, "card.png");
  const res = await fetch(`${BASE}/upload`, { method: "POST", headers: { Authorization: KEY }, body: form });
  if (!res.ok) throw new Error(`Postiz /upload -> ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ id: string; path: string }>;
}

// Schedules a real Threads post. CONFIRMED schema (2026-08-06,
// docs.postiz.com/public-api/providers/threads): settings live per-post
// (`{__type:"threads"}`, no other Threads-specific fields exist), content/
// image live inside `posts[].value[]`, and a reply-in-thread is a SECOND
// item in that same `value` array — NOT a `settings.replyContent` field,
// which was this file's previous (wrong, never-live-tested) guess.
export async function scheduleThreadsPost(
  integrationId: string,
  mainPostHtml: string,
  cardUrl: string | null,
  replyLinkHtml: string,
  postTimeUtc: Date
): Promise<{ id: string }> {
  const image = cardUrl ? [await uploadImageFromUrl(cardUrl)] : [];
  return postizFetch<{ id: string }>("/posts", {
    method: "POST",
    body: JSON.stringify({
      type: "schedule",
      date: postTimeUtc.toISOString(),
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
}
