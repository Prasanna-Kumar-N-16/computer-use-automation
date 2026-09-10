# Computer-Use Automation

Give an LLM agent "hands" inside a legacy back-office application that exposes no API:
it discovers how to accomplish a goal by driving a real UI once, that run is compiled
into a typed, versioned **capability artifact**, the artifact is then replayed
**deterministically with no model in the loop**, and a human can take over the *same
live session* when the system gets stuck or an action needs approval.

See [`REPORT.md`](REPORT.md) for the design write-up and [`evidence/`](evidence/README.md)
for real, committed runs against a live browser and a live (mock) application.

## Stack

TypeScript on Node, Playwright (the one implemented `Surface`), Zod (schema =
validation + types + generated tool schemas), Express (the mock application and the
operator console), Vitest, the Anthropic Messages API with tool use for discovery.

## Setup

```bash
npm install
npx playwright install chromium   # once, if not already cached
cp .env.example .env
```

Edit `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...   # only needed for `npm run discover`
```

`replay`, `catalog`, and `operator` never call a model and work with no key at all.
Everything else in `.env.example` has a sane default (`CUA_MODEL`, ports).

## The target application

`apps/legacy-core` is a small, deliberately hostile mock: a frameset (nav frame + main
frame), table-based layout, no test IDs, form fields named `txtMbrNo` / `cmdSearch`, a
session cookie that can expire, and `/dev/*` routes that let evidence-producing runs
inject failures on demand (`/dev/expire-after`, `/dev/interstitial`, `/dev/slow`,
`/dev/reset`). It impersonates a credit-union servicing console ("MeridianCore
Servicing"). None of `/dev/*` is reachable by the agent — it's outside the policy
allowlist (`policy/allowlist.yaml`).

Seeded member numbers exercise every branch of the error taxonomy: `12345` / `24680` /
`31415` succeed, `99999` has no record, `70001` is permission-denied, `55555` shows a
broadcast interstitial first, `50000` returns an application error.

## Demo: the full path, in order

Terminal 1 — start the mock application:

```bash
npm run app
```

Terminal 2 — record a capability by watching an LLM drive the live app once:

```bash
npm run discover -- \
  --goal "Look up member 12345 and read their current savings balance" \
  --id member.savings_balance.lookup \
  --param memberId=12345 \
  --param-desc memberId="The member number to look up." \
  --outcomes policy/outcomes.meridiancore.yaml
```

This writes `capabilities/member.savings_balance.lookup@v1.json` with `approval:
"draft"` and a full evidence trail under `evidence/`. Nothing about this step is
scripted or replayed — it is a live LLM tool-use loop against the running app (see
[`evidence/README.md`](evidence/README.md) for what's committed from real runs, and the
note there about the one still-outstanding real-API run).

Replay it — deterministically, with no model involved — against the happy path and
against two exceptional conditions:

```bash
npm run replay -- --capability member.savings_balance.lookup --input memberId=12345
npm run replay -- --capability member.savings_balance.lookup --input memberId=99999   # business outcome: MEMBER_NOT_FOUND
npm run replay -- --capability member.savings_balance.lookup --input memberId=50000   # hard failure: APPLICATION_ERROR
```

The second call exits 0 with `status: "business_outcome"` — "no such member" is a
legitimate answer, not a crash. The third exits non-zero with `status: "failed"` and a
debuggable trail: step id, expected vs. observed, evidence directory.

Open the operator console (a second capability, `member.subaccount.open`, has an
irreversible "Post Account" step that pauses here for approval):

```bash
npm run replay -- --capability member.subaccount.open \
  --input memberId=24680 --input product=SAV-02 --input initialDeposit=50.00 --input delivery=E
```

The run prints an intervention URL and pauses. Open it
(`http://localhost:4180/i/<id>`, printed by the command) to watch the **live** page over
a CDP screencast, and click **Hand back & resume** to approve — the automation resumes
in the same session and finishes the click itself. `evidence/replay-success-subaccount_open-with_escalation_approval/`
is exactly this, already run and committed.

Demonstrate the capability catalog (agent-facing view over everything recorded):

```bash
npm run catalog -- list
npm run catalog -- describe member.savings_balance.lookup
npm run catalog -- invoke member.savings_balance.lookup --args '{"memberId":"12345"}'
```

The last command is refused (`precondition_failed`) as-is, because the artifact is a
draft — unattended invocation requires promotion. Add `--attended` to invoke a draft
under supervision, or flip `approval` to `"approved"` in the artifact's JSON to invoke it
unattended for real (see `evidence/catalog-invoke-*` for both outcomes, captured live).

## Tests

```bash
npm test          # vitest run — unit + a real-browser, real-app integration suite
npm run typecheck
```

The integration suite (`tests/integration.test.ts`) boots its own copy of the mock app
on a separate port and runs the committed artifact through a real browser: locator
resolution against the hostile markup (unique-match strategies agree; an intentionally
ambiguous bundle is refused rather than guessed at; a missing control is reported rather
than thrown), every outcome classification (success / business / recoverable /
hard-failure), grid extraction by header+row, and — the two recovery behaviors that took
the most iteration to get right — an interstitial dismissed without repeating the click
that triggered it, and a session expiry mid-flow that restarts the whole flow rather than
resuming into now-discarded form state.

## Repository layout

```
apps/legacy-core/     the hostile mock target application
policy/                allowlist, risk rules, redaction config; per-application outcome library
capabilities/          recorded artifacts (JSON, versioned)
evidence/              real discovery + replay runs, committed (see evidence/README.md)
src/surface/           Surface contract + the Playwright/web implementation
src/schema/            capability + replay-result Zod schemas
src/policy/            allowlist engine, risk classification, redaction
src/session/           session host, single-writer control token, evidence recorder
src/discovery/         agent loop, Anthropic adapter, transcript-to-artifact compiler
src/replay/            deterministic executor, interceptors, outcome selection
src/escalation/        intervention store, live CDP operator console
src/catalog/           capability registry + invoke surface (stretch goal)
src/cli.ts             discover | replay | catalog | operator
tests/
```

## Known limitations

See `REPORT.md`'s "Cuts" section for the full list and reasoning. In short: single
tenant, single surface (web/Playwright) implemented against the `Surface` seam, no
operator authentication, and the real-API discovery run is still pending an API key.
