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
- ✅ **`renderCard` render pipeline** (`src/lib/esMcp.ts` + `src/lib/
  cloudinary.ts` + `src/lib/orshot.ts` + `src/lib/cardRegistry.ts`) — THIS IS
  THE CURRENT RENDER PATH, replacing the direct-Gemini approach entirely
  (that code is still in `src/lib/gemini.ts`, now unused/legacy). Confirmed
  live 2026-08-06, real end-to-end renders viewed and verified:
  1. **ES-MCP `search_images`** called directly over HTTP (bearer token from
     ES-MCP's own self-serve `/api/access` endpoint — no MCP session/OAuth
     needed; see `lib/esMcp.ts` for how this was obtained by reading
     `essentiallysports-tech/es-mcp`'s own source).
  2. **Cloudinary** face-crop-fills the photo to 1080x1350 (`c_fill,g_face`),
     the same transform the Facebook pipeline's render engine uses.
  3. **Orshot** renders the final card via `POST /v1/studio/render` against
     one of two verified-clean "Universal" studio templates (13948 "Version B
     Hero Card", 13949 "Standard News Card" — workspace 3924), rotated
     deterministically per candidate. Both have semantic (not
     auto-generated) parameter keys, no logo element at all, and their own
     brand-color fields (real per-sport accent hex applied, see
     `cardRegistry.ts`'s `accentColorFor`).
  All three calls are genuine portable REST — no MCP connector, no separate
  Routine, no S3 job-queue/polling (that whole design was built and then
  retired in the same session once this was confirmed possible — see git
  history if curious). `athleteNames` (which photo(s) to search for) is
  computed deterministically by the workflow (`checks.matchedEntityNames`),
  never guessed by the render step itself.
  ⛔ **`CLOUDINARY_CLOUD_NAME`/`CLOUDINARY_API_KEY`/`CLOUDINARY_API_SECRET`
  are the one deliberately-blank credential** — every other piece (Orshot,
  ES-MCP) is filled in and tested. Once those three are set, the pipeline
  needs no other code changes.
  ⛔ **Only 2 of Orshot's ~30 studio templates are wired in.** 5 pages have
  their own dedicated branded template (Cowboys Fan Station, Purple and Gold
  Pride, Forever the Fan intimidator, Ohio State Football Fan Army, Birds
  Eye Report) which would look even better, but those are 44-page templates
  with auto-generated (not semantic) slot keys — wiring them in safely needs
  per-slot role verification that wasn't done yet. The 2 Universal templates
  cover all 25 pages today with real, on-brand, professional output.
  ⛔ **`includePages` MUST be nested inside `response`** in any Orshot REST
  call (`{response: {includePages: [n], ...}}`), never top-level — confirmed
  the hard way (top-level silently renders every page of the template,
  44x the real cost, no error). See `lib/orshot.ts`'s comment before ever
  "simplifying" this back to a flat body.

## Known gaps — do NOT flip `LIVE_POSTING=true` until these are closed

1. ~~Cloudinary credentials~~ — ✅ CONFIRMED live 2026-08-06. Full pipeline
   (ES-MCP search → Cloudinary face-crop → Orshot render) run end-to-end for
   real and visually verified. The render pipeline has no remaining gaps.
2. ~~S3 public-URL assumption for rendered cards~~ — no longer applicable:
   cards now render directly to Orshot's own public `storage.orshot.com`
   URLs, never uploaded to our own S3 bucket at all (the old
   `uploadCardImage` code path has been removed).
3. ~~Postiz's reply-thread schema~~ — ✅ CONFIRMED live 2026-08-06. The
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
4. **Captions are templated, not AI-authored** (`src/lib/caption.ts`) — a
   deliberate tradeoff for determinism, but genuinely more formulaic than the
   old model-written captions. If you want AI-authored copy back, the correct
   way is a NEW activity that calls the Claude API directly (not an ambient
   Routine) and validates its output through the same
   `runDeterministicChecks` before anything posts — never trust it blindly.
5. ~~AWS permissions for EC2~~ — ✅ confirmed granted and deployed; the
   worker runs live on `i-0337259ca3e450c8d` under pm2, boot-persistent.
6. **No `.env` secrets manager** — secrets currently live in `.env.local` on
   the worker host (`/opt/es-threads-temporal/.env.local`), loaded via
   `pm2`'s `ecosystem.config.js`. Fine for a single box; revisit if this
   ever needs multiple workers or a real CI/CD pipeline.

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
