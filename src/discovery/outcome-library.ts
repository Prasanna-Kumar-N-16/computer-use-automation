/**
 * Loads an application-level outcome library and merges it into a recorded artifact.
 *
 * Keeping these out of the discovery transcript is a deliberate split: the model
 * contributes the *path* through the application, and the platform contributes the
 * *conditions* that path can run into. A happy-path run has no way to observe the
 * second kind, and every capability recorded against the same application shares them.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { OutcomeSchema, type Outcome } from "../schema/capability.js";

const LibrarySchema = z.object({
  surface: z.string(),
  appliesTo: z.string().optional(),
  outcomes: z.array(OutcomeSchema),
});
export type OutcomeLibrary = z.infer<typeof LibrarySchema>;

export function loadOutcomeLibrary(path: string): OutcomeLibrary {
  return LibrarySchema.parse(parseYaml(readFileSync(path, "utf8")));
}

/**
 * Merge library outcomes with the capability's own.
 *
 * The capability's outcomes win on id collision, so a capability can specialise a
 * shared condition without the library having to know it exists. Library outcomes are
 * appended after, which also puts them after the capability's success condition in
 * declaration order - the tie-break the selection policy relies on.
 */
export function mergeOutcomes(own: Outcome[], library: Outcome[]): Outcome[] {
  const seen = new Set(own.map((o) => o.id));
  return [...own, ...library.filter((o) => !seen.has(o.id))];
}
