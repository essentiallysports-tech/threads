// Real narrative caption generation — a genuine Claude call via the Vercel AI
// Gateway (Anthropic under the hood), per the operator's explicit 2026-08-07
// instruction: "texts work a lot on Threads... captions should be descriptive
// and cause intrigue, not random 3-4 lines just giving the same info as the
// infographic. Captions should narrate the story." Deterministic templating
// (caption.ts's buildCaption) cannot produce real narrative prose — this is
// exactly the "separate activity whose OUTPUT still passes through checks"
// caption.ts's own header comment already anticipated. The LLM call NEVER
// posts directly; buildNarrativeCaptionText validates the result below and
// falls back to the deterministic template on any failure or violation —
// never trusted blindly, never blocks a post over caption-generation issues.

import { Candidate, PageConfig } from "./types";
import { buildCaption } from "./caption";
import { fetchWithTimeout } from "./httpUtil";

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const MODEL = "anthropic/claude-sonnet-4-5";

// Explicit engagement-bait ban — Meta/Threads demonetize this pattern, and
// it's a standing operator policy across every ES page, not specific to this
// pipeline. Genuine, specific questions tied to the real story are fine;
// generic "smash that like" style asks are not.
const ENGAGEMENT_BAIT_PATTERNS = [
  /\blike\s+(this|below|if)\b/i,
  /\bcomment\s+(below|your|if)\b/i,
  /\bshare\s+(this|with)\b/i,
  /\btag\s+(a|someone|your)\b/i,
  /\bdouble\s+tap\b/i,
  /\bsmash\s+that\b/i,
  /\breact\s+(with|below)\b/i,
  /\bfollow\s+for\s+more\b/i,
];

// ⛔ OPERATOR FIX (2026-08-19, real live incident, severe): confirmed live —
// a real post on New York Yankees Community went out with the MODEL'S OWN
// REFUSAL TEXT as the caption: "The headline and facts don't give me enough
// actual information to write a substantive post... I can't responsibly
// write a post that would require me to invent what the news actually is.
// If you have the real story... I'm happy to write it." The refusal clause
// ("I can't responsibly write...") sits mid-paragraph after explanatory
// text, not at the very start of the response — the old `^i\s+(cannot|
// can't|won't)\b` pattern is ANCHORED to the string's start, so it can only
// ever catch a refusal that's the model's very FIRST words, missing the
// far more common real shape where the model explains itself before
// declining. Removed the anchor and added the actual phrases seen in this
// live failure plus adjacent ones, so any refusal/meta-commentary anywhere
// in the response is caught, not just a refusal that opens the message.
const REFUSAL_PATTERNS = [
  /\bi\s+(cannot|can't|won't)\b/i,
  /\bas an ai\b/i,
  /\bi'm not able to\b/i,
  /\bdoesn't give me enough\b/i,
  /\bdon't have enough (information|detail)/i,
  /\bnot enough (information|detail|context) to\b/i,
  /\bi can'?t responsibly\b/i,
  /\bwithout inventing\b/i,
  /\binvent what the news\b/i,
  /\bplaceholder headline\b/i,
  /\bhappy to write (it|one|that|this)\b/i,
  /\bif you have (the|a) real (story|headline|details?|facts)\b/i,
  /\bno actual story detail\b/i,
  // ⛔ OPERATOR FIX (2026-08-19, real live incident — a refusal shaped as "this
  // input isn't real content, give me real content" got scheduled live on
  // essentiallysportsmedia and had to be emergency-deleted from Postiz before
  // publish): "The headline and details you've given me are just generic site
  // navigation text ('NFL News on Sports Illustrated - Scores, Analysis,
  // Videos'), not an actual story with facts I can write about. There's no
  // event, player, game, or detail here to cover. If you have a real headline
  // or story facts, I'm ready to write it, but I need actual content to work
  // with, not just a page title." matched NONE of the existing patterns — it
  // never says "cannot"/"as an AI"/"not enough information". The common shape
  // across this and the earlier caught refusals is the model explaining WHY
  // it won't write rather than just writing, so match that shape generically
  // instead of this exact wording (which will phrase differently next time).
  /\bnot an actual story\b/i,
  /\bjust generic\b/i,
  /\bi need actual (content|details?|facts|information)\b/i,
  /\bheadline (and|or) details? you'?ve given me\b/i,
  /\bnot just a page title\b/i,
  /\bnothing (here |)to (write|cover) (about|here)?\b/i,
  // ⛔ OPERATOR FIX (2026-08-24, real live incident, SEVERE — confirmed
  // shipped live on Dallas Cowboys Community, 2026-08-17): "I'm not seeing
  // enough concrete facts in what you've provided to write a substantive
  // post. The headline and additional detail both just say 'Dak Prescott -
  // Wikipedia', not an actual news event." matched NONE of the existing
  // patterns — "not seeing enough" isn't "doesn't give me enough" or
  // "don't have enough", and "concrete facts" isn't in the
  // information/detail/context alternation. This is the THIRD distinct
  // real wording of the same underlying refusal shape (Yankees, then
  // essentiallysportsmedia, now this) — the model keeps finding new phrasing
  // for "I'm explaining why I won't write this" faster than exact-phrase
  // patterns can be added reactively. Added both the exact phrases from
  // this incident AND two more generic meta-commentary tells (a real sports
  // caption never uses these phrases naturally, regardless of story).
  /\bnot seeing enough\b/i,
  /\bconcrete facts\b/i,
  /\bwhat you'?ve provided\b/i,
  /\bwrite a substantive post\b/i,
  /\bboth just say\b/i,
];

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function stripWrappingQuotesAndMarkdown(text: string): string {
  let t = text.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t.replace(/\*\*/g, "").replace(/^#+\s*/gm, "");
}

// ⛔ OPERATOR FIX (2026-08-10): "remove the m dashes, they scream that post
// is AI." An em/en dash as a stand-in for a period or comma is one of the
// most-cited "this was written by an LLM" tells on Threads, and the model
// reaches for it reflexively regardless of prompt instructions — a prompt
// rule alone (below) isn't reliable enough on its own. This is the
// deterministic backstop: applied to EVERY caption that ships, both the
// AI-authored path and the deterministic template fallback, so no dash ever
// survives to a live post even if the model ignores the instruction.
function stripEmDashes(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/,(\s*[.!?])/g, "$1")
    .replace(/,(\s*\n)/g, "$1");
}

function violatesPolicy(text: string, charLimit: number): string | null {
  if (!text.trim()) return "EMPTY";
  if (text.length > charLimit) return `OVER_CHAR_LIMIT:${text.length}/${charLimit}`;
  if (REFUSAL_PATTERNS.some((re) => re.test(text))) return "MODEL_REFUSAL";
  const bait = ENGAGEMENT_BAIT_PATTERNS.find((re) => re.test(text));
  if (bait) return `ENGAGEMENT_BAIT:${bait.source}`;
  return null;
}

async function callGateway(prompt: string, apiKey: string): Promise<string> {
  const res = await fetchWithTimeout(
    GATEWAY_URL,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 400,
        temperature: 0.8,
      }),
    },
    45_000
  );
  if (!res.ok) throw new Error(`AI gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`AI gateway returned no text content: ${JSON.stringify(json).slice(0, 300)}`);
  return stripEmDashes(stripWrappingQuotesAndMarkdown(content));
}

function buildPrompt(candidate: Candidate, page: PageConfig, athleteNames: string[], charLimit: number, retryNote?: string): string {
  const voice = page.threads?.caption_voice_mode || "fan";
  const voiceInstruction =
    voice === "brand"
      ? "an editorial sports outlet's account — confident, informed, slightly detached"
      : "a genuinely obsessed fan account for this team/sport — casual, opinionated, in the trenches with the fanbase";
  // ⛔ LEARNING PORTED (2026-08-08, ES_Threads_Automation_Playbook.md Section
  // 7): "Replies are the most powerful ranking signal — every caption must
  // force a reply." Section 6 splits this by voice: the brand account (ES
  // Main) closes on a genuine DEBATE QUESTION that forces a reader to pick a
  // side; fan accounts close on a strong DECLARATIVE "stand" — a real
  // opinion, not a question ("This dude is built different fr 🔥", not "Do
  // you think he's good?"). Applied here across every page via the existing
  // caption_voice_mode field, not just the accounts the old routine covered.
  const replyForcingInstruction =
    voice === "brand"
      ? `must end on a genuine DEBATE QUESTION that forces the reader to take a side — a real, specific question tied to this exact story, never a generic "thoughts?"`
      : `must end on a strong DECLARATIVE TAKE, not a question — a real opinion stated as fact, in this account's own voice, that a reader will want to argue with or co-sign in the replies`;

  // ⛔ OPERATOR FIX (2026-08-12, real live incident): a p54 (Conor McGregor
  // fanpage) post shipped with the injury backwards — the real headline
  // ("Max Holloway reveals what Conor McGregor said to him after injuring
  // knee at UFC 329") has genuinely ambiguous gerund-clause grammar with no
  // real article body available (web_search candidates carry no real page
  // content, just title+URL — see webSearch.ts), and the model guessed the
  // wrong subject for who actually got hurt. The page's OWN registered
  // page_theme already has the correct ground truth ("his [McGregor's]
  // first-round TKO loss to Holloway at UFC 329, the resulting knee
  // injury") sitting unused in the registry the whole time — passing it in
  // gives the model real grounding to resolve exactly this kind of
  // ambiguous-headline entity-role confusion instead of guessing.
  const facts = [
    `Headline: ${stripHtml(candidate.headline)}`,
    candidate.rawText ? `Additional detail: ${stripHtml(candidate.rawText)}` : null,
    athleteNames.length > 0 ? `Key people/teams involved: ${athleteNames.join(", ")}` : null,
    page.page_theme ? `Established background on this page's ongoing storyline (use this to correctly resolve who did what to whom if the headline is ambiguous — this is real, verified context, not something to add new claims from): ${stripHtml(page.page_theme)}` : null,
    `Source: ${
      candidate.source === "beehiiv_newsletter"
        ? "our own newsletter"
        : candidate.source === "es_article"
        ? "our own published article"
        : candidate.source === "web_search"
        ? "a real news article found via search"
        : candidate.source === "social_search"
        ? "a real social media post (Reddit/X) found via search"
        : candidate.source === "evergreen_search"
        ? "a real news article found via search"
        : candidate.source === "beehiiv_poll"
        ? "a real poll our own newsletter already asked its readers — the headline IS the real question, don't invent a result or outcome, frame this as inviting Threads readers to weigh in the same way"
        : "a news story"
    }`,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    `Write a Threads post (the main post, not the reply) for a sports fan page, voiced as ${voiceInstruction}.`,
    ``,
    // ⛔ OPERATOR FIX (2026-08-12): "we are not creating for random masses
    // but for fans, who know the basics... make sure the posts entice
    // fans, not a generic experience." The audience already knows who
    // this player/team is, their recent form, their role — writing like
    // you're introducing them to a stranger is exactly the flat, generic
    // tone that fails to entice someone who already follows this closely.
    // The curiosity gap has to be pitched AT that existing knowledge (an
    // insider angle, a detail even a close follower hasn't clocked yet),
    // not a 101-level recap of things this audience already has.
    `Your reader is a real, engaged fan of this team/sport — they already know who this player is, the team's current situation, and the recent context. NEVER explain basics they already know (who someone is, what their role is, generic background) — that reads as written for a stranger, not a fan, and instantly feels generic. Write like you're talking to someone already in the conversation, not introducing the topic to them.`,
    ``,
    `Here are the ONLY facts you know about this story — do not invent any detail, quote, number, or context beyond what's given:`,
    facts,
    ``,
    `Before writing: if the headline's grammar leaves it unclear WHO did an action or WHO an injury/quote/event actually happened to (e.g. an unclear pronoun or an unattributed gerund clause), do not guess — resolve it using the background context above if it's given, and if it's still genuinely unclear, write around that specific detail rather than risk assigning it to the wrong person. Getting a real event backwards (who got hurt, who said what to whom) is a worse error than leaving a detail out.`,
    ``,
    // ⛔ OPERATOR FIX (2026-08-19, real live incident): "we can create at
    // least 100 posts from [the same 65 relevant ES articles] presenting
    // them from different angles/narratives." sourceFromEsArticles now
    // emits a second candidate per article carrying one of these angles —
    // this is what actually makes it a DIFFERENT post rather than a
    // reworded duplicate of whatever angle the base candidate already used.
    candidate.angle
      ? `ANGLE FOR THIS SPECIFIC POST: ${
          candidate.angle === "stat"
            ? "Lead with the sharpest concrete number/stat in the facts above (a record, a streak, a comparison figure) as the hook — this post's whole angle is the number, not a general recap."
            : candidate.angle === "debate"
            ? "Frame this as a genuine fan debate — what's the real disagreement or split reaction this story would cause among fans? Lead with that tension, not a neutral recap."
            : candidate.angle === "comparison"
            ? "Frame this against a real, relevant point of comparison implied by the facts (a rival, a past season, a similar past event) — the hook is how this stacks up, not the event in isolation."
            : "Frame this around why it actually matters beyond the moment itself — the real longer-term stake or consequence implied by the facts, not just what happened."
        } This is a real ES article that may already have another post covering it from a different angle elsewhere — this one must read as genuinely distinct, not a reworded copy, so commit fully to this specific angle rather than defaulting back to a generic recap.`
      : null,
    ``,
    // ⛔ OPERATOR FIX (2026-08-13, real live incident): a real WNBA post
    // wrote "Project B dropped new eligibility rules... the entire pipeline
    // into the W" — "Project B" is the internal name of a specific WNBA/
    // WNBPA CBA proposal, not an independent organization capable of
    // "dropping" anything on its own. Framing a named internal program/
    // proposal/initiative as the one taking the action, instead of the real
    // organization behind it, misattributes agency — same category of error
    // as getting an injury/quote backwards above, just at the organization
    // level instead of the person level.
    `Before writing: if the facts reference a named internal program, proposal, framework, or initiative (e.g. a labeled CBA proposal, a codenamed policy) that belongs to a real organization (a league, team, union), attribute the actual action to that real organization — write "the WNBA is proposing..." or "under the WNBA's [name] framework...", never "[name] dropped new rules" as if the codenamed proposal itself is the one acting. A named internal program is a label for a policy, not a separate entity that can do anything on its own.`,
    ``,
    // ⛔ OPERATOR FIX (2026-08-13, real live incident): a real post opened
    // "This one's tricky because the headline is pure WNBA but our page is
    // Lakers through and through... not our lane... we're staying in our
    // world on this one" — the model noticed the background context (this
    // page's own theme) didn't match the story and, instead of just
    // writing the post, wrote ABOUT the mismatch. That candidate should
    // never have reached this prompt at all (fixed upstream), but this
    // instruction is real defense-in-depth: NEVER let a future edge case
    // produce this same self-referential, "let me address why this is
    // weird" register — a reader should never see the account talking
    // about its own selection process, uncertainty, or lane.
    `NEVER write ABOUT this page, its usual focus, or whether this story "belongs" here — never say things like "this isn't our lane," "we're staying in our world," "this one's tricky," "not sure why we're covering this," or any version of that. If the facts given to you don't obviously fit this page's usual subject, that's not something to comment on — just write the real story directly and confidently, the way any of this page's normal posts would. The account should never sound uncertain about what it's allowed to post.`,
    ``,
    // ⛔ OPERATOR REVERSAL (2026-08-12): "same account, same reach — the
    // quality of post is the reason our link clicks are so low." Real
    // manual posts on these SAME accounts are self-contained (fact →
    // context → one genuine closing line, nothing withheld) and get real
    // clicks; ours mandated a hook that can't restate the headline, a
    // DELIBERATELY incomplete story, and a forced reply-bait cliffhanger —
    // every post, regardless of whether the facts actually support a real
    // second beat. Operator's explicit call: hybrid, not a full reversal.
    // Most real stories are ONE complete event with nothing distinct left
    // to reveal — write those as a complete, self-contained post, the way
    // a real editorial account would. Reserve the withhold-for-reply
    // technique for the genuinely rarer case where the facts contain an
    // actual separate, specific detail (a real quote, a distinct number,
    // a named follow-up) worth holding back — never invent one just to
    // justify a cliffhanger.
    // ⛔ OPERATOR REVERSAL (2026-08-22, real data): the 2026-08-12 change
    // above assumed real manual posts on these same pages are "self-
    // contained, nothing withheld." Direct evidence from actual manual
    // SocialPilot posts on a live comparable account (Ohio State) shows the
    // opposite — nearly every manual post with a real article link ends on
    // an explicit open question ("What did he say?" / "What happened?" /
    // "How did it get to this point?") immediately before the link, never
    // answering it in the caption itself. A caption that already tells the
    // whole story removes the only reason left to tap the reply. Operator's
    // call: for any post pointing at a real specific article (not a generic
    // newsletter subscribe link, where there's no specific payoff to
    // withhold in the first place), make STRUCTURE B the default — hold
    // back one real detail — and reserve STRUCTURE A for the rare story
    // that's genuinely one atomic fact with nothing else in the given facts
    // to separate out. Subscribe-context posts are unaffected: there's no
    // single specific article being teased, so withholding doesn't apply —
    // STRUCTURE A stays the only option there, same as before.
    candidate.linkContext === "subscribe"
      ? `This post points to our newsletter, not one specific article — there's no single held-back fact to tease. Always use STRUCTURE A below.`
      : `Before structuring this: does the story have ANY specific quote, number, or detail in the facts above that isn't the single headline fact itself? If there is even one such detail, hold it back and use STRUCTURE B — this is the default for a story with a real article link, because a caption that already answers the story gives the reader no reason left to open the link. Only use STRUCTURE A when the facts are genuinely one atomic fact with nothing else given to separate out.`,
    ``,
    `STRUCTURE A — COMPLETE POST (${candidate.linkContext === "subscribe" ? "use this" : "use only for a single atomic fact with no separable detail"}):`,
    // ⛔ OPERATOR FIX (2026-08-24, real live incident, severe): confirmed
    // live via a 197-post sample — 39% of real hooks contain "just", 17%
    // strictly match "[Name] just [past-tense verb]" ("Wagner just put
    // Scottie...", "Harden just hit...", "Campbell just put Goff..."),
    // "said the quiet part out loud" recurred 8x across 4 pages, "hits
    // different" 12x across 9 pages — none of these phrases are even IN
    // the two examples below, confirming this is the base model's
    // unconstrained default reflex, not something the (too-thin) examples
    // caused. Same root problem as the cliffhanger beat (already fixed):
    // this beat had NO anti-repetition rule at all. Added one plus banned
    // the exact recurring phrases.
    `1. HOOK (1 line) — a genuine angle on the story, not a flat restatement of the headline. Doesn't need to be dramatic (not every story is), but it should give the reader something the headline alone doesn't — the stakes, the "why this matters" angle, or the specific human detail.`,
    `   HARD RULE: never open with "[Name] just [verb]" — that shape alone accounts for a large share of this account network's recent hooks and is an obvious tell. Also never use "said the quiet part out loud" or "hits different" — both are already overused network-wide. Vary the OPENING WORD/shape every time: sometimes lead with the stakes, sometimes a scene, sometimes a real number, sometimes a direct claim — never the same recognizable skeleton twice in a row.`,
    `2. THE FULL STORY (2-3 short paragraphs, conversational, NOT a copied or lightly-reworded headline) — tell the WHOLE story using everything genuinely available in the given facts, including the specific detail/quote/number if there is one. Nothing held back. First part: what actually happened. Second part: why it matters / the real context or consequence. Write it the way you'd actually tell a friend the news — direct, complete, no artificial suspense.`,
    // ⛔ OPERATOR FIX (2026-08-24): confirmed live — a real post closed "Some
    // legacies set impossible standards," a near-verbatim lift of this
    // line's own second example. Same too-few-examples cause as the
    // cliffhanger beat's already-fixed bug.
    `3. CLOSING LINE (1 short line) — a genuine editorial reaction to what you just told them: an opinion, an observation, or a real open question the story raises (not one you're pretending to withhold — a real one). This is NOT a cliffhanger; the story is already told. Never write a close paraphrase of "[Something] speaks/sets/measures [an abstraction] standards" — that exact shape has already leaked into real output. Vary the shape: sometimes a plain opinion, sometimes a real question, sometimes just letting the fact stand with no commentary at all. Then close with a short, honest CTA line pointing at the reply${
      candidate.linkContext === "subscribe" ? " (our newsletter, not this exact story — see the honesty rule below)" : ""
    }.`,
    ``,
    `STRUCTURE B — TWO-PART (${candidate.linkContext === "subscribe" ? "not used for subscribe-context posts" : "the default for a story with a real article link — use this whenever there's any separable detail"}):`,
    `1. HOOK (1 line) — same bar as Structure A.`,
    `2. THE STORY (1-2 short paragraphs) — the core of what happened, everything EXCEPT that one specific held-back detail.`,
    // ⛔ OPERATOR FIX (2026-08-24, real live incident, severe): confirmed
    // live across the ENTIRE network — pulled every real post published in
    // one day and nearly all of them used the identical "But/And [the
    // detail]? That's the part that [verb phrase]" skeleton, just with
    // different words swapped in ("...that hits different" / "...that's
    // getting everyone fired up" / "...that reframes this whole matchup").
    // Root cause: this instruction's own two examples both shared that
    // exact skeleton ("But what he said right after IS THE PART nobody's
    // talking about yet" / "And there's one number... THAT CHANGES the
    // whole read") — with only one real shape demonstrated, the model
    // treated it as THE template rather than as one example among many, and
    // reproduced it near-verbatim across dozens of unrelated pages and
    // subjects in the same run. A reader who sees more than one of these
    // (any real follower) immediately recognizes the formula, which reads
    // as obviously AI-generated — directly costing the trust that both
    // likes and click-through depend on. Real manual posts never repeat one
    // fixed sentence shape this way (confirmed via direct comparison this
    // session). Six structurally DIFFERENT examples below, not six wordings
    // of one shape — a flat statement, a question, a fragment, a direct
    // address, an understatement, a blunt CTA-only close — specifically so
    // there's no single skeleton left to converge on.
    `3. CLIFFHANGER + REPLY HOOK (1-2 lines) — tease the ONE real, specific detail you're deliberately not explaining yet, then ${replyForcingInstruction}. Give nothing away in the tease itself, and never invent a tease for a detail that isn't real.`,
    `   HARD RULE: never write this beat as "[the detail]? That's the part that [reaction]" or any close paraphrase of that shape — that exact skeleton has already been used across most of this account network's recent posts and reads as an obvious template the moment a reader sees two of them. Pick a genuinely different sentence shape each time. Examples showing DIFFERENT shapes, not different wordings of one shape:`,
    `   - Flat statement: "He didn't stop there."`,
    `   - Real question: "So what actually changed his mind?"`,
    `   - Trailing fragment: "Except that's not where it ends."`,
    `   - Direct address: "You're not ready for what he said next."`,
    `   - Understatement: "There's a number in here most people are going to miss."`,
    `   - Skip the tease line entirely and let the CTA below do the work: go straight from the story to "Full story's in the reply."`,
    // ⛔ OPERATOR FIX (2026-08-24): same convergence problem as the
    // cliffhanger beat above — real network output showed "Full story in
    // the reply" / "Full breakdown in the reply [below/👇]" repeated almost
    // verbatim across nearly every post. Same fix: explicit variety.
    `4. CTA (1 short line) — point at the link in the reply, tied to what's specifically waiting there. Vary the phrasing every time — do not default to "Full story/breakdown in the reply." Rotate through genuinely different phrasings, e.g.: "It's in the reply." / "Reply's got the rest." / "Tap the reply for the actual answer." / "Details are one tap away." / or skip a separate CTA line entirely when the cliffhanger line above already makes it obvious to check the reply.`,
    ``,
    candidate.linkContext === "subscribe"
      ? // ⛔ OPERATOR FIX (2026-08-11): "the CTA is just subscribe for more...
        // people wouldn't just subscribe till they're given a better bait."
        // The honesty constraint (never claim the reply covers THIS exact
        // story) stays — that's a real fabrication rule, not the problem.
        // ⛔ OPERATOR CORRECTION (2026-08-12, same day, caught before this
        // shipped wide): the first fix over-corrected into a NEW
        // fabrication risk — "we break down every one of these late-race
        // calls in the newsletter" is a specific claim about the
        // newsletter's own editorial content that nothing here actually
        // knows is true. "Only be used when we actually have that in our
        // newsletter, else not okay" — same rule as everywhere else in
        // this pipeline: specificity is only allowed when it's a
        // VERIFIABLE fact, never an invented-but-plausible-sounding one.
        // The one thing genuinely known and verifiable here is the
        // story's own topic/entity (it's literally what was just written
        // about) — so tie the pitch to THAT, never to a claim about what
        // the newsletter specifically covers.
        `CTA honesty rule (applies to whichever structure you used): the link in the reply is NOT this specific story, it's our newsletter — do not claim "full story in the reply" or imply the reply covers this exact story, that would be misleading. Make it a genuine reason to tap, not a flat command, by naming the SPECIFIC entity/team/topic this story is genuinely about (that's a real, known fact — it's what you just wrote about) — e.g. "Want more on Bell's title push? That's exactly our newsletter's lane." NEVER invent a specific claim about what the newsletter itself covers or how often ("we break down every one of these," "we cover this every week") unless that's a fact actually given to you — you don't know the newsletter's own content, only this story's topic. Vary the phrasing every time; never default to the same template sentence twice.`
      : `CTA honesty rule (applies to whichever structure you used): point at the link in the reply, tied to what's specifically waiting there. E.g. "(Full story in the reply below)" style — but only if Structure B's held-back detail is genuinely IN that reply; for Structure A, phrase it as more/related coverage since you already told the whole story.`,
    ``,
    // ⛔ OPERATOR FIX (2026-08-12, real live incident): live logs showed
    // this prompt's own text repeatedly overshooting the hard limit by
    // 100-180 characters across 3 full retries before falling back — "aim
    // for 6-7 lines" and "the char limit is non-negotiable" were fighting
    // each other, wasting real LLM round-trips inside the fixed run
    // budget. Giving a concrete character TARGET below the hard limit
    // (not just "stay under X") gives the model actual margin to work
    // with instead of writing to the edge and overshooting.
    `Formatting: aim for roughly 6-7 lines total across these four moves (a real, substantive post, not a 3-line skeleton) — but NEVER pad with filler or repeat yourself just to hit a line count. If the given facts genuinely don't support that much substance, a shorter, honest post beats a padded one. Target around ${Math.round(charLimit * 0.8)} characters total — leave real margin below the ${charLimit}-character hard limit, don't write to the edge and risk going over. That hard limit is non-negotiable and takes priority over hitting 6-7 lines — write tighter sentences rather than overflow it; a well-edited 5-line post beats a 7-line post that gets discarded for going over.`,
    `Use short paragraphs with a blank line between each of the four moves — never one dense wall of text.`,
    `- Do NOT ask people to like, comment, share, tag someone, double-tap, or react — that's banned engagement-bait, not a genuine hook.`,
    `- Never invent a detail, quote, or number not in the facts above just to make the post feel more substantive — a true, well-chosen detail from the real facts beats a fabricated dramatic one.`,
    `- Never reveal in the CTA/cliffhanger something you already fully explained in move 2 — the whole point is an open loop, not a redundant recap.`,
    // ⛔ OPERATOR FIX (2026-08-10, real live incident): an Angel Reese post
    // spelled out the exact record ("fastest to reach 70 career double-
    // doubles... beating Tina Charles's old record by 25 games") in the
    // caption text, and the on-image card ALSO showed those same numbers —
    // so nothing was left unknown, and no one had a real reason to tap the
    // reply. If the headline's core fact IS a specific number/stat/record,
    // that exact figure is what the accompanying infographic exists to
    // show — the caption's job is to sell the emotional weight of it, not
    // re-print the number a second time.
    `- If the story's core fact is a specific number, stat, or record (a milestone reached, a record broken, a stat line), do NOT spell out that exact figure in your text — assume the reader can already see it on the card. Reference the achievement qualitatively ("she just broke a WNBA record nobody saw coming") and save the actual number/detail for the reply — that number IS the reason to tap through, so give it away and there's nothing left to click for.`,
    `- Plain text only. No markdown, no hashtags, no emoji spam (one or two is fine if it fits the voice).`,
    `- Never use em dashes (—) or en dashes (–) anywhere in the text — that's a well-known "this was written by AI" tell on Threads. Use a period, comma, colon, or "and" instead.`,
    `- Hard limit: ${charLimit} characters total, including spaces — use as much of that space as the real facts support.`,
    retryNote ? `\nIMPORTANT — your previous attempt failed because: ${retryNote}. Fix that specifically.` : "",
    ``,
    `Output ONLY the caption text, nothing else — no preamble, no explanation.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface NarrativeCaptionResult {
  text: string;
  usedFallback: boolean;
  violation?: string;
}

// Falls back to the deterministic template (never throws, never blocks a
// post) on: missing API key, any gateway/network error, or the model's
// output failing policy checks twice in a row.
export async function buildNarrativeCaptionText(
  candidate: Candidate,
  page: PageConfig,
  athleteNames: string[]
): Promise<NarrativeCaptionResult> {
  const apiKey = process.env.VERCEL_AI_GATEWAY_KEY;
  const charLimit = page.threads?.char_limit || 500;
  // Sanitized too, not just the AI path — a real headline pulled verbatim
  // into the deterministic template (buildCaption's part1) can itself
  // contain an em/en dash from the source article title.
  const fallback = stripEmDashes(buildCaption(candidate, page));

  if (!apiKey) return { text: fallback, usedFallback: true, violation: "NO_API_KEY" };

  let retryNote: string | undefined;
  let lastOverLimitText: string | null = null;
  // ⛔ OPERATOR FIX (2026-08-12, real live incident): was 3 attempts. Live
  // logs (p58/p60, 2026-08-12 10:00Z run) showed char-limit overshoot
  // failing 2-3 attempts in a row before the deterministic trimToFit
  // recovery below ever ran — that's 2-3 full LLM round-trips wasted per
  // affected candidate, inside a fixed 20-min run budget, for a case that
  // already has a real, working fallback. 2 attempts (one real retry with
  // the exact-overage feedback) then trim: same quality outcome, less
  // wasted time.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const prompt = buildPrompt(candidate, page, athleteNames, charLimit, retryNote);
      const text = await callGateway(prompt, apiKey);
      const violation = violatesPolicy(text, charLimit);
      if (!violation) return { text, usedFallback: false };
      if (violation.startsWith("OVER_CHAR_LIMIT")) lastOverLimitText = text;
      retryNote =
        violation.startsWith("OVER_CHAR_LIMIT")
          ? `your last attempt was ${violation.split(":")[1]} characters, ${text.length - charLimit} OVER the ${charLimit} limit — cut a full sentence or trim the story section, don't just shorten word choices`
          : `your last attempt violated: ${violation} — fix that specifically`;
      console.error(`buildNarrativeCaptionText: attempt ${attempt + 1} violated policy (${violation}) for ${page.page_id}`);
    } catch (e) {
      console.error(`buildNarrativeCaptionText: attempt ${attempt + 1} failed for ${page.page_id}: ${(e as Error).message}`);
    }
  }

  // ⛔ OPERATOR FIX (2026-08-07): the model overshot the limit on every one
  // of 3 attempts on real live pages (p45, p47) despite exact-overage retry
  // feedback — discarding the whole narrative caption for the old generic
  // template every time it runs a little long throws away real quality for
  // a fixable formatting problem. One last deterministic trim: real
  // narrative content beats a templated fallback, as long as trimming can
  // still produce a genuinely coherent, non-truncated-mid-sentence result.
  if (lastOverLimitText) {
    const trimmed = trimToFit(lastOverLimitText, charLimit);
    if (trimmed) return { text: trimmed, usedFallback: false, violation: "TRIMMED_AFTER_RETRY" };
  }

  return { text: fallback, usedFallback: true, violation: "FAILED_AFTER_RETRY" };
}

// Preserves the CTA line (always the last non-empty paragraph) and trims
// preceding paragraphs to the last complete sentence that fits — never
// cuts mid-sentence, matching the same completeness rule as extractQuotedPhrase
// in activities/index.ts. Returns null if even the CTA alone can't fit
// (pathological case — let the caller fall back to the template).
function trimToFit(text: string, charLimit: number): string | null {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  if (paragraphs.length === 0) return null;
  const cta = paragraphs[paragraphs.length - 1];
  const body = paragraphs.slice(0, -1);
  const budgetForBody = charLimit - cta.length - 2; // 2 chars for the blank-line separator
  if (budgetForBody <= 0) return null;

  const kept: string[] = [];
  let used = 0;
  for (const para of body) {
    const remaining = budgetForBody - used - (kept.length > 0 ? 2 : 0);
    if (remaining <= 0) break;
    if (para.length <= remaining) {
      kept.push(para);
      used += para.length + (kept.length > 1 ? 2 : 0);
      continue;
    }
    // Doesn't fully fit — cut this paragraph at the last complete sentence
    // that does, then stop (never include a further, even-shorter paragraph
    // after truncating one, to avoid a disjointed result).
    const sentenceEnd = /[.!?]\s/g;
    let lastGoodCut = -1;
    let m: RegExpExecArray | null;
    while ((m = sentenceEnd.exec(para))) {
      if (m.index + 1 <= remaining) lastGoodCut = m.index + 1;
      else break;
    }
    if (lastGoodCut > 0) kept.push(para.slice(0, lastGoodCut).trim());
    break;
  }
  if (kept.length === 0) return null;
  return [...kept, cta].join("\n\n");
}
