/**
 * The guardrail.
 *
 * Enforcement lives in exactly one place - `GuardedSurface` - and both the discovery
 * agent and the replay engine are handed a guarded surface rather than a raw one.
 * A future code path cannot forget to check, because there is no unguarded surface to
 * act through.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { RedactionConfigSchema, Redactor } from "./redact.js";
import type { Risk } from "../schema/capability.js";
import type {
  Action,
  ActionResult,
  Observation,
  ObservedElement,
  Resolution,
  Surface,
  SurfaceFingerprint,
} from "../surface/types.js";
import type { ExtractionSpec, LocatorBundle } from "../schema/common.js";

const RiskRulesSchema = z.object({
  controlNames: z.array(z.string()).default([]),
  textPatterns: z.array(z.string()).default([]),
});

export const PolicyConfigSchema = z.object({
  version: z.number().default(1),
  surfaces: z.object({
    web: z.object({
      allowedOrigins: z.array(z.string()).default([]),
      allowedPathPatterns: z.array(z.string()).default([]),
      deniedPathPatterns: z.array(z.string()).default([]),
      allowedActions: z.array(z.string()).default([]),
    }),
  }),
  budgets: z.object({
    maxDiscoverySteps: z.number().int().default(25),
    maxReplayActions: z.number().int().default(80),
    maxWallClockMs: z.number().int().default(240_000),
  }),
  risk: z.object({
    irreversible: RiskRulesSchema.default({}),
    sensitive: RiskRulesSchema.default({}),
    handling: z.object({
      irreversible: z.enum(["block", "require_human_approval", "flag"]).default("require_human_approval"),
      sensitive: z.enum(["block", "require_human_approval", "flag"]).default("flag"),
    }),
  }),
  redaction: RedactionConfigSchema,
});
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

export class PolicyViolation extends Error {
  constructor(
    message: string,
    readonly detail: { rule: string; action?: string; url?: string; risk?: Risk }
  ) {
    super(message);
    this.name = "PolicyViolation";
  }
}

export interface ApprovalRequest {
  risk: Risk;
  action: Action;
  element?: ObservedElement;
  describe: string;
}

export interface ApprovalDecision {
  approved: boolean;
  by?: string;
  note?: string;
}

export class PolicyEngine {
  readonly redactor: Redactor;

  constructor(readonly config: PolicyConfig) {
    this.redactor = new Redactor(config.redaction);
  }

  static load(path: string): PolicyEngine {
    return new PolicyEngine(PolicyConfigSchema.parse(parseYaml(readFileSync(path, "utf8"))));
  }

  /** Origin and route allowlist. Denied patterns take precedence over allowed ones. */
  checkNavigation(rawUrl: string): { allowed: boolean; reason: string } {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allowed: false, reason: `"${rawUrl}" is not an absolute URL` };
    }
    const web = this.config.surfaces.web;
    if (!web.allowedOrigins.includes(url.origin)) {
      return { allowed: false, reason: `origin ${url.origin} is not on the allowlist` };
    }
    for (const pattern of web.deniedPathPatterns) {
      if (compilePattern(pattern).test(url.pathname)) {
        return { allowed: false, reason: `path ${url.pathname} matches denied pattern ${pattern}` };
      }
    }
    if (web.allowedPathPatterns.length === 0) return { allowed: true, reason: "no route restrictions" };
    for (const pattern of web.allowedPathPatterns) {
      if (compilePattern(pattern).test(url.pathname)) return { allowed: true, reason: `matched ${pattern}` };
    }
    return { allowed: false, reason: `path ${url.pathname} matches no allowed route pattern` };
  }

  isActionAllowed(kind: string): boolean {
    return this.config.surfaces.web.allowedActions.includes(kind);
  }

  /**
   * Classify how dangerous acting on a control is.
   *
   * Matching on the control's `name` attribute first is deliberate: the visible label
   * is what a tenant rebrands, while the name attribute is part of the server
   * contract. Classifying on the durable signal means a rebranded "Post Account"
   * button does not quietly become a safe action.
   */
  classifyRisk(element?: ObservedElement): Risk {
    if (!element) return "safe";
    const controlName = element.meta?.["controlName"] ?? "";
    const label = `${element.name} ${element.value ?? ""}`.trim();
    const rules = this.config.risk;

    if (matches(rules.irreversible, controlName, label)) return "irreversible";
    if (matches(rules.sensitive, controlName, label)) return "sensitive";
    return "safe";
  }

  handlingFor(risk: Risk): "block" | "require_human_approval" | "flag" | "allow" {
    if (risk === "irreversible") return this.config.risk.handling.irreversible;
    if (risk === "sensitive") return this.config.risk.handling.sensitive;
    return "allow";
  }
}

function matches(rules: { controlNames: string[]; textPatterns: string[] }, controlName: string, label: string): boolean {
  if (controlName && rules.controlNames.includes(controlName)) return true;
  return rules.textPatterns.some((p) => compilePattern(p).test(label));
}

/**
 * Compile a configured pattern.
 *
 * Policy files are written by security reviewers, not JavaScript programmers, and a
 * leading `(?i)` is the notation almost everyone reaches for. JavaScript rejects it
 * outright, so it is translated to the `i` flag rather than left to fail at runtime -
 * a guardrail that throws when it is asked to classify is a guardrail that is not
 * classifying.
 */
export function compilePattern(pattern: string): RegExp {
  const inline = /^\(\?([a-z]+)\)/.exec(pattern);
  if (inline) return new RegExp(pattern.slice(inline[0].length), inline[1]);
  return new RegExp(pattern);
}

// ------------------------------------------------------------------ chokepoint

export interface GuardEvent {
  type: "blocked" | "flagged" | "approval_requested" | "approval_granted" | "approval_denied";
  risk: Risk;
  describe: string;
  reason?: string;
}

export interface GuardedSurfaceOptions {
  budget: number;
  onEvent?: (event: GuardEvent) => void;
  /** Wired to the escalation channel. Absent means irreversible actions are refused. */
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}

/**
 * A `Surface` that refuses to do anything the policy disallows.
 *
 * Read paths (observe, resolve, extract, screenshot) pass straight through - looking
 * is always permitted. Only `act` is gated, because acting is what changes a bank's
 * records.
 */
export class GuardedSurface implements Surface {
  readonly kind: Surface["kind"];
  private actions = 0;
  private lastObservation?: Observation;

  constructor(
    private readonly inner: Surface,
    private readonly policy: PolicyEngine,
    private readonly options: GuardedSurfaceOptions
  ) {
    this.kind = inner.kind;
  }

  async observe(): Promise<Observation> {
    this.lastObservation = await this.inner.observe();
    return this.lastObservation;
  }

  settle(timeoutMs?: number): Promise<void> {
    return this.inner.settle(timeoutMs);
  }
  screenshot(): Promise<Buffer> {
    return this.inner.screenshot();
  }
  resolve(bundle: LocatorBundle): Promise<Resolution> {
    return this.inner.resolve(bundle);
  }
  describeElement(ref: string): Promise<LocatorBundle> {
    return this.inner.describeElement(ref);
  }
  extract(spec: ExtractionSpec): Promise<string | null> {
    return this.inner.extract(spec);
  }
  fingerprint(): Promise<SurfaceFingerprint> {
    return this.inner.fingerprint();
  }

  /**
   * Find the element an action targets, so its risk can be classified.
   *
   * A ref produced by `resolve()` may post-date the last observation, so a miss
   * triggers a re-observation rather than a silent `undefined` - and an unclassifiable
   * element must never be allowed to default to `safe`.
   */
  private async elementFor(action: Action): Promise<ObservedElement | undefined> {
    const ref = "ref" in action ? action.ref : undefined;
    if (!ref) return undefined;
    let found = this.lastObservation?.elements.find((e) => e.ref === ref);
    if (!found) {
      await this.observe();
      found = this.lastObservation?.elements.find((e) => e.ref === ref);
    }
    return found;
  }

  async act(action: Action): Promise<ActionResult> {
    if (this.actions >= this.options.budget) {
      throw new PolicyViolation(`Action budget of ${this.options.budget} exhausted.`, {
        rule: "budget",
        action: action.kind,
      });
    }

    if (!this.policy.isActionAllowed(action.kind)) {
      this.emit({ type: "blocked", risk: "safe", describe: action.kind, reason: "action type not permitted" });
      throw new PolicyViolation(`Action type "${action.kind}" is not permitted by policy.`, {
        rule: "allowed_actions",
        action: action.kind,
      });
    }

    if (action.kind === "navigate") {
      const verdict = this.policy.checkNavigation(action.url);
      if (!verdict.allowed) {
        this.emit({ type: "blocked", risk: "safe", describe: action.url, reason: verdict.reason });
        throw new PolicyViolation(`Navigation to ${action.url} refused: ${verdict.reason}`, {
          rule: "allowlist",
          action: "navigate",
          url: action.url,
        });
      }
    }

    const element = await this.elementFor(action);
    const risk = this.policy.classifyRisk(element);
    const describe = element ? `${element.role} "${element.name}"` : action.kind;
    const handling = this.policy.handlingFor(risk);

    if (handling === "block") {
      this.emit({ type: "blocked", risk, describe, reason: `${risk} actions are blocked by policy` });
      throw new PolicyViolation(`Refusing ${risk} action on ${describe}.`, { rule: "risk_handling", risk });
    }

    if (handling === "require_human_approval") {
      if (!this.options.requestApproval) {
        this.emit({ type: "blocked", risk, describe, reason: "no approval channel available" });
        throw new PolicyViolation(
          `${describe} is classified ${risk} and requires human approval, but no approval channel is configured.`,
          { rule: "risk_handling", risk }
        );
      }
      this.emit({ type: "approval_requested", risk, describe });
      const decision = await this.options.requestApproval({ risk, action, element, describe });
      if (!decision.approved) {
        this.emit({ type: "approval_denied", risk, describe, reason: decision.note });
        throw new PolicyViolation(`Human approval denied for ${describe}.`, { rule: "risk_handling", risk });
      }
      this.emit({ type: "approval_granted", risk, describe, reason: decision.by });
    } else if (handling === "flag") {
      this.emit({ type: "flagged", risk, describe });
    }

    this.actions += 1;
    return this.inner.act(action);
  }

  private emit(event: GuardEvent): void {
    this.options.onEvent?.(event);
  }
}
