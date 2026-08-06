// Real Beehiiv REST client — confirmed live 2026-08-06: `Authorization: Bearer
// <key>` against api.beehiiv.com/v2 returns real publication + post data.

const BASE = "https://api.beehiiv.com/v2";
const KEY = process.env.BEEHIIV_API_KEY!;

async function beehiivGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
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
