// Activities for the "sports news daily" firehose page — every ES article,
// every sport, posted as real headline + real link, nothing else. See
// firehoseWorkflow.ts for the orchestration. Deliberately imports only from
// lib/sourcing, lib/s3registry, lib/postiz, lib/checks, lib/caption, lib/
// types — never cloudinary/openart/renderChain/narrativeCaption, which this
// flow has no use for. Keeps this worker's dependency graph, and its
// exposure to bugs in the render/caption pipeline, at zero.

import { sourceFromEsArticles } from "../lib/sourcing";
import { getPageById, getPostedLog, appendPostedLog } from "../lib/s3registry";
import { scheduleSinglePostThreads } from "../lib/postiz";
import { politicalContentCheck, isTestMarkerContent, isPromoBettingContent } from "../lib/checks";
import { buildReplyLink } from "../lib/caption";
import { PageConfig, Candidate, PostedLogEntry } from "../lib/types";

export async function loadFirehosePage(pageId: string): Promise<PageConfig> {
  const page = await getPageById(pageId);
  if (!page) throw new Error(`loadFirehosePage: no page found for ${pageId}`);
  if (page.status !== "active") throw new Error(`loadFirehosePage: ${pageId} is not active (status=${page.status})`);
  if (!page.threads?.postiz_integration_id) throw new Error(`loadFirehosePage: ${pageId} has no postiz_integration_id`);
  return page;
}

export async function loadFirehosePostedLog(pageId: string): Promise<PostedLogEntry[]> {
  return getPostedLog(pageId);
}

// sourceFromEsArticles emits TWO candidates per real article — a base and an
// "angled" variant carrying an alternate narrative framing for the AI
// caption writer (sourcing.ts's ANGLES/pickAngle) — same real headline/link
// on both. This flow posts the real headline verbatim, so the two variants
// would render byte-identical posts: without this filter, every article
// would get posted twice, back to back, in the same run. `angle` is only
// ever set on the second (angled) variant — filtering it out leaves exactly
// one, stably-keyed candidate per real article.
export async function sourceFirehoseArticles(page: PageConfig, dateISO: string): Promise<Candidate[]> {
  const articles = await sourceFromEsArticles(page, dateISO);
  return articles.filter((c) => !c.angle);
}

export interface FirehoseCheckResult {
  candidate: Candidate;
  reason: string | null;
}

// Deliberately minimal versus the full runDeterministicChecks chain — walked
// all 12 gates against this exact page shape (unscoped, es_article-only):
// entityOrSportMatch/requiresNamedEntity both explicitly exempt it,
// isTooRecentForRetrospectivePage/isReplyTweetContent are gated on
// conditions that never apply here, isEsOwnedLink is trivially true
// (sourceFromEsArticles only ever returns real essentiallysports.com
// links), and isBareQuotedFragment/isGenericProfileFraming protect the AI
// narrative-caption/render pipeline this flow never calls. What's kept:
// permanent key-based dedup (this page must never repost an article, not
// just within a time window — mirrors sourceCandidatePoolForPage's own
// primary Set-based dedup, sourcing.ts) plus the three cheap, pure content
// gates that have real value even on trusted es_article content.
// checkAccuracy/checkTopicFrequency/checkDominantNarrative/checkDuplicateStory
// are skipped — the first is redundant (the link IS the article), the next
// two exist specifically to THROTTLE a repeated topic (opposed to
// "uncapped"), and es_article is the one source tier with a documented
// zero-incident history in this codebase (sourcing.ts).
export async function filterPostable(candidates: Candidate[], postedLog: PostedLogEntry[]): Promise<FirehoseCheckResult[]> {
  const postedKeys = new Set(postedLog.map((p) => p.key));
  return candidates.map((candidate) => {
    if (postedKeys.has(candidate.key)) return { candidate, reason: "ALREADY_POSTED" };
    if (isTestMarkerContent(candidate)) return { candidate, reason: "TEST_MARKER_CONTENT" };
    if (isPromoBettingContent(candidate)) return { candidate, reason: "PROMO_BETTING_CONTENT" };
    const political = politicalContentCheck(candidate);
    if (political.blocked) return { candidate, reason: political.reason };
    return { candidate, reason: null };
  });
}

// Real headline + real link, in the SAME post body — an explicit operator
// choice for this one page, unlike every other page's reply-link pattern.
// Link goes through buildReplyLink (caption.ts) for UTM consistency with
// the rest of the system's GA4 attribution — the destination page unfurls
// identically either way, so this doesn't change the visual outcome.
export async function buildFirehosePostText(candidate: Candidate, page: PageConfig): Promise<string> {
  const link = buildReplyLink(candidate, page) || candidate.link;
  return `${candidate.headline}\n\n${link}`;
}

export async function postFirehoseToThreads(page: PageConfig, postText: string, postTimeUtc: string): Promise<{ id: string }> {
  if (process.env.LIVE_POSTING !== "true") {
    throw new Error("postFirehoseToThreads called with LIVE_POSTING not 'true' — caller must gate on livePosting before invoking this activity");
  }
  return scheduleSinglePostThreads(page.threads!.postiz_integration_id, postText, new Date(postTimeUtc));
}

export async function recordFirehosePosted(pageId: string, entry: PostedLogEntry): Promise<void> {
  await appendPostedLog(pageId, entry);
}
