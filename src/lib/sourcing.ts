import { PageConfig, Candidate } from "./types";
import { latestConfirmedPost } from "./beehiiv";
import { isFreshEnough } from "./checks";
import { getSharedPool } from "./s3registry";

const NEWSLETTER_MIX_TARGET = 0.7; // 70% of posts sourced directly from the newsletter, per operator directive
const NEWSLETTER_MAX_AGE_HOURS = 24 * 5; // a 5-day-old "latest" edition is still a real, usable source; older falls back

// Deterministic source selection — no LLM judgment call. `todaysPostCountForPage`
// and `newsletterCountForPage` are real counts read from the posted log by the
// caller, so the 70/30 ratio is enforced against actual history, not a coin flip.
export function shouldSourceFromNewsletter(newsletterCountSoFar: number, totalCountSoFar: number): boolean {
  if (totalCountSoFar === 0) return true; // first post of the day defaults to newsletter
  const currentRatio = newsletterCountSoFar / totalCountSoFar;
  return currentRatio < NEWSLETTER_MIX_TARGET;
}

export async function sourceFromNewsletter(page: PageConfig): Promise<Candidate | null> {
  const pubId = page.threads?.beehiiv_publication_id;
  if (!pubId) return null;
  const post = await latestConfirmedPost(pubId);
  if (!post) return null;

  const candidate: Candidate = {
    source: "beehiiv_newsletter",
    key: post.id,
    subject: page.page_name,
    headline: post.title,
    link: post.web_url,
    publishedAt: new Date(post.publish_date * 1000).toISOString(),
    thumbnailUrl: post.thumbnail_url,
    rawText: post.subject_line,
  };

  if (!isFreshEnough(candidate, NEWSLETTER_MAX_AGE_HOURS)) return null; // stale edition — let the caller fall back
  return candidate;
}

// The shared T2 pool — the same file the Facebook pipeline's T_POST reads.
// Filtered to this page's own entities/sport_groups by the caller via
// runDeterministicChecks; this just returns real, unfiltered candidates.
export async function sourceFromSharedPool(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  const pool = await getSharedPool(dateISO);
  return pool
    .map((s): Candidate | null => {
      const sourceUrl = (s.source_url || s.article_url) as string | undefined;
      const headline = s.headline as string | undefined;
      const storyId = s.source_story_id as string | undefined;
      const publishedAt = (s.source_published_at as string | undefined) || new Date().toISOString();
      if (!sourceUrl || !headline || !storyId) return null;
      return {
        source: "shared_pool" as const,
        key: storyId,
        subject: (s.subject as string) || headline,
        headline,
        link: sourceUrl,
        publishedAt,
        rawText: (s.caption as string) || headline,
      };
    })
    .filter((c): c is Candidate => !!c);
}
