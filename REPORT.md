# Report

## Architecture

```
                 ┌─────────────────────────────────────────────────┐
                 │                    GuardedSurface                │  ← one policy chokepoint,
                 │  (allowlist · risk classification · approval)    │    shared by both callers
                 └───────────────────────┬───────────────────────────┘
                                          │
                 ┌────────────────────────────────────────────────┐
                 │                ControlledSurface                │  ← single-writer control
                 │        (rejects actions from the wrong party)   │    token: automation/human/none
                 └───────────────────────┬───────────────────────────┘
                                          │
                            ┌─────────────────────────┐
                            │   Surface (interface)    │  ← the seam. ObservedElement refs,
                            │  PlaywrightSurface (web)  │    never CSS/XPath. A desktop
                            └─────────────────────────┘    accessibility-tree adapter is a
                                                            second implementation, not a rewrite.
        ┌──────────────────────┐              ┌──────────────────────────┐
        │   DiscoveryAgent      │              │      ReplayEngine         │
        │  (LLM decides, once)  │──writes────▶ │  (no model, deterministic) │
        └──────────────────────┘   artifact   └──────────────────────────┘
                                        │                    │
                                        ▼                    ▼
                              capabilities/*.json      EvidenceRecorder (JSONL + screenshots,
                                                        redacted before anything hits disk)
```

Everything the agent or the replay engine can do to the live page passes through the
same two wrappers, composed once in `SessionHost.automationSurface()`
(`src/session/host.ts`): `GuardedSurface` (policy) around `ControlledSurface` (the
control token), around the raw `PlaywrightSurface`. There is no second path to the
browser — the CLI, the tests, and both the discovery agent and the replay engine all get
a surface from this one composition root (`src/runtime.ts`).

**The perception seam is `Surface`, not Playwright** (`src/surface/types.ts`). The model
and the replay engine both see an `Observation`: a list of `ObservedElement` (role,
accessible name, value, owning frame, bounds) each carrying an opaque `ref` like
`mainFrame#3`, plus rendered `grids` and per-frame visible text. Neither ever sees or
emits a CSS selector — `PlaywrightSurface` is the only thing in the codebase that knows
DOM exists. A desktop accessibility-tree adapter would produce the same `Observation`
shape and the artifact schema, the replay engine, and the discovery prompts would not
change at all; only a new file implementing `Surface` would be added.

**Two things never share a code path with anything else:** policy enforcement
(`GuardedSurface`) and redaction (`Redactor`, applied by `EvidenceRecorder` to every
write). Both are called from exactly one place, so a new action type or a new logging
call cannot accidentally bypass either.

## Artifact schema

The full schema is `src/schema/capability.ts` + `src/schema/common.ts`. The decisions
worth defending:

**Outcomes are a top-level sibling of `steps`, not error handling.**
`Capability.outcomes: Outcome[]` — each one is `{ id, kind, code, detect, ... }` where
`kind` is `success | business | recoverable | hard_failure`. "No member found" is
`{ kind: "business", code: "MEMBER_NOT_FOUND", detect: {kind: "text_present", ...} }`,
declared right next to the success condition. The replay engine's result type
(`src/schema/result.ts`) mirrors this at the top: `status` is
`"success" | "business_outcome" | "failed"`, and a business outcome is not inside
`failure` — it has no `failure` at all, and exits process code 0
(`exitCodeFor`). The brief calls conflating these the most common mistake in this space;
making the type system itself refuse to let a "no such member" answer be constructed the
same way as a broken locator was the actual goal of this schema, more than any single
field in it.

**A locator is a bundle of independently-ranked strategies, not a string**
(`LocatorBundleSchema`, `src/schema/common.ts`). Order is `role_name > control_name >
control_id > label_anchor > text_anchor > attribute > dom_path > bounds` — most durable
to most brittle. Resolution (`PlaywrightSurface.resolve`,
`src/surface/web/playwright-surface.ts`) tries them in order and takes the first
strategy that matches **exactly one** live element; zero matches falls through to the
next strategy, more than one match is a rejection (`status: "ambiguous"`), never a
guess. Every other strategy that still resolves to exactly one element is checked for
agreement with the winner; disagreement is recorded (`StepTrace.locator.disagreements`)
and surfaced as a run-level drift warning — not silently dropped. This actually fired
during evidence collection: replaying `member.subaccount.open` against a member with a
different account-grid shape than the one it was recorded against produced a genuine
`bounds`-strategy disagreement (see `driftWarnings` in
`evidence/replay-business_outcome-input_rejected/result.json`), which is exactly why
`bounds` is ranked last rather than trusted.

**`intent` is carried for humans, `target` is executed by the engine.** A compliance
reviewer reads "Enter the member number to look up"; the replay engine only ever looks
at `action.target`, a `LocatorBundle`. Neither can silently drift from the other because
they are recorded from the same action at the same instant
(`DiscoveryAgent.executeAction`, `src/discovery/agent.ts`) — the locator is captured
*before* the action runs, from the screen the model was actually looking at, not
reconstructed afterward from wherever the page ended up.

**Sensitivity is declared, not remembered.** `InputParam.sensitivity` and
`OutputField.sensitivity` are `none | pii | secret`, inferred by
`inferSensitivity()` (`src/discovery/compile.ts`) from the parameter/output name against
a deliberately broad regex, and can be tightened by a human reviewing the draft. A `pii`
input's example value is dropped from the artifact entirely (compare `memberId` in
`capabilities/member.savings_balance.lookup@v1.json` — no `example` field — against
`product`, which keeps one). This makes redaction a property of the schema rather than
something every future log call has to remember to apply.

**`approval: "draft" | "approved"`** gates unattended use, checked in exactly one place
(`ReplayEngine.run`, when `requireApproved` is set, and unconditionally by
`CapabilityCatalog.invoke`). A freshly recorded artifact cannot be invoked by another
agent until a human flips this — see `evidence/catalog-invoke-refused-draft/` and
`catalog-invoke-approved-success/` for both sides of that gate exercised for real.

**`provenance.appFingerprint`** is a cheap structural hash of the entry screen's control
names and grid headers (`structureSignature()`,
`src/surface/web/browser-script.ts`), captured once at record time and compared once at
the start of every replay (`ReplayEngine.checkFingerprint`). A mismatch never blocks a
run — a version bump is usually harmless — but it is the first line worth reading when a
run *does* fail, and across many tenants it is the signal that an artifact needs
re-recording rather than debugging. This is also the intended seam for the tenant-overlay
model described in Heterogeneity below, even though the overlay resolver itself isn't
built.

## Determinism & error handling

Replay (`src/replay/engine.ts`) never calls a model. Each step: settle the page, run
outcome interceptors, resolve the locator bundle, check policy, act, assert the
checkpoint. There are two interceptor scopes: `global` outcomes (session expiry,
broadcast dialogs, "not finished rendering yet") are checked before *and* after every
single step, because they don't respect step boundaries; `step`-scoped outcomes (the
success condition) are only checked after the steps named in `afterSteps`.

**Outcome precedence**, when more than one declared outcome matches the same screen at
once (`selectGoverningOutcome`, `src/replay/outcomes.ts`): recoverable outcomes that
still have attempts left win first — clear whatever is blocking the screen, then
re-evaluate from scratch, rather than letting a stale interstitial mask what's actually
underneath it. Among the rest, `hard_failure > business > success`, and ties within a
kind break on declaration order. A recoverable outcome that has exhausted `maxAttempts`
stops being live and falls out of consideration, which is what turns "kept retrying
forever" into a clean escalation instead.

**Three distinct recovery dispositions**, not one generic "retry":

- `recheck` — re-read the screen, do **not** repeat the action. Used for
  `dismiss_element` (a broadcast dialog): re-clicking the original button after
  dismissing an overlay could double-submit it.
- `retry_step` — re-run the whole step. Used for `wait_and_retry` (transient slowness)
  and `reload`, where the action itself never actually happened.
- A full flow restart (`RestartFlow`, thrown by the `reauthenticate` recovery) — used
  only for session expiry, because re-establishing a session discards all on-screen
  state (typed values, page position). Retrying just the current step would act on a
  form the sign-on flow just wiped. This is gated: it is only allowed while every step
  executed so far was `risk: "safe"` (`mutatedState`); if a write step has already run,
  the engine escalates to a human instead of risking a duplicate post on a re-run of the
  whole flow. See `evidence/replay-recovered-session_expired_midflow/run.jsonl` for a
  captured real run of this path (`SESSION_EXPIRED` matched → `reauthenticate` applied →
  restart from step one → succeeds cleanly).

**The result contract distinguishes exactly three things**, because that distinction is
the point of the whole exercise: `status: "success"` (goal reached, typed `outputs`
populated), `status: "business_outcome"` (a declared, legitimate non-success answer —
`outcomeCode` says which, exit code 0, no `failure` object at all), and
`status: "failed"` (`failure: { stepId, classification, expected, observed, message }`
plus a screenshot and an evidence directory). `evidence/replay-hard_failure-application_error/`
is the committed proof of the third case: the application's 500 page is classified
`APPLICATION_ERROR` with `failure.observed` containing the literal `SQLCODE` text from
the error page, not a stack trace from inside this codebase.

Tests: `tests/policy.test.ts`, `control.test.ts`, `redact.test.ts`, `outcomes.test.ts`,
`values.test.ts` cover the pieces in isolation; `tests/integration.test.ts` runs the
committed artifact through a real headless browser against a real (if small) instance of
the mock app — locator resolution against the actual hostile markup (agreement across
independent strategies, ambiguity refused rather than guessed, a missing control
reported rather than thrown), grid extraction by header+row, and the two recovery paths
above.

## Heterogeneity & multi-tenant

Only one surface is implemented (Playwright/web) and only one tenant exists. The design
that would extend to more of both, without having built it:

**Heterogeneity** is `Surface`. Everything above that line — the artifact schema, the
locator strategy ranking, the outcome taxonomy, the replay engine, the discovery
prompts — is written against `ObservedElement` and `Action`, never against a DOM node.
A desktop surface (Windows UI Automation / macOS Accessibility API) would implement the
same interface: `observe()` walks the accessibility tree instead of the frame tree and
returns the same `ObservedElement[]` shape (role, name, value, a "frame path" equivalent
for window/pane hierarchy, bounds); `act()` dispatches native input events instead of
Playwright calls. The one field in the schema that already anticipates this is
`SurfaceSpecSchema.kind: "web" | "desktop" | "terminal"` — a capability already declares
which adapter it needs. `bounds` is ranked last in the locator strategy list *because*
it's the one signal every surface can produce, including a hypothetical pixel-only one,
even though it should almost never win on a surface that exposes real structure.

**Multi-tenant reuse** is designed around `provenance.appFingerprint` and a
base-plus-overlay model that is not built: a base capability recorded against one
institution's instance of an application, plus a small per-tenant overlay that patches
what actually varies between two credit unions running "the same" core system — a
rebranded label, a different URL path prefix, an extra interstitial the tenant's
compliance team requires that the base flow never saw. The overlay would specialize
individual `LocatorBundle.strategies` or insert additional `waitFor`/recovery steps
without touching the base artifact, the same way `mergeOutcomes()` already lets a
capability's own outcome win over a library outcome by id while inheriting everything
else (`src/discovery/outcome-library.ts`) — that merge function is the actual
precedent for how an overlay resolver would be written. A replay would resolve
`base + overlay(tenant)` before executing, and `checkFingerprint`'s drift warning is the
signal that would tell an operator "this tenant's app has drifted far enough that the
overlay needs attention" rather than silently misfiring.

**What already generalizes without any of that being built**: a capability's `inputs`
are genuine parameters, not recorded literals. `evidence/replay-success-subaccount_open-with_escalation_approval/`
replays `member.subaccount.open` with a different member, product, deposit amount, and
delivery preference than it was recorded with — the artifact was never told those exact
values would recur.

## Escalation & handoff

`SessionHost` (`src/session/host.ts`) owns one Playwright browser context for the whole
run and holds a `ControlToken` (`src/session/control.ts`) valued `automation | human |
none`. It is not a convention — `ControlledSurface.act()` calls
`this.control.assertHeldBy("automation")` before every action and throws
`ControlViolation` otherwise. Handing control to `none` between "automation paused" and
"an operator picked it up" is deliberate: the evidence should say nobody was driving
during that gap, not imply a human was already present.

Two things raise an intervention through the same `InterventionStore`
(`src/escalation/store.ts`): the replay engine, when a step fails outright or policy
blocks an `irreversible` action pending approval (`ReplayEngine.escalate` /
`.approve`), and the discovery agent, when the model calls `give_up` rather than
guess. Either way: control transfers away from automation, an `Intervention` is raised
with the capability, step, reason, a redacted context snapshot, and a screenshot, and
the run blocks on `store.awaitResolution()` up to a configurable timeout.

The operator console (`src/escalation/console.ts`) is not a fresh browser and not a
replayed recording — it attaches to the CDP session of the **same** live page via
`Page.startScreencast`, streamed to the operator over server-sent events, and relays the
operator's clicks and keystrokes back into that exact page with
`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText`. Claiming an
intervention transfers control to `human`; every input the operator sends is logged as a
`human_step` in the evidence trail (`store.recordHumanAction`); resolving hands control
back and unblocks the waiting `awaitResolution` call. Before continuing, the engine
re-asserts the step's own checkpoint rather than trusting that the operator left the
screen where the automation expects it to be (`stepFailed`'s resume path,
`src/replay/engine.ts`).

This was verified live, not just unit-tested — it cannot be asserted in CI without a
real human decision. `evidence/replay-success-subaccount_open-with_escalation_approval/`
is a `member.subaccount.open` replay whose "Post Account" step is classified
`irreversible` by policy and genuinely paused. A human opened
`http://localhost:4180/i/<id>`, watched the real paused screen over the live CDP
screencast, and clicked "Hand back & resume." Control returned to automation inside the
same session, which then performed the click itself and the run completed —
`result.json.escalation` records the intervention id and resolution, and `run.jsonl` has
the full `control_transfer` / `intervention_resolved` sequence.

## Safety

One allowlist, one enforcement point, `policy/allowlist.yaml` and
`src/policy/engine.ts`. `GuardedSurface` wraps every surface either caller gets from
`SessionHost` — there is no second way to reach the browser that would skip it.

- **Origin and route allowlist.** `allowedOrigins` and `allowedPathPatterns` gate every
  navigation; `deniedPathPatterns` wins over allowed and is what keeps the agent off
  `/dev/*` — the same injection routes this project's own evidence collection uses to
  force failure states are unreachable to the agent itself.
- **Risk classification, not memory.** Every acted-on control is matched against
  `risk.irreversible` / `risk.sensitive` by its `name` attribute first, then its visible
  text (`policy/allowlist.yaml`; patterns support a leading `(?i)` inline flag, compiled
  by `compilePattern()` in `src/policy/engine.ts`). `irreversible` handling is
  `require_human_approval` — the action is not merely logged, it does not happen until a
  human resolves the approval intervention (see Escalation above). `sensitive` handling
  is `flag` — allowed, but loudly recorded in evidence, not silent.
- **Redaction is uniform, not per-call.** `Redactor` (`src/policy/redact.ts`) applies
  regex rules (account numbers → last four, SSNs and card numbers masked) plus
  runtime-registered literal values — every credential and every input/output value
  whose declared `sensitivity` is `pii` or `secret` — to everything written to disk:
  evidence logs, screenshots' accompanying metadata, and artifacts. There is exactly one
  exception, `EvidenceRecorder.writeCallerResult`, which is what a capability actually
  returns to its authorized caller — masking the answer there would defeat the purpose
  of the capability, so the redaction boundary is placed at "what gets persisted," not
  "what gets returned."
- **Budgets.** `maxDiscoverySteps`, `maxReplayActions`, `maxWallClockMs` bound a runaway
  loop regardless of what the model or a misclassified recovery does.

Stated limits, honestly: an allowlist can only classify a risky action the config
anticipated — a new irreversible-sounding button added to the app tomorrow is `safe`
until someone adds it to `risk.irreversible`. Text-pattern risk matching depends on the
control's visible label not changing in a way that dodges the pattern. Screenshot
redaction masks known-sensitive elements' accompanying text, not arbitrary pixels — a
value rendered only as an image would not be caught by the regex rules.

## Cuts

Made deliberately, to go deep on the four load-bearing pieces (artifact schema, locator
strategy, error taxonomy, control transfer) rather than broad across many features:

- **Multi-tenant overlay resolution is designed, not built** (see Heterogeneity above).
  `provenance.appFingerprint` and `mergeOutcomes()`'s id-override-by-library pattern are
  the two pieces already in place that an overlay resolver would build on.
- **Only one `Surface` is implemented.** Desktop/accessibility-tree and terminal
  surfaces are declared in the schema (`SurfaceSpecSchema.kind`) but not written.
- **The operator console has no authentication and no multi-operator arbitration.**
  Anyone who can reach the port can claim an intervention. Fine for a single-tenant demo
  with one automation session; not fine in production.
- **One real capability is exercised by an automated integration test
  (`member.savings_balance.lookup`).** The second capability,
  `member.subaccount.open` — the one with the multi-step form and the irreversible
  action — is verified through committed, real evidence (discovery run, two replays,
  the live escalation handoff) but not wired into `tests/integration.test.ts`. Given
  more time this would get the same automated coverage the first capability has,
  including a scripted (or fixture-driven) resolution of its approval intervention so
  the escalation path could run unattended in CI.
- **No confidence scoring, no assisted-recovery-by-LLM on replay failure, no
  multi-run flakiness reporting.** A `hard_failure` today always means "stop and show a
  human," which is the honest behavior; a system that tried to have a model guess its
  way past a replay failure would reintroduce exactly the nondeterminism this whole
  design exists to remove.
- **The real-API discovery run is still outstanding.** Every discovery run committed as
  evidence so far used `ScriptedClient` (`src/discovery/llm.ts`), a fixed-script
  stand-in used throughout implementation so the pipeline could be built and iterated on
  without spending a model call on every change. `AnthropicClient` exists, is wired into
  `src/runtime.ts:discover()` by default, and is the only thing `ScriptedClient` was
  standing in for — swapping it back in needs nothing but an `ANTHROPIC_API_KEY`. This
  is explicitly called out again in `evidence/README.md` rather than glossed over,
  because it is the one requirement the brief describes as non-negotiable.
