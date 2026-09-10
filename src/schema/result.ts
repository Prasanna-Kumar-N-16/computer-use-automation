/**
 * The replay result contract - what an AI agent actually receives when it invokes a
 * capability.
 *
 * The top-level split is the whole point. A caller has to be able to tell
 * "the member does not exist" (a fact about the world, worth acting on) from
 * "the automation broke" (an operational problem, worth paging someone about)
 * without parsing a message string.
 */

import { z } from "zod";
import { OutcomeKindSchema } from "./capability.js";

export const StepTraceSchema = z.object({
  stepId: z.string(),
  intent: z.string(),
  action: z.string(),
  status: z.enum(["ok", "recovered", "failed", "skipped", "human"]),
  startedAt: z.string(),
  durationMs: z.number(),
  /** Which locator strategy actually resolved the control, and whether others agreed. */
  locator: z
    .object({
      resolvedBy: z.string(),
      attempted: z.array(z.object({ kind: z.string(), matches: z.number(), note: z.string().optional() })),
      /** Strategies that resolved to a *different* element than the winner. */
      disagreements: z.array(z.string()).default([]),
    })
    .optional(),
  checkpoint: z.object({ passed: z.boolean(), describe: z.string() }).optional(),
  recoveries: z
    .array(z.object({ outcomeCode: z.string(), action: z.string(), attempt: z.number() }))
    .default([]),
  note: z.string().optional(),
});
export type StepTrace = z.infer<typeof StepTraceSchema>;

export const ReplayFailureSchema = z.object({
  stepId: z.string().optional(),
  /** Why it stopped, in the same taxonomy the artifact uses. */
  classification: z.enum([
    "checkpoint_failed",
    "locator_unresolved",
    "locator_ambiguous",
    "timeout",
    "policy_blocked",
    "app_error",
    "recovery_exhausted",
    "escalation_unresolved",
    "precondition_failed",
    "input_invalid",
    "internal_error",
  ]),
  expected: z.string(),
  observed: z.string(),
  message: z.string(),
});
export type ReplayFailure = z.infer<typeof ReplayFailureSchema>;

export const EscalationSummarySchema = z.object({
  interventionId: z.string(),
  reason: z.string(),
  raisedAtStep: z.string().optional(),
  resolution: z.enum(["resumed", "aborted", "failed", "timed_out", "pending"]),
  operator: z.string().optional(),
  humanActions: z.number().default(0),
});

export const ReplayResultSchema = z.object({
  capabilityId: z.string(),
  capabilityVersion: z.number(),
  runId: z.string(),

  /**
   * success         - goal reached, `outputs` populated
   * business_outcome- a declared, legitimate non-success answer; `outcomeCode` says which
   * failed          - the automation could not complete; `failure` says why
   */
  status: z.enum(["success", "business_outcome", "failed"]),
  outcomeCode: z.string(),
  outcomeKind: OutcomeKindSchema,
  message: z.string(),

  outputs: z.record(z.unknown()).default({}),
  steps: z.array(StepTraceSchema).default([]),
  failure: ReplayFailureSchema.optional(),
  escalation: EscalationSummarySchema.optional(),

  /** Recorded fingerprint vs. what replay actually saw. A mismatch is a drift warning. */
  driftWarnings: z.array(z.string()).default([]),

  evidenceDir: z.string(),
  startedAt: z.string(),
  durationMs: z.number(),
});
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

/** Process exit code. A business outcome is a successful invocation, so it exits 0. */
export function exitCodeFor(result: ReplayResult): number {
  return result.status === "failed" ? 1 : 0;
}
