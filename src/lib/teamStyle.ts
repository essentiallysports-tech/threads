// (2026-10-17, operator decision) "go as close to manual as possible": on the
// same Threads accounts, the team's own posts drew 2-30x the likes per view of
// ours (Sep 14-Oct 16: Eala 2.8% vs 0.34%, Golf 0.87% vs 0.08%, Colorado 2.3%
// vs 0.07%). Their posts are 1-3 short lines in a fan's voice, with the page's
// own hashtags and almost never a "check the reply" line; ours were ~450
// characters ending on a teaser. Each page's style profile holds its best team
// posts (by likes) as examples plus how often the team uses hashtags, emoji,
// questions and a "more in the comments" line. Built offline from Postiz (team
// posts are the ones scheduled to the exact minute; ours carry random seconds)
// by scripts/build-team-style-profiles.py and stored per page in S3.
import { getObject } from "./s3registry";

export interface TeamStyleExample {
  text: string;
  likes: number;
  views: number;
  from_page: string;
}

export interface TeamStyleProfile {
  page_id: string;
  page_name: string;
  sport: string;
  // "own" when the examples are this page's own team posts; otherwise some
  // come from sister pages in the same sport (and "+tone_examples" from the
  // strongest team pages in any sport), to copy tone rather than topics.
  source: string;
  examples: TeamStyleExample[];
  hashtags: string[];
  hashtag_rate: number;
  emoji_rate: number;
  question_rate: number;
  median_chars: number;
  link_lines: string[];
  link_line_rate: number;
  // (2026-10-19) story focus from the team's own posts on this page:
  // focus_entities are names the team covers far more than we do (Kobe on
  // Kobe 8/24: team 98% of posts vs ours 42%), overused_entities ones we
  // cover far more than the team does (Shaq there: ours 71% vs team 6%).
  // sourcing.ts ranks the first ahead and the second behind; nothing is
  // filtered out.
  focus_entities?: TeamFocusEntity[];
  overused_entities?: TeamFocusEntity[];
}

export interface TeamFocusEntity {
  name: string;
  keywords: string[];
}

export function mentionsFocusEntity(text: string, entities: TeamFocusEntity[] | undefined): boolean {
  if (!entities || entities.length === 0) return false;
  const t = text.toLowerCase();
  return entities.some((e) =>
    [e.name, ...e.keywords].some((k) => {
      const kw = k.trim().toLowerCase();
      if (kw.length <= 3) return false;
      return new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(t);
    })
  );
}

const CACHE_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; profile: TeamStyleProfile | null }>();

export function teamStyleKey(pageId: string): string {
  return `config/page-registry/style/${pageId}.json`;
}

export async function loadTeamStyleProfile(pageId: string): Promise<TeamStyleProfile | null> {
  const hit = cache.get(pageId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.profile;
  let profile: TeamStyleProfile | null = null;
  try {
    const body = await getObject(teamStyleKey(pageId));
    if (body) {
      const parsed = JSON.parse(body) as TeamStyleProfile;
      // (2026-10-19) p70/p79's profiles have no hashtags (their team posts
      // never used any) and teamExtras crashed reading hashtags.length.
      if (Array.isArray(parsed.examples) && parsed.examples.length > 0) {
        profile = {
          ...parsed,
          hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
          hashtag_rate: typeof parsed.hashtag_rate === "number" ? parsed.hashtag_rate : 0,
          emoji_rate: typeof parsed.emoji_rate === "number" ? parsed.emoji_rate : 0,
          question_rate: typeof parsed.question_rate === "number" ? parsed.question_rate : 0,
          link_lines: Array.isArray(parsed.link_lines) ? parsed.link_lines : [],
          link_line_rate: typeof parsed.link_line_rate === "number" ? parsed.link_line_rate : 0,
        };
      }
    }
  } catch (e) {
    console.error(`loadTeamStyleProfile: ${pageId}: ${(e as Error).message}`);
  }
  cache.set(pageId, { at: Date.now(), profile });
  return profile;
}

// Deterministic per-post draw in [0, 1): the same candidate always gets the
// same answer (replays, retries), different posts spread across the range.
export function styleDraw(key: string, salt: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${salt}|${key}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return (h >>> 0) / 0x100000000;
}
