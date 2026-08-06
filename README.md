# ES Threads Automation — Temporal (deterministic replacement)

This replaces the old `ES-Threads-Automation-Skill-v1.md` prose skill file — a
document an AI Routine was *supposed* to follow — with real code: a Temporal
workflow and a set of activities. Every rule that used to be "the model should
remember to check this" is now an actual `if` statement in `src/lib/checks.ts`,
executed the same way every single time, with no LLM anywhere in the posting
loop.

## Architecture

- **Temporal Cloud** (namespace `es-threads.eays8`) hosts the workflow
  history/scheduling — this is the durable, replayable execution engine.
- **A Worker process** (this repo, `src/worker.ts`) — a persistent Node
  process that polls Temporal Cloud for work and actually executes the
  workflow/activity code. **Must run 24/7 somewhere** — Temporal Cloud does
  NOT run your code for you, only the server/scheduler side. Target: an EC2
  instance (see `deploy/ec2-setup.sh`).
- **`dailyRunWorkflow`** (`src/workflows/dailyRunWorkflow.ts`) — one workflow
  execution per run, iterating every active Threads page from the registry.
  Deterministic, replayable: sourcing, every check, caption-building, and the
  post call are all real function calls, not model judgment.
- **Activities** (`src/activities/index.ts`) — the I/O boundary. All network
  calls (S3, Beehiiv, Postiz, link verification) live here, per Temporal's
  own requirement that workflow code stay pure/deterministic.

## What's real right now (all individually tested live)

- ✅ Temporal Cloud connection (namespace, API-key auth) — confirmed live.
- ✅ S3 registry read (`config/page-registry/`) — confirmed live, loads the
  same 25 active Threads pages the old system used.
- ✅ Beehiiv REST client — confirmed live (`Authorization: Bearer <key>`),
  real publications and real posts returned.
- ✅ Postiz REST client — auth reuses the format confirmed live in
  `es-page-registry`'s threads-guard cron (raw key, **NO** `Bearer` prefix —
  do not "fix" this). The full posting schema (upload → thread `value[]` →
  per-post `settings`) is separately confirmed live 2026-08-06 — see
  "Known gaps" #4 for the real test post that proved it end-to-end.
- ✅ Deterministic checks (`src/lib/checks.ts`): entity/sport match,
  competitor-domain ban, per-page dedup, same-link-24h dedup, cross-page
  same-run mass-duplicate detection, link-resolves + UTM verification.
- ✅ 70/30 newsletter/shared-pool sourcing mix
  (`src/lib/sourcing.ts` + `shouldSourceFromNewsletter`).
- ✅ 8-posts-per-page-per-day cap, enforced from the real posted-log per page.
- ✅ End-to-end dry run against the real registry (`LIVE_POSTING=false`) —
  writes results to `pool/temporal_dry_run_{date}.json` on S3 for comparison
  against the old system's output. Ran clean across all 25 pages twice.
- ✅ `renderCard` (`src/lib/gemini.ts` + `src/activities/index.ts`) — real
  image generation via the direct/embedded Gemini API (chosen because
  OpenArt has NO self-serve REST API key feature, only an MCP connector,
  which a standalone Temporal worker can never reach — confirmed live
  2026-08-06 that 3/4 real candidates rendered a real card end-to-end,
  uploaded to S3 under `threads-cards/{page_id}/{key}.png`, with the
  headline/kicker/accent text on the image and no logo, per the prompt's
  explicit two-part instruction). Transient Gemini failures
  (`finishReason: IMAGE_OTHER`) are retried by Temporal's own activity retry
  policy rather than silently giving up after one try.

## Known gaps — do NOT flip `LIVE_POSTING=true` until these are closed

1. **Gemini API key prepayment credits are depleted** (confirmed live
   2026-08-06, `429 RESOURCE_EXHAUSTED`) — the embedded key used for
   `renderCard` needs credits added at https://ai.studio/projects before any
   further real renders will succeed. Everything else in the pipeline
   (sourcing, checks, link/UTM verification, caption, S3 upload, retry
   handling) is fully verified working independent of this.
2. **Rendering a candidate that names a specific real public figure can
   still fail even with credits** — confirmed live: Gemini refused
   (`IMAGE_OTHER`) across all 3 retries for one MMA candidate. The workflow
   already degrades safely to `NO_CARD_RENDER_FAILED` and drops that page's
   post rather than posting without a card — this is expected, occasional
   behavior, not a bug to chase away.
3. ~~S3 public-URL assumption for rendered cards~~ — ✅ CONFIRMED live
   2026-08-06: `GET`/`HEAD` on a real `threads-cards/` object returns 200
   with zero AWS credentials, from a plain `curl`. Postiz (or anything else)
   can fetch these URLs. No longer a gap.
4. ~~Postiz's reply-thread schema~~ — ✅ CONFIRMED live 2026-08-06. The
   original guess (`settings.replyContent`) was WRONG and has been replaced
   with the real schema (verified against docs.postiz.com/public-api and
   .../providers/threads, then proven against the live API): upload the
   card via `POST /upload` to get a real `{id, path}` (a bare external URL
   is not a valid image reference), then schedule via `POST /posts` with
   `posts[].value` as an array — `value[0]` is the main post (with the
   uploaded image), `value[1]` is the reply carrying the link — and
   `posts[].settings: {__type: "threads"}` (settings live per-post, not at
   root). A real test post (`postId cmsgklhat02bhnv0yk8uyt66h`) was
   successfully scheduled to the disconnected `nflgossips` integration using
   this exact code path. No longer a gap.
5. **Captions are templated, not AI-authored** (`src/lib/caption.ts`) — a
   deliberate tradeoff for determinism, but genuinely more formulaic than the
   old model-written captions. If you want AI-authored copy back, the correct
   way is a NEW activity that calls the Claude API directly (not an ambient
   Routine) and validates its output through the same
   `runDeterministicChecks` before anything posts — never trust it blindly.
6. **AWS permissions for EC2** — the IAM user needs `AmazonEC2FullAccess`
   (+ optionally `CloudWatchLogsFullAccess`) added before the worker can
   actually be deployed to a real instance.
7. **No `.env` secrets manager** — secrets currently live in a root-owned
   `/etc/es-threads-temporal.env` file on the worker host. Fine for a single
   box; revisit if this ever needs multiple workers or a real CI/CD pipeline.

## Running it

```bash
npm install
cp .env.local.example .env.local   # fill in real values
npm run build

# Terminal 1 — the worker (must stay running)
npm run worker

# Terminal 2 — trigger one run
LIVE_POSTING=false npx ts-node src/client.ts run-once

# Once you're happy with dry-run output over a few days:
npx ts-node src/client.ts create-schedule   # hourly, matches the old cadence
```

## On captions and "no LLM at all"

The operator directive was "completely deterministic" — this workflow has
zero LLM calls in the posting decision path: sourcing, every accuracy/dedup/
competitor check, and the post call are pure code. Caption *writing* is the
one place a real editor's creative judgment used to live. This version
templates it instead of losing determinism to get a better sentence. If
better copy matters enough to bring an LLM back in, it should be one more
activity in this same deterministic pipeline — call an LLM, then run its
output through the exact same checks everything else goes through before it
can post. Never let it back into the posting *decision* itself.
