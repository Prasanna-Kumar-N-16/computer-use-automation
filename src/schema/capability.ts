/**
 * The capability artifact: what a discovery run produces and a deterministic replay
 * consumes. This is the contract between the model that discovered the flow, the
 * human who reviews it, and the AI agent that invokes it in production.
 *
 * Design commitments worth arguing about:
 *
 *  - Outcomes sit beside steps, not inside error handling. "No such member" is a
 *    declared result with a code, because the calling agent needs to branch on it.
 *    Modelling it as an exception is the mistake this schema exists to prevent.
 *
 *  - Every step carries a natural-language `intent` alongside its machine target, so
 *    the artifact stays reviewable by a compliance-minded human who will never read
 *    a locator strategy.
 *
 *  - Inputs declare `sensitivity`. Redaction is then a property of the schema rather
 *    than something each log statement has to remember.
 *
 *  - `provenance.appFingerprint` records what the application looked like when the
 *    flow was recorded, which is the hook for drift detection and for deciding
 *    whether a tenant can reuse a base artifact.
 */

import { z } from "zod";
import {
  AssertionSchema,
  ExtractionSpecSchema,
  LocatorBundleSchema,
  ValueSourceSchema,
} from "./common.js";

/** Bumped when the artifact format changes incompatibly. Replay refuses unknown majors. */
export const ARTIFACT_SCHEMA_VERSION = "1.0";

// ---------------------------------------------------------------------- typing

export const ParamTypeSchema = z.enum(["string", "number", "boolean", "enum"]);

/**
 * `none`   - safe to log and persist
 * `pii`    - regulated personal data: masked in logs, never written to an artifact
 * `secret` - credentials and tokens: never logged, never persisted, resolved at runtime
 */
export const SensitivitySchema = z.enum(["none", "pii", "secret"]).default("none");

export const InputParamSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: ParamTypeSchema,
  required: z.boolean().default(true),
  description: z.string(),
  sensitivity: SensitivitySchema,
  enumValues: z.array(z.string()).optional(),
  pattern: z.string().optional(),
  /** Example values are for humans and for the catalog. Never an example of real PII. */
  example: z.string().optional(),
});
export type InputParam = z.infer<typeof InputParamSchema>;

export const OutputFieldSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: ParamTypeSchema,
  description: z.string(),
  required: z.boolean().default(true),
  sensitivity: SensitivitySchema,
  extract: ExtractionSpecSchema,
});
export type OutputField = z.infer<typeof OutputFieldSchema>;

// ----------------------------------------------------------------------- steps

/**
 * Risk classification drives the guardrail, not the operator's memory.
 *
 * `safe`         - read-only navigation and inspection
 * `sensitive`    - writes state that can be undone in-app
 * `irreversible` - posts to the core, moves money, or cannot be undone from the UI
 */
export const RiskSchema = z.enum(["safe", "sensitive", "irreversible"]).default("safe");
export type Risk = z.infer<typeof RiskSchema>;

export const StepActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), urlTemplate: z.string() }),
  z.object({ kind: z.literal("click"), target: LocatorBundleSchema }),
  z.object({
    kind: z.literal("type"),
    target: LocatorBundleSchema,
    value: ValueSourceSchema,
    clearFirst: z.boolean().default(true),
    /** Submit the owning form by pressing Enter instead of clicking a button. */
    pressEnter: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("select"), target: LocatorBundleSchema, value: ValueSourceSchema }),
  z.object({ kind: z.literal("press"), key: z.string(), target: LocatorBundleSchema.optional() }),
  z.object({ kind: z.literal("wait_for"), assertion: AssertionSchema, timeoutMs: z.number().int().default(15_000) }),
]);
export type StepAction = z.infer<typeof StepActionSchema>;

export const StepSchema = z.object({
  id: z.string(),
  /** What a human would say they were doing. Carried for review, never executed. */
  intent: z.string(),
  action: StepActionSchema,
  risk: RiskSchema,
  /** Conditions that must hold before the action is attempted. */
  waitFor: z.array(AssertionSchema).default([]),
  /**
   * Proof the step actually worked. Without this, replay is a sequence of hopeful
   * clicks; with it, every step either verifies or reports precisely where it lost
   * the plot.
   */
  checkpoint: AssertionSchema.optional(),
  timeoutMs: z.number().int().default(15_000),
});
export type Step = z.infer<typeof StepSchema>;

// -------------------------------------------------------------------- outcomes

/**
 * The error taxonomy, expressed as data.
 *
 * `success`      - the goal was reached; declared outputs are extracted
 * `business`     - a legitimate answer the caller must branch on (not found, denied)
 * `recoverable`  - a runtime condition replay is allowed to handle and continue past
 * `hard_failure` - stop, escalate or fail, and surface a debuggable error
 */
export const OutcomeKindSchema = z.enum(["success", "business", "recoverable", "hard_failure"]);
export type OutcomeKind = z.infer<typeof OutcomeKindSchema>;

export const RecoveryActionSchema = z.discriminatedUnion("action", [
  /** Click something that makes a blocking overlay go away, then re-check. */
  z.object({ action: z.literal("dismiss_element"), target: LocatorBundleSchema }),
  /** Wait out transient slowness, then retry the step that was interrupted. */
  z.object({ action: z.literal("wait_and_retry"), waitMs: z.number().int().default(2_000) }),
  /** Re-establish the session through the runtime auth provider, then retry. */
  z.object({ action: z.literal("reauthenticate") }),
  z.object({ action: z.literal("reload") }),
]);
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

export const OutcomeSchema = z.object({
  id: z.string(),
  kind: OutcomeKindSchema,
  /** Stable machine code the calling agent branches on, e.g. MEMBER_NOT_FOUND. */
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  description: z.string(),
  detect: AssertionSchema,
  /**
   * `global` outcomes are evaluated before and after every step, because session
   * expiry and broadcast dialogs do not respect step boundaries. `step` outcomes are
   * only evaluated after the steps named in `afterSteps`.
   */
  scope: z.enum(["global", "step"]).default("step"),
  afterSteps: z.array(z.string()).default([]),
  /** Required when kind is `recoverable`. */
  recovery: RecoveryActionSchema.optional(),
  maxAttempts: z.number().int().positive().default(2),
  /** Message template surfaced to the caller. May reference {paramName}. */
  callerMessage: z.string().optional(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

// ------------------------------------------------------------------ capability

export const SurfaceSpecSchema = z.object({
  /** Which adapter executes this artifact. Extending here is how a desktop app arrives. */
  kind: z.enum(["web", "desktop", "terminal"]).default("web"),
  /** May contain {paramName} placeholders and a {baseUrl} supplied by the runtime. */
  entryUrlTemplate: z.string(),
  /** Preconditions the runtime satisfies before step 1, e.g. an authenticated session. */
  requires: z.array(z.enum(["authenticated_session"])).default([]),
  viewport: z.object({ width: z.number().int(), height: z.number().int() }).default({ width: 1280, height: 900 }),
});

/**
 * A cheap structural signature of the application as it looked at record time.
 * Cross-tenant reuse and drift detection both hang off this: a replay whose observed
 * fingerprint diverges from the recorded one is a warning worth surfacing long before
 * it becomes a failure.
 */
export const AppFingerprintSchema = z.object({
  appName: z.string().optional(),
  appVersion: z.string().optional(),
  entryTitle: z.string().optional(),
  /** Hash over the stable structural signals of the entry screen. */
  structureHash: z.string().optional(),
});
export type AppFingerprint = z.infer<typeof AppFingerprintSchema>;

export const ProvenanceSchema = z.object({
  recordedAt: z.string(),
  /** Which model discovered the flow, for audit and for re-recording decisions. */
  model: z.string().optional(),
  discoveryRunId: z.string().optional(),
  goal: z.string().optional(),
  /** Which tenant/institution this was recorded against. */
  tenant: z.string().default("default"),
  appFingerprint: AppFingerprintSchema.default({}),
});

export const CapabilitySchema = z.object({
  schemaVersion: z.string().default(ARTIFACT_SCHEMA_VERSION),
  /** Stable dotted identifier the calling agent uses, e.g. member.savings_balance.lookup. */
  id: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/),
  version: z.number().int().positive().default(1),
  name: z.string(),
  /** Written for the calling agent: what this does, when to reach for it. */
  description: z.string(),

  surface: SurfaceSpecSchema,
  inputs: z.array(InputParamSchema).default([]),
  outputs: z.array(OutputFieldSchema).default([]),

  preconditions: z.array(AssertionSchema).default([]),
  steps: z.array(StepSchema).min(1),
  outcomes: z.array(OutcomeSchema).min(1),

  /**
   * `draft` artifacts may be replayed by a human running the CLI, but the catalog
   * refuses to invoke them unattended. Promotion is a deliberate human act.
   */
  approval: z.enum(["draft", "approved"]).default("draft"),
  /** Highest risk level any step carries. Derived, but persisted so reviewers see it. */
  maxRisk: RiskSchema,

  provenance: ProvenanceSchema,
});
export type Capability = z.infer<typeof CapabilitySchema>;

/** Parse and validate an artifact, rejecting incompatible schema majors. */
export function parseCapability(raw: unknown): Capability {
  const cap = CapabilitySchema.parse(raw);
  const major = cap.schemaVersion.split(".")[0];
  const supported = ARTIFACT_SCHEMA_VERSION.split(".")[0];
  if (major !== supported) {
    throw new Error(
      `Artifact ${cap.id} declares schema version ${cap.schemaVersion}; this runtime supports ${supported}.x only.`
    );
  }
  return cap;
}

export function artifactFilename(cap: Pick<Capability, "id" | "version">): string {
  return `${cap.id}@v${cap.version}.json`;
}
