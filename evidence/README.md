# Evidence

Every directory here is the untouched output of a real run against the live mock
application in `apps/legacy-core` — a real headless Chromium session, a real Express
server, real HTTP requests. Nothing in this folder is hand-written or simulated.

Each run directory contains:

- `run.jsonl` — a structured event log (what happened and why: actions, policy
  decisions, recoveries, outcome matches, escalations)
- `screens/` — a screenshot after every discovery action, or at every failure/escalation
  point during replay
- `result.json` — the typed `ReplayResult` (replay runs only; discovery runs produce a
  capability artifact under `/capabilities` instead)

Redaction is applied uniformly: everything under `evidence/` has passed through the same
redactor as the artifacts, so account numbers are masked to their last four digits and
inputs/outputs classified `pii` never appear in a log line.

## Discovery (LLM in the loop)

| Directory | What it shows |
|---|---|
| `discovery-member.savings_balance.lookup/` | The run that produced `capabilities/member.savings_balance.lookup@v1.json` — search, open a member, read a grid value. |
| `discovery-member.subaccount.open/` | The run that produced `capabilities/member.subaccount.open@v1.json` — a multi-step form, a confirmation screen, and an irreversible "Post Account" action. |

These two were driven by `ScriptedClient`, a fixed-script stand-in for the model
(`src/discovery/llm.ts`) used throughout implementation so the whole pipeline could be
built and tested without spending API calls on every iteration. **The brief's
non-negotiable requirement — at least one discovery run driven by the real Anthropic
API — is still outstanding** and will be added here as
`discovery-member.savings_balance.lookup-live/` (or similar) once an API key is
available. Swapping `ScriptedClient` for `AnthropicClient` is the only change involved;
see `src/runtime.ts:discover()`.

## Replay (no model anywhere in the loop)

| Directory | Outcome | What it shows |
|---|---|---|
| `replay-success-savings_balance.lookup/` | `success` / `SUCCESS` | The happy path. |
| `replay-business_outcome-member_not_found/` | `business_outcome` / `MEMBER_NOT_FOUND` | A legitimate answer, not a crash — `failure` is absent, exit code 0. |
| `replay-business_outcome-permission_denied/` | `business_outcome` / `PERMISSION_DENIED` | Same distinction, a different application-level refusal. |
| `replay-business_outcome-input_rejected/` | `business_outcome` / `INPUT_REJECTED` | `member.subaccount.open` with a deposit below the app's minimum — the server-side validation message is classified as a business outcome, not a locator or script failure. |
| `replay-hard_failure-application_error/` | `failed` / `APPLICATION_ERROR` | **The required error-state replay.** The app's 500 page is classified as a hard failure with a debuggable trail: step id, expected vs. observed, and an evidence path (`failure.observed` contains the literal `SQLCODE` text from the error page). |
| `replay-recovered-interstitial_dismissed/` | `success` (recovered) | A broadcast "System Message" dialog is dismissed by the global interceptor and the run continues — the step that hit it ran its click exactly once (see `steps[].recoveries` in `result.json`). |
| `replay-recovered-session_expired_midflow/` | `success` (recovered) | The session is invalidated mid-flow (`/dev/expire-after`). `run.jsonl` shows `SESSION_EXPIRED` matched, `reauthenticate` applied, and the flow restarted from step one rather than resuming into now-discarded form state. |
| `replay-success-subaccount_open-with_escalation_approval/` | `success` (escalated) | **The human-in-the-loop demo.** `member.subaccount.open` replayed with *different* input values than it was recorded with (member, product, deposit amount, and delivery preference all changed, proving the artifact generalizes rather than replaying literal recorded values). Step `s8` — clicking "Post Account" — is classified `irreversible` by policy and blocked pending approval. The run genuinely paused; a human opened the live CDP screencast at the operator console, reviewed the real paused page, and resolved the intervention. Control returned to automation, which then performed the click itself and the run completed. `result.json.escalation` records the intervention id, reason, and resolution; `run.jsonl` has the full `control_transfer` / `intervention_resolved` trail. |

The last row is the single piece of evidence that most directly answers "does the
escalation and handoff mechanism actually work," since it is not something a unit test
can assert — it requires a live browser, a live human decision, and the same session on
both sides of the handoff.

## Capability catalog (stretch goal)

| Directory | What it shows |
|---|---|
| `catalog-invoke-refused-draft/` | `npm run catalog -- invoke member.savings_balance.lookup ...` against the artifact in its normal, as-committed `draft` state — refused unattended with `precondition_failed`, as an unreviewed recording should be. |
| `catalog-invoke-approved-success/` | The same invocation after the artifact was temporarily promoted to `approval: "approved"` — succeeds unattended with typed outputs. The artifact was reverted to `draft` immediately afterward; `capabilities/member.savings_balance.lookup@v1.json` in the repo is the original draft, and the test suite (`tests/integration.test.ts`, "refuses to run a draft capability unattended") depends on that being true. |

`npm run catalog -- list` and `describe` are not separately captured here since their
output is deterministic and reproducible on demand (see the README's demo commands);
`invoke` is the one with a real side-effecting run behind it, which is why it is the one
kept as evidence.
