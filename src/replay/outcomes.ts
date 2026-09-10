/**
 * Outcome selection.
 *
 * Replay evaluates every outcome declared by the capability against the current
 * screen. Frequently more than one matches at the same time, and which one governs
 * decides what the caller is told and whether the run continues.
 *
 * Real cases from the target application:
 *
 *   - The nightly-batch overlay (recoverable) sits on top of the relationship summary
 *     (success). Both detect true. Dismissing first and re-evaluating yields the right
 *     answer; treating it as success first yields a balance read through a dialog.
 *
 *   - The session-timeout screen (recoverable, via reauthenticate) can be showing at
 *     the same moment the app-error text is still in another frame (hard_failure).
 *
 *   - A "no member record found" page (business) and a generic "no results" pattern
 *     could both be declared; the more specific one should win.
 *
 * Attempt budgets matter too: a recoverable outcome that has already been applied
 * `maxAttempts` times without clearing must stop being chosen, or the run loops until
 * the wall-clock budget kills it with a useless error.
 */

import type { Outcome } from "../schema/capability.js";

export interface OutcomeSelectionContext {
  /** How many times each outcome has already been applied during this run, by outcome id. */
  attempts: Record<string, number>;
  /** The step currently executing, or undefined during preconditions. */
  currentStepId?: string;
}

/**
 * Choose which of the currently-matching outcomes governs.
 *
 * Precedence: recoverable, then hard failure, then business, then success. Ties within
 * a kind are broken by declaration order, so the artifact author expresses specificity
 * by listing the specific outcome before the catch-all, and the same screen always
 * produces the same answer.
 *
 * @param matched  every outcome whose `detect` assertion evaluated true, in the order
 *                 they are declared in the artifact
 * @param ctx      per-run attempt counts, used to retire exhausted recoveries
 * @returns        the governing outcome, or undefined to carry on with the next step
 */
export function selectGoverningOutcome(
  matched: Outcome[],
  ctx: OutcomeSelectionContext
): Outcome | undefined {
  // Recoverable conditions are, by construction, things that obscure the truth: an
  // overlay covering the answer, an expired session hiding every screen. Clearing them
  // first and re-evaluating is the only way to find out what is really underneath.
  const live = (o: Outcome) => (ctx.attempts[o.id] ?? 0) < o.maxAttempts;
  const recoverable = matched.filter((o) => o.kind === "recoverable" && live(o));
  if (recoverable.length > 0) return recoverable[0];

  // A recoverable that has burned its attempts is retired rather than retried forever.
  // Whatever else matches now governs; if nothing does, the step falls through to its
  // own checkpoint, which fails with a real expected-versus-observed report.
  for (const kind of ["hard_failure", "business", "success"] as const) {
    const hit = matched.find((o) => o.kind === kind);
    if (hit) return hit;
  }
  return undefined;
}

/** Kinds that end the run when they govern. */
export const TERMINAL_KINDS = new Set(["success", "business", "hard_failure"]);
