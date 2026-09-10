/**
 * The capability catalog.
 *
 * This is the surface an AI agent actually talks to. It turns a directory of artifacts
 * into a set of named, typed, callable capabilities - the same shape a model's
 * tool-use API expects - so the agent asks for "member.savings_balance.lookup with
 * memberId=12345" and never learns that a browser was involved.
 *
 * The catalog is also where the approval gate lives: a draft artifact can be replayed
 * by a human running the CLI, but it cannot be invoked unattended.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCapability, type Capability, type InputParam } from "../schema/capability.js";
import type { ReplayResult } from "../schema/result.js";
import { replayCapability, type RuntimeConfig } from "../runtime.js";

export interface CatalogEntry {
  capability: Capability;
  path: string;
}

/** A capability rendered as a callable tool definition. */
export interface CapabilityTool {
  name: string;
  version: number;
  description: string;
  approval: "draft" | "approved";
  maxRisk: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  outcomes: { code: string; kind: string; description: string }[];
}

export class CapabilityCatalog {
  private readonly entries = new Map<string, CatalogEntry>();

  /** Loads every artifact in `dir` once, keeping the highest version of each id. */
  constructor(private readonly dir: string) {
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const file of files) {
      const path = join(this.dir, file);
      try {
        const capability = parseCapability(JSON.parse(readFileSync(path, "utf8")));
        const existing = this.entries.get(capability.id);
        if (!existing || existing.capability.version < capability.version) {
          this.entries.set(capability.id, { capability, path });
        }
      } catch (err) {
        // A malformed artifact is skipped rather than taking the whole catalog down,
        // but it is never silently ignored.
        process.stderr.write(`  ! skipping ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  list(): CatalogEntry[] {
    return [...this.entries.values()].sort((a, b) => a.capability.id.localeCompare(b.capability.id));
  }

  get(id: string): CatalogEntry | undefined {
    return this.entries.get(id);
  }

  /** The catalog as an AI agent would consume it. */
  tools(): CapabilityTool[] {
    return this.list().map(({ capability }) => ({
      name: capability.id,
      version: capability.version,
      description: capability.description,
      approval: capability.approval,
      maxRisk: capability.maxRisk,
      input_schema: inputSchema(capability.inputs),
      output_schema: outputSchema(capability),
      outcomes: capability.outcomes.map((o) => ({ code: o.code, kind: o.kind, description: o.description })),
    }));
  }

  /**
   * Invoke a capability by name with typed arguments.
   *
   * `unattended` is the production path an agent uses, and it refuses drafts. The same
   * call with `unattended: false` is what a human gets from the CLI, so a capability
   * can be exercised and reviewed before anyone promotes it.
   */
  async invoke(
    id: string,
    args: Record<string, unknown>,
    config: RuntimeConfig,
    options: { unattended?: boolean } = {}
  ): Promise<ReplayResult> {
    const entry = this.get(id);
    if (!entry) throw new Error(`No capability named "${id}" in the catalog.`);
    return replayCapability(entry.capability, args, {
      ...config,
      requireApproved: options.unattended ?? true,
    });
  }
}

export function inputSchema(inputs: InputParam[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const input of inputs) {
    const property: Record<string, unknown> = {
      type: input.type === "enum" ? "string" : input.type,
      description: input.description,
    };
    if (input.enumValues) property["enum"] = input.enumValues;
    if (input.pattern) property["pattern"] = input.pattern;
    // Callers should know which arguments carry regulated data before they send them.
    if (input.sensitivity !== "none") property["x-sensitivity"] = input.sensitivity;
    properties[input.name] = property;
    if (input.required) required.push(input.name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

export function outputSchema(capability: Capability): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const output of capability.outputs) {
    properties[output.name] = {
      type: output.type === "enum" ? "string" : output.type,
      description: output.description,
      ...(output.sensitivity !== "none" ? { "x-sensitivity": output.sensitivity } : {}),
    };
  }
  return {
    type: "object",
    description: "Populated when status is success. Empty for a business outcome.",
    properties,
  };
}
