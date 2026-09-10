/**
 * The deterministic replay engine - the production execution path.
 *
 * No model is consulted here. Every decision comes from the artifact: which control to
 * act on, what to wait for, what proves the step worked, and which observable
 * conditions mean what. That is the whole point of recording once.
 *
 * The engine's real job is not clicking. It is classification: turning whatever the
 * screen is currently showing into exactly one of three answers for the caller -
 * it worked, it did not apply, or it broke.
 */

import { randomUUID } from "node:crypto";
import type { Capability, Outcome, Step } from "../schema/capability.js";
import type { ReplayResult, StepTrace, ReplayFailure } from "../schema/result.js";
import { describe as describeAssertion, evaluate, waitUntil, type AssertionContext, type AssertionSurface } from "./assertions.js";
import { selectGoverningOutcome } from "./outcomes.js";
import { InputError, applyTransform, renderTemplate, resolveValue, typeOutput, validateInputs, type Inputs, type SecretResolver } from "./values.js";
import { GuardedSurface, PolicyEngine, PolicyViolation, type ApprovalRequest } from "../policy/engine.js";
import type { PlaywrightSurface } from "../surface/web/playwright-surface.js";
import type { SessionHost } from "../session/host.js";
import type { Intervention, InterventionKind, InterventionStore } from "../escalation/store.js";
import type { Observation } from "../surface/types.js";

export interface ReplayOptions {
  capability: Capability;
  inputs: Record<string, unknown>;
  host: SessionHost;
  raw: PlaywrightSurface;
  policy: PolicyEngine;
  store: InterventionStore;
  baseUrl: string;
  secrets?: SecretResolver;
  /** How long a raised intervention may sit unresolved before the run gives up. */
  escalationTimeoutMs?: number;
  /** Called when an intervention is raised, so the CLI can print the console URL. */
  onEscalation?: (intervention: Intervention) => void;
  /** Refuse to run artifacts that a human has not approved. */
  requireApproved?: boolean;
}

/** What the engine should do after evaluating outcomes at a given point. */
type Disposition = "continue" | "recheck" | "retry_step";

class HardStop extends Error {
  constructor(readonly failure: ReplayFailure) {
    super(failure.message);
  }
}

class TerminalOutcome extends Error {
  constructor(readonly outcome: Outcome) {
    super(outcome.code);
  }
}

/**
 * Thrown when the session had to be re-established.
 *
 * Re-authenticating throws away everything the flow had built up on screen - a typed
 * member number, a half-filled form - so resuming at the current step would act on a
 * blank one. The flow has to start again from step one, which is only safe because
 * `mutatedState` blocks this path once anything has been written.
 */
class RestartFlow extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export class ReplayEngine {
  private readonly runId: string;
  private readonly startedAt = new Date();
  private readonly traces: StepTrace[] = [];
  private readonly driftWarnings: string[] = [];
  private readonly attempts: Record<string, number> = {};
  private readonly assertionSurface: AssertionSurface;
  private surface!: GuardedSurface;
  private inputs: Inputs = {};
  private lastObservation?: Observation;
  private escalations: Intervention[] = [];
  /** Set once any step with risk above `safe` has executed. Gates restart-style recovery. */
  private mutatedState = false;
  /** Where the run currently is, so a failure or escalation can name the step. */
  private currentStepId?: string;

  constructor(private readonly opts: ReplayOptions) {
    this.runId = opts.host.runId;
    this.assertionSurface = {
      resolve: (b) => opts.raw.resolve(b),
      frameText: (p) => opts.raw.frameText(p),
      allText: () => opts.raw.allText(),
    };
  }

  private get cap(): Capability {
    return this.opts.capability;
  }

  private async context(): Promise<AssertionContext> {
    this.lastObservation = await this.opts.raw.observe();
    return { surface: this.assertionSurface, observation: this.lastObservation };
  }

  async run(): Promise<ReplayResult> {
    const ev = this.opts.host.evidence;
    ev.event("run_started", `Replaying ${this.cap.id} v${this.cap.version}`, {
      capability: this.cap.id,
      version: this.cap.version,
      approval: this.cap.approval,
    });

    try {
      if (this.opts.requireApproved && this.cap.approval !== "approved") {
        return this.fail({
          classification: "precondition_failed",
          expected: "an approved capability",
          observed: `approval state "${this.cap.approval}"`,
          message: `${this.cap.id} is still a draft. Unattended invocation requires promotion to approved.`,
        });
      }

      try {
        this.inputs = validateInputs(this.cap, this.opts.inputs);
      } catch (err) {
        const e = err as InputError;
        return this.fail({
          classification: "input_invalid",
          expected: "arguments matching the declared input contract",
          observed: e.message,
          message: e.message,
        });
      }

      // Sensitive argument values are registered before anything is written, so they
      // cannot appear unredacted even in a failure that happens on the next line.
      for (const param of this.cap.inputs) {
        const value = this.inputs[param.name];
        if (value !== undefined) {
          this.opts.policy.redactor.registerSensitive(String(value), param.sensitivity, param.name);
        }
      }

      this.surface = this.opts.host.automationSurface({
        budget: this.opts.policy.config.budgets.maxReplayActions,
        onEvent: (event) => ev.event("guard", `${event.type}: ${event.describe}`, { ...event }),
        requestApproval: (req) => this.approve(req),
      });

      await this.enterApplication();
      await this.checkFingerprint();
      await this.checkPreconditions();

      await this.runSteps();

      return await this.finish();
    } catch (err) {
      if (err instanceof TerminalOutcome) return this.terminal(err.outcome);
      if (err instanceof HardStop) return this.fail(err.failure);
      if (err instanceof PolicyViolation) {
        return this.fail({
          classification: "policy_blocked",
          expected: "an action permitted by policy",
          observed: err.message,
          message: err.message,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      ev.event("error", `Unhandled replay error: ${message}`);
      if (err instanceof RestartFlow) {
        return this.fail({
          classification: "recovery_exhausted",
          expected: "a stable authenticated session",
          observed: message,
          message: `The session kept expiring; gave up after re-establishing it repeatedly.`,
        });
      }
      return this.fail({
        classification: "internal_error",
        expected: "replay to complete",
        observed: message,
        message,
      });
    }
  }

  /** Run every step, restarting the whole sequence if the session had to be rebuilt. */
  private async runSteps(): Promise<void> {
    const ev = this.opts.host.evidence;
    for (let restart = 0; restart <= 2; restart++) {
      try {
        for (const step of this.cap.steps) {
          try {
            await this.runStep(step);
          } catch (err) {
            // A step a human completed by hand during an intervention is a completed
            // step. The run carries on from the next one, with the handoff recorded.
            if (err instanceof ResumeAfterHuman) {
              ev.event("intervention_resolved", `Step ${step.id} was completed by a human operator; resuming.`, {
                stepId: step.id,
              });
              continue;
            }
            throw err;
          }
        }
        return;
      } catch (err) {
        if (!(err instanceof RestartFlow) || restart === 2) throw err;
        ev.event("recovery", `Restarting the flow from step one: ${err.reason}`, { restart: restart + 1 });
      }
    }
  }

  // -------------------------------------------------------------- preconditions

  private async enterApplication(): Promise<void> {
    const ev = this.opts.host.evidence;
    if (this.cap.surface.requires.includes("authenticated_session")) {
      await this.opts.host.signOn();
    }
    const url = renderTemplate(this.cap.surface.entryUrlTemplate, this.inputs, { baseUrl: this.opts.baseUrl });
    ev.event("action", `Navigating to capability entry point.`, { url });
    await this.surface.act({ kind: "navigate", url });
    await this.opts.raw.settle();
  }

  /**
   * Compare the application as it is now against the fingerprint taken at record time.
   *
   * This never fails a run on its own. A version bump or a rebrand is usually
   * harmless, and refusing to run would be worse than proceeding. But when the run
   * *does* fail later, the drift warning is the first thing worth reading, and across
   * many tenants it is the signal that an artifact needs re-recording.
   */
  private async checkFingerprint(): Promise<void> {
    const recorded = this.cap.provenance.appFingerprint;
    if (!recorded || Object.keys(recorded).length === 0) return;
    const seen = await this.opts.raw.fingerprint();

    if (recorded.appVersion && seen.appVersion && recorded.appVersion !== seen.appVersion) {
      this.driftWarnings.push(`Application version changed since recording: ${recorded.appVersion} -> ${seen.appVersion}`);
    }
    if (recorded.structureHash && seen.structureHash && recorded.structureHash !== seen.structureHash) {
      this.driftWarnings.push(
        `Entry screen structure changed since recording (${recorded.structureHash} -> ${seen.structureHash}).`
      );
    }
    for (const warning of this.driftWarnings) {
      this.opts.host.evidence.event("drift", warning, { recorded, seen });
    }
  }

  private async checkPreconditions(): Promise<void> {
    for (const assertion of this.cap.preconditions) {
      const held = await waitUntil(assertion, () => this.context(), 10_000);
      if (!held) {
        throw new HardStop({
          classification: "precondition_failed",
          expected: describeAssertion(assertion),
          observed: await this.observedSummary(),
          message: `Precondition not met: ${describeAssertion(assertion)}`,
        });
      }
    }
  }

  // ---------------------------------------------------------------------- steps

  private async runStep(step: Step): Promise<void> {
    const ev = this.opts.host.evidence;
    const startedAt = new Date();
    const trace: StepTrace = {
      stepId: step.id,
      intent: step.intent,
      action: step.action.kind,
      status: "ok",
      startedAt: startedAt.toISOString(),
      durationMs: 0,
      recoveries: [],
    };

    this.currentStepId = step.id;
    attempts: for (;;) {
      this.assertBudget();
      await this.opts.raw.settle(step.timeoutMs);

      // Conditions that can appear at any moment are checked before the step acts,
      // because acting into a modal dialog or an expired session is how automation
      // does damage. Nothing has happened yet, so any recovery simply restarts here.
      if ((await this.checkOutcomes(step.id, trace)) !== "continue") continue attempts;

      for (const assertion of step.waitFor) {
        if (await waitUntil(assertion, () => this.context(), step.timeoutMs)) continue;
        if ((await this.checkOutcomes(step.id, trace)) !== "continue") continue attempts;
        await this.stepFailed(step, trace, {
          classification: "timeout",
          expected: describeAssertion(assertion),
          observed: await this.observedSummary(),
          message: `Timed out at step ${step.id} waiting for: ${describeAssertion(assertion)}`,
        });
      }

      try {
        await this.performAction(step, trace);
      } catch (err) {
        if (err instanceof PolicyViolation || err instanceof HardStop || err instanceof TerminalOutcome) throw err;
        if ((await this.checkOutcomes(step.id, trace)) !== "continue") continue attempts;
        await this.stepFailed(step, trace, {
          classification: "internal_error",
          expected: `step ${step.id} to execute`,
          observed: err instanceof Error ? err.message : String(err),
          message: `Step ${step.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      await this.opts.raw.settle(step.timeoutMs);
      if ((await this.settleOutcomes(step, trace)) === "retry_step") continue attempts;

      if (step.checkpoint) {
        let passed = await waitUntil(step.checkpoint, () => this.context(), step.timeoutMs);
        if (!passed) {
          const disposition = await this.settleOutcomes(step, trace);
          if (disposition === "retry_step") continue attempts;
          if (disposition === "recheck") {
            passed = await waitUntil(step.checkpoint, () => this.context(), 5_000);
          }
        }
        trace.checkpoint = { passed, describe: describeAssertion(step.checkpoint) };
        if (!passed) {
          await this.stepFailed(step, trace, {
            classification: "checkpoint_failed",
            expected: describeAssertion(step.checkpoint),
            observed: await this.observedSummary(),
            message: `Checkpoint failed after step ${step.id}: expected ${describeAssertion(step.checkpoint)}`,
          });
        }
      }

      if (step.risk !== "safe") this.mutatedState = true;
      trace.durationMs = Date.now() - startedAt.getTime();
      this.traces.push(trace);
      ev.event("action", `Step ${step.id} completed: ${step.intent}`, {
        stepId: step.id,
        resolvedBy: trace.locator?.resolvedBy,
        checkpoint: trace.checkpoint?.passed,
      });
      ev.screenshot(`${step.id}`, await this.opts.raw.screenshot());
      return;
    }
  }

  /**
   * Apply post-action recoveries until the screen stops changing under us.
   *
   * The distinction that matters: dismissing a blocking dialog must *not* re-run the
   * action. The click already landed; the dialog appeared on its result. Re-running it
   * would submit the same form twice - which for a write step is the difference
   * between a recovery and an incident.
   */
  private async settleOutcomes(step: Step, trace: StepTrace): Promise<Disposition> {
    for (let guard = 0; guard < 8; guard++) {
      const disposition = await this.checkOutcomes(step.id, trace);
      if (disposition !== "recheck") return disposition;
      await this.opts.raw.settle(3_000);
    }
    return "continue";
  }

  private async performAction(step: Step, trace: StepTrace): Promise<void> {
    const action = step.action;

    if (action.kind === "navigate") {
      const url = renderTemplate(action.urlTemplate, this.inputs, { baseUrl: this.opts.baseUrl });
      await this.surface.act({ kind: "navigate", url });
      return;
    }
    if (action.kind === "wait_for") {
      const held = await waitUntil(action.assertion, () => this.context(), action.timeoutMs);
      if (!held) {
        throw new HardStop({
          classification: "timeout",
          expected: describeAssertion(action.assertion),
          observed: await this.observedSummary(),
          message: `Step ${step.id} timed out waiting for ${describeAssertion(action.assertion)}`,
        });
      }
      return;
    }
    if (action.kind === "press" && !action.target) {
      await this.surface.act({ kind: "press", key: action.key });
      return;
    }

    const bundle = "target" in action && action.target ? action.target : undefined;
    if (!bundle) throw new Error(`Step ${step.id} has no target.`);

    // Observing before resolving is what makes the ref handed to `act` valid, and it
    // is also what lets the policy layer see which control is about to be touched.
    await this.surface.observe();
    const resolution = await this.surface.resolve(bundle);
    trace.locator = {
      resolvedBy: resolution.resolvedBy ?? "none",
      attempted: resolution.attempted,
      disagreements: resolution.disagreements,
    };

    if (resolution.disagreements.length) {
      const warning = `Locator strategies disagreed on ${bundle.description}: ${resolution.disagreements.join(", ")} resolved elsewhere.`;
      this.driftWarnings.push(warning);
      this.opts.host.evidence.event("drift", warning, { stepId: step.id });
    }

    if (resolution.status !== "resolved" || !resolution.ref) {
      throw new HardStop({
        classification: resolution.status === "ambiguous" ? "locator_ambiguous" : "locator_unresolved",
        expected: `a unique match for ${bundle.description}`,
        observed: resolution.attempted.map((a) => `${a.kind}=${a.matches}`).join(", ") || "no strategies matched",
        message:
          resolution.status === "ambiguous"
            ? `Step ${step.id}: ${bundle.description} matched more than one control; refusing to guess.`
            : `Step ${step.id}: could not find ${bundle.description}.`,
      });
    }

    const ref = resolution.ref;

    switch (action.kind) {
      case "click":
        await this.surface.act({ kind: "click", ref });
        return;
      case "type": {
        const text = resolveValue(action.value, this.inputs, this.opts.secrets ?? (() => undefined));
        await this.surface.act({ kind: "type", ref, text, clearFirst: action.clearFirst, pressEnter: action.pressEnter });
        return;
      }
      case "select": {
        const value = resolveValue(action.value, this.inputs, this.opts.secrets ?? (() => undefined));
        await this.surface.act({ kind: "select", ref, value });
        return;
      }
      case "press":
        await this.surface.act({ kind: "press", key: action.key, ref });
        return;
    }
  }

  // ------------------------------------------------------------------- outcomes

  /**
   * Evaluate every outcome in scope and act on whichever governs.
   *
   * "continue" means nothing matched. "recheck" means a blocker was cleared and the
   * screen should be re-read without repeating the action. "retry_step" means the step
   * has to run again from the top. Terminal outcomes are thrown.
   */
  private async checkOutcomes(stepId: string | undefined, trace: StepTrace): Promise<Disposition> {
    const inScope = this.cap.outcomes.filter(
      (o) => o.scope === "global" || (stepId !== undefined && o.afterSteps.includes(stepId))
    );
    if (inScope.length === 0) return "continue";

    const ctx = await this.context();
    const matched: Outcome[] = [];
    for (const outcome of inScope) {
      if (await evaluate(outcome.detect, ctx)) matched.push(outcome);
    }
    if (matched.length === 0) return "continue";

    const governing = selectGoverningOutcome(matched, { attempts: this.attempts, currentStepId: stepId });
    if (!governing) return "continue";

    this.opts.host.evidence.event("outcome_matched", `Outcome ${governing.code} (${governing.kind}) matched.`, {
      stepId,
      code: governing.code,
      alsoMatched: matched.filter((m) => m.id !== governing.id).map((m) => m.code),
    });

    if (governing.kind !== "recoverable") throw new TerminalOutcome(governing);

    this.attempts[governing.id] = (this.attempts[governing.id] ?? 0) + 1;
    const attempt = this.attempts[governing.id]!;
    trace.status = "recovered";
    trace.recoveries.push({ outcomeCode: governing.code, action: governing.recovery?.action ?? "none", attempt });
    await this.recover(governing, attempt);
    return governing.recovery?.action === "dismiss_element" ? "recheck" : "retry_step";
  }

  private async recover(outcome: Outcome, attempt: number): Promise<void> {
    const ev = this.opts.host.evidence;
    const recovery = outcome.recovery;
    if (!recovery) return;
    ev.event("recovery", `Applying ${recovery.action} for ${outcome.code} (attempt ${attempt}).`, {
      code: outcome.code,
      action: recovery.action,
    });

    switch (recovery.action) {
      case "dismiss_element": {
        await this.surface.observe();
        const res = await this.surface.resolve(recovery.target);
        if (res.status === "resolved" && res.ref) {
          await this.surface.act({ kind: "click", ref: res.ref });
        } else {
          ev.event("recovery", `Could not find the control that dismisses ${outcome.code}.`);
        }
        return;
      }
      case "wait_and_retry":
        await new Promise((r) => setTimeout(r, recovery.waitMs));
        return;
      case "reload":
        await this.opts.raw.act({ kind: "navigate", url: this.lastObservation?.url ?? this.opts.baseUrl });
        return;
      case "reauthenticate": {
        /**
         * Re-authenticating means the session was thrown away, so the flow has to be
         * re-entered from the top. That is safe for a read-only capability and
         * dangerous for one that has already written something - replaying a
         * sub-account creation would post it twice. So the recovery is allowed only
         * while every executed step was classified `safe`; otherwise it escalates to
         * a human, who can see what actually got committed.
         */
        if (this.mutatedState) {
          const decision = await this.escalate(
            "recovery_exhausted",
            `Session expired after a state-changing step. Re-running the flow could duplicate the change, so it needs a human decision.`,
            { stepId: undefined }
          );
          if (decision !== "resume" && decision !== "approve") {
            throw new HardStop({
              classification: "recovery_exhausted",
              expected: "an authenticated session",
              observed: "session expired after a state-changing step",
              message: "Session expired mid-flow after a write; refusing to replay automatically.",
            });
          }
          return;
        }
        await this.opts.host.signOn();
        const url = renderTemplate(this.cap.surface.entryUrlTemplate, this.inputs, { baseUrl: this.opts.baseUrl });
        await this.surface.act({ kind: "navigate", url });
        await this.opts.raw.settle();
        throw new RestartFlow("the session was re-established, so on-screen state was lost");
      }
    }
  }

  // ------------------------------------------------------------------ escalation

  private async stepFailed(step: Step, trace: StepTrace, failure: ReplayFailure): Promise<never> {
    trace.status = "failed";
    trace.durationMs = Date.now() - new Date(trace.startedAt).getTime();
    this.traces.push(trace);

    const ev = this.opts.host.evidence;
    const shot = ev.screenshot(`${step.id}-failed`, await this.opts.raw.screenshot());
    ev.textSnapshot(`${step.id}-failed`, await this.opts.raw.allText());
    ev.event("error", failure.message, { ...failure, screenshot: shot });

    const decision = await this.escalate("stuck", failure.message, {
      stepId: step.id,
      stepIntent: step.intent,
      expected: failure.expected,
      observed: failure.observed,
      screenshotPath: shot,
    });

    if (decision === "resume" || decision === "approve") {
      // The operator says they fixed it. Trust but verify: the step's own checkpoint
      // is the same evidence the automation would have needed, so re-assert it rather
      // than assuming the human left the screen where we expect.
      if (step.checkpoint) {
        const passed = await waitUntil(step.checkpoint, () => this.context(), 10_000);
        if (passed) {
          trace.status = "human";
          throw new ResumeAfterHuman(step.id);
        }
      } else {
        trace.status = "human";
        throw new ResumeAfterHuman(step.id);
      }
      throw new HardStop({
        ...failure,
        classification: "escalation_unresolved",
        message: `${failure.message} Operator resumed, but the step checkpoint still does not hold.`,
      });
    }

    throw new HardStop({
      ...failure,
      classification: decision === "pending" ? "escalation_unresolved" : failure.classification,
    });
  }

  /** Raise an intervention, hand control away, and block until a human answers. */
  private async escalate(
    kind: InterventionKind,
    reason: string,
    context: { stepId?: string; stepIntent?: string; expected?: string; observed?: string; screenshotPath?: string }
  ): Promise<"resume" | "abort" | "approve" | "deny" | "fail" | "pending"> {
    const host = this.opts.host;
    const shot = context.screenshotPath ?? host.evidence.screenshot("escalation", await this.opts.raw.screenshot());

    context.stepId ??= this.currentStepId;
    host.control.transfer("none", `escalating: ${reason}`);
    const intervention = this.opts.store.raise({
      runId: this.runId,
      kind,
      reason,
      capabilityId: this.cap.id,
      capabilityVersion: this.cap.version,
      goal: this.cap.provenance.goal,
      context: {
        url: this.lastObservation?.url,
        title: this.lastObservation?.title,
        ...context,
        screenshotPath: shot,
      },
    });
    this.escalations.push(intervention);
    host.evidence.event("intervention_raised", `Raised ${intervention.id}: ${reason}`, {
      interventionId: intervention.id,
      kind,
      stepId: context.stepId,
    });
    this.opts.onEscalation?.(intervention);

    const resolved = await this.opts.store.awaitResolution(
      intervention.id,
      this.opts.escalationTimeoutMs ?? 10 * 60_000
    );
    if (!resolved?.resolution) {
      host.evidence.event("intervention_resolved", `Intervention ${intervention.id} timed out with no operator response.`);
      return "pending";
    }
    // Control returns to automation inside the console's resolve handler.
    await host.control.waitFor("automation", 2_000);
    return resolved.resolution.decision;
  }

  /** The approval channel the policy guard calls for irreversible actions. */
  private async approve(request: ApprovalRequest): Promise<{ approved: boolean; by?: string; note?: string }> {
    const decision = await this.escalate(
      "approval_required",
      `Policy classified "${request.describe}" as ${request.risk}. A human must approve before it is performed.`,
      { stepIntent: request.describe }
    );
    const approved = decision === "approve" || decision === "resume";
    return { approved, by: "console-operator" };
  }

  // --------------------------------------------------------------------- finish

  private assertBudget(): void {
    const elapsed = Date.now() - this.startedAt.getTime();
    const max = this.opts.policy.config.budgets.maxWallClockMs;
    if (elapsed > max) {
      throw new HardStop({
        classification: "timeout",
        expected: `the run to finish within ${max}ms`,
        observed: `${elapsed}ms elapsed`,
        message: `Replay exceeded its wall-clock budget of ${max}ms.`,
      });
    }
  }

  private async observedSummary(): Promise<string> {
    const text = await this.opts.raw.allText();
    return text.replace(/\s+/g, " ").slice(0, 300);
  }

  private async extractOutputs(): Promise<Record<string, unknown>> {
    const outputs: Record<string, unknown> = {};
    for (const field of this.cap.outputs) {
      const raw = await this.opts.raw.extract(field.extract);
      if (raw === null) {
        if (field.required) {
          throw new HardStop({
            classification: "checkpoint_failed",
            expected: `declared output "${field.name}" to be readable`,
            observed: await this.observedSummary(),
            message: `Reached the success screen but could not read the required output "${field.name}".`,
          });
        }
        continue;
      }
      outputs[field.name] = typeOutput(field, raw);
    }
    return outputs;
  }

  private async finish(): Promise<ReplayResult> {
    // The success outcome is asserted, not assumed. Running out of steps without the
    // success condition holding is a failure, however cleanly the clicks went.
    const success = this.cap.outcomes.find((o) => o.kind === "success");
    if (success) {
      const ctx = await this.context();
      if (!(await evaluate(success.detect, ctx))) {
        return this.fail({
          classification: "checkpoint_failed",
          expected: describeAssertion(success.detect),
          observed: await this.observedSummary(),
          message: `All steps executed, but the success condition does not hold.`,
        });
      }
      return this.terminal(success);
    }
    return this.terminal({
      id: "implicit_success",
      kind: "success",
      code: "SUCCESS",
      description: "All steps completed.",
      detect: { kind: "text_present", text: "" },
      scope: "step",
      afterSteps: [],
      maxAttempts: 1,
    });
  }

  private async terminal(outcome: Outcome): Promise<ReplayResult> {
    let outputs: Record<string, unknown> = {};
    if (outcome.kind === "success") {
      try {
        outputs = await this.extractOutputs();
      } catch (err) {
        if (err instanceof HardStop) return this.fail(err.failure);
        throw err;
      }
    }
    let message = outcome.description;
    if (outcome.callerMessage) {
      // A message template that references an argument the run does not have is an
      // authoring bug, not a reason to lose the outcome.
      try {
        message = renderTemplate(outcome.callerMessage, this.inputs, {});
      } catch {
        message = outcome.callerMessage;
      }
    }

    return this.result({
      status: outcome.kind === "success" ? "success" : outcome.kind === "business" ? "business_outcome" : "failed",
      outcomeCode: outcome.code,
      outcomeKind: outcome.kind,
      message,
      outputs,
      failure:
        outcome.kind === "hard_failure"
          ? {
              stepId: this.currentStepId,
              classification: "app_error",
              expected: "the application to respond normally",
              observed: await this.observedSummary(),
              message,
            }
          : undefined,
    });
  }

  private fail(failure: ReplayFailure): ReplayResult {
    return this.result({
      status: "failed",
      outcomeCode: failure.classification.toUpperCase(),
      outcomeKind: "hard_failure",
      message: failure.message,
      outputs: {},
      failure,
    });
  }

  private result(partial: {
    status: ReplayResult["status"];
    outcomeCode: string;
    outcomeKind: ReplayResult["outcomeKind"];
    message: string;
    outputs: Record<string, unknown>;
    failure?: ReplayFailure;
  }): ReplayResult {
    const escalation = this.escalations.at(-1);
    const result: ReplayResult = {
      capabilityId: this.cap.id,
      capabilityVersion: this.cap.version,
      runId: this.runId,
      status: partial.status,
      outcomeCode: partial.outcomeCode,
      outcomeKind: partial.outcomeKind,
      message: partial.message,
      outputs: partial.outputs,
      steps: this.traces,
      failure: partial.failure,
      escalation: escalation
        ? {
            interventionId: escalation.id,
            reason: escalation.reason,
            raisedAtStep: escalation.context.stepId,
            resolution: (escalation.resolution?.decision === "resume"
              ? "resumed"
              : escalation.resolution?.decision === "abort"
                ? "aborted"
                : escalation.resolution?.decision
                  ? "failed"
                  : "timed_out") as "resumed" | "aborted" | "failed" | "timed_out" | "pending",
            operator: escalation.resolution?.by,
            humanActions: escalation.humanActions.length,
          }
        : undefined,
      driftWarnings: this.driftWarnings,
      evidenceDir: this.opts.host.evidence.dir,
      startedAt: this.startedAt.toISOString(),
      durationMs: Date.now() - this.startedAt.getTime(),
    };
    this.opts.host.evidence.event("run_finished", `Replay finished: ${result.status} / ${result.outcomeCode}`, {
      status: result.status,
      outcomeCode: result.outcomeCode,
      driftWarnings: result.driftWarnings.length,
    });
    // The caller's own result is the one thing not redacted: masking the answer would
    // defeat the purpose of the capability. Everything else in the directory is masked.
    this.opts.host.evidence.writeCallerResult("result.json", result);
    return result;
  }
}

/** Thrown to unwind out of a failed step that a human then completed by hand. */
class ResumeAfterHuman extends Error {
  constructor(readonly stepId: string) {
    super(`Step ${stepId} completed by a human operator.`);
  }
}

export { ResumeAfterHuman };
