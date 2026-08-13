# Spec-authoring prompt for RSC

A reusable starting prompt for designing any RSC milestone. Every rule here was
bought with a real failure — the 2026-08-12 delete-propagation spec, written
confidently on unverified claims and reverted in `6782d88`. The postmortem is
`docs/superpowers/reviews/2026-08-13-deletion-visibility-findings.md`.

Use it by pasting the **Prompt** section below, with `<MILESTONE>` filled in.
Read it before running it. If a rule is wrong for the task at hand, change it
here first rather than ignoring it silently.

---

## Why each rule exists

| Rule | The failure it prevents |
|---|---|
| Cite a `file:line` opened this session | Four citations in a section headed "verified" pointed at blank lines and wrong functions |
| Never describe a proposed function as existing | `recentDeletions` — a function invented in the spec — was reported to the user as behaviour the code already had |
| Search for behaviour, not table names | Membership is a URL-prefix range query, not a members table; missing it produced an entire trust model built on the wrong anchor |
| Check callers before designing around a route | A whole phase was specced to fix `GET /post/:id`, which nothing calls |
| Verify the user-facing action exists first | Federated delete propagation was designed for an action ordinary users cannot perform in the UI |
| Establish topology before asking design questions | Four design decisions were taken before discovering instances federate by firehose, invalidating one of them |
| Every number needs a worked scenario | A cap of 25 was chosen, then found to silently drop 175 deletions in the one case that always exceeds it |
| Show subagent prompts before dispatch | Three agents ran on prompts the user never saw, and their findings were relayed unverified |
| Durable docs hold conventions, not findings | Four open bugs were written into CLAUDE.md, which loads as authoritative and would have gone stale on the next fix |
| Don't let an external artifact set the frame | The first design was shaped by another project's privacy page rather than by RSC's code and users |

---

## Prompt

> We are designing **`<MILESTONE>`** for RSC. Follow the phases below in order.
> Do not skip ahead — most of the cost in this repo comes from designing before
> the ground truth is established.
>
> ### Non-negotiables
>
> 1. **Evidence rule.** Any claim about what the code *currently does* requires a
>    `file:line` you opened in this session. Not a memory, not a subagent's
>    report, not a previous spec's description, not a code comment you have not
>    checked against the code beneath it. If you cannot cite it, write
>    "unverified" next to it and keep going — never silently upgrade a guess.
> 2. **Proposal vs behaviour.** Anything we are going to build gets written in
>    the future tense and marked **PROPOSED**. Never say "the code already
>    handles X" about something that does not exist yet. When in doubt, grep for
>    the identifier: if it has no definition, it is proposed.
> 3. **No invented numbers.** Every window, cap, limit, or timeout must come with
>    a worked scenario showing what happens at and beyond the boundary, using a
>    realistic RSC case. If you cannot write the scenario, the number is not
>    ready.
> 4. **Subagents.** Do not dispatch one without showing me the full prompt first
>    and waiting for my go-ahead. When one reports back, verify its load-bearing
>    claims against source before relaying or acting on them; say explicitly
>    which ones you checked.
> 5. **Stop and ask** rather than theorise about anything you cannot observe —
>    live instance state, deployment state, how sources were configured. I will
>    open whatever access is needed.
>
> ### Phase 0 — Ground truth (no design yet)
>
> Produce a **facts ledger**: numbered claims about how the relevant code behaves
> today, each with its citation. Include, at minimum:
>
> - the data actually stored, and what is destroyed at each lifecycle step
> - which surfaces read it, and which of those have real callers in `web/`,
>   `mcp/`, or a feed consumer
> - every predicate governing whether something is visible/eligible/countable on
>   the paths this milestone touches — and whether they agree with each other
> - what already exists that this milestone might otherwise reinvent
>
> Then state what you could **not** determine and what would settle it.
> **Show me the ledger and stop.** I will correct it before we design.
>
> ### Phase 1 — Does the thing even work for a human?
>
> Before designing how a behaviour propagates, federates, or scales, verify the
> underlying user-facing action exists and works on one instance for one ordinary
> (non-admin, non-API-key) user. Name the exact UI path. If it does not exist,
> say so plainly — that discovery may reorder the milestone, and that is a good
> outcome, not a detour.
>
> ### Phase 2 — Journeys
>
> Walk 3–5 concrete journeys through the real topology (rsc.rmdes.be,
> alice.rmdes.be, bob.rmdes.be — they federate by polling each other's firehose
> `/users/rss.xml`). Real people holding a conversation across instances. For
> each step say what each participant **sees on screen** — timeline card, thread
> page, feed reader — today, and what would change under the design.
>
> Journeys are where a design meets reality. Anything that only makes sense in
> the abstract dies here.
>
> ### Phase 3 — Decisions
>
> Only now. Ask one question at a time, each grounded in a Phase 0 fact or a
> Phase 2 journey. Offer real options with the trade-off named, and lead with a
> recommendation and its reasoning. If a decision depends on something in the
> ledger marked unverified, verify it before asking.
>
> ### Phase 4 — Spec
>
> Write to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`. Structure:
>
> - **What exists today** — the Phase 0 ledger, citations intact
> - **Decisions** — each with the reasoning and what was rejected
> - **What we build** — every new identifier marked **PROPOSED**
> - **What could go wrong** — failure modes and how each is detected
> - **Testing** — including anything a green unit suite would not catch; this
>   repo has shipped green tests pinning wire-format bugs, so external validation
>   (e.g. valid.rss.chat) is mandatory for feed-format changes
> - **Rollout** — per instance, with what proves each step worked
> - **Open questions** — say what is unresolved rather than papering over it
>
> Before showing it to me, re-open **every** cited file and confirm the line says
> what the spec claims. Report how many citations you checked and how many were
> wrong. Do not commit until I have read it.
>
> ### Phase 5 — Review
>
> Run `/ponytail-review` on the spec, verify its findings against source before
> accepting any, and tell me which you rejected and why.
>
> ### Red flags — stop and say so
>
> - You are about to write "already handles", "already exists", or "turns out to
>   be" about something you have not opened this session
> - You are designing the propagation of something you have not confirmed a user
>   can do
> - A number appeared without a scenario
> - You are relaying a subagent's finding you have not checked
> - You are about to put a current-state observation into `CLAUDE.md` — that file
>   takes conventions and invariants only; dated findings go to
>   `docs/superpowers/reviews/`
> - An external document is setting the frame instead of this codebase

---

## Repo-specific traps

Kept current in `CLAUDE.md` under **"Establishing facts about this code"**:
subsystems that are derivations rather than tables; proposals described as
existing behaviour; routes that exist but have no consumer; one concept with two
disagreeing implementations.

Open behavioural findings live in `docs/superpowers/reviews/` and are dated —
check for a recent one covering your area before starting Phase 0.
