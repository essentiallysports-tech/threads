// Real Beehiiv REST client — confirmed live 2026-08-06: `Authorization: Bearer
// <key>` against api.beehiiv.com/v2 returns real publication + post data.

import { fetchWithTimeout } from "./httpUtil";

const BASE = "https://api.beehiiv.com/v2";
const KEY = process.env.BEEHIIV_API_KEY!;

async function beehiivGet<T>(path: string): Promise<T> {
  const res = await fetchWithTimeout(`${BASE}${path}`, { headers: { Authorization: `Bearer ${KEY}` } }, 20_000);
  if (!res.ok) throw new Error(`Beehiiv ${path} -> ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface BeehiivPost {
  id: string;
  title: string;
  status: string;
  publish_date: number; // unix seconds
  web_url: string;
  thumbnail_url: string | null;
  subject_line: string;
}

export interface BeehiivPublication {
  id: string;
  name: string;
}

export async function listPublications(): Promise<BeehiivPublication[]> {
  const res = await beehiivGet<{ data: BeehiivPublication[] }>("/publications");
  return res.data;
}

// Most-recent CONFIRMED (sent) edition for a publication — this is the real
// candidate for "70% of posts sourced directly from the newsletter": a real
// title, a real link, a real thumbnail, no fabrication risk since it's just
// describing an edition that genuinely exists.
export async function latestConfirmedPost(publicationId: string): Promise<BeehiivPost | null> {
  const res = await beehiivGet<{ data: BeehiivPost[] }>(
    `/publications/${publicationId}/posts?limit=5&status=confirmed&order_by=publish_date&direction=desc`
  );
  return res.data[0] || null;
}

// ⛔ OPERATOR BROADENING (2026-08-10): "very very comprehensive so that
// nothing is ever short of things." The 70/30 mix logic only ever needs
// the single latest edition, but a page whose entities aren't the biggest
// story in THIS week's newsletter may still be covered in a slightly older
// one — the newsletter tier shouldn't be limited to just the newest post
// when the real comprehensiveness goal is "search everything real that
// exists," not "search the one most-recent thing."
export async function recentConfirmedPosts(publicationId: string, limit = 10): Promise<BeehiivPost[]> {
  const res = await beehiivGet<{ data: BeehiivPost[] }>(
    `/publications/${publicationId}/posts?limit=${limit}&status=confirmed&order_by=publish_date&direction=desc`
  );
  return res.data;
}

export interface BeehiivPoll {
  id: string;
  name: string;
  question: string;
  status: string;
  created_at: number; // unix seconds
  poll_choices: { id: string; label: string }[];
}

// ⛔ OPERATOR DIRECTION (2026-08-12): "we would easily hit the floor even if
// we do post for all ES articles and beehiiv polls — these 2 alone across
// pages would give us 100 good posts easily." Real reader polls are exactly
// the "genuine debate question" the caption architecture already wants —
// e.g. "Will Ending His Sobriety Hurt McGregor's 2027 Comeback?" — with
// ZERO fabrication risk (it's a real question this page's own newsletter
// already asked its real readers), unlike every social_search incident this
// session. Vote counts/completions ARE available via Beehiiv but only
// through the write-up MCP tool, not the plain REST API this pipeline
// calls at runtime — confirmed live (the nested single-poll GET returns the
// same shape as the list endpoint, no votes field) — so this sources the
// real question only, framed as "our newsletter just asked readers this"
// rather than fabricating or guessing at a result. `status=published` is
// requested but NOT trusted blindly — confirmed live that a draft poll can
// still come back in a "published"-filtered response, so it's re-checked
// client-side, same defensive pattern as isTestMarkerContent elsewhere.
export async function recentPublishedPolls(publicationId: string, limit = 10): Promise<BeehiivPoll[]> {
  const res = await beehiivGet<{ data: BeehiivPoll[] }>(
    `/publications/${publicationId}/polls?limit=${limit}&status=published&order_by=created_at&direction=desc`
  );
  return res.data.filter((p) => p.status === "published");
}
