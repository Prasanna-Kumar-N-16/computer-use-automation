#!/usr/bin/env node
/**
 * Command line entry point.
 *
 *   discover  - one LLM-driven run against a live surface, recorded as an artifact
 *   replay    - deterministic execution of a saved artifact, no model involved
 *   catalog   - the agent-facing view: list, describe, invoke by name
 *   operator  - open a live session and hold it for a human to drive
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CapabilityCatalog } from "./catalog/registry.js";
import { capabilityPath, compileCapability, nextVersion } from "./discovery/compile.js";
import { loadOutcomeLibrary } from "./discovery/outcome-library.js";
import type { DeclaredParam } from "./discovery/prompts.js";
import { parseCapability, type Capability } from "./schema/capability.js";
import { exitCodeFor, type ReplayResult } from "./schema/result.js";
import { defaultConfig, discover, openSession, replayCapability, type RuntimeConfig } from "./runtime.js";
import { readFileSync } from "node:fs";

const CAPABILITIES_DIR = resolve("capabilities");

// ------------------------------------------------------------------ arg parsing

interface Args {
  flags: Record<string, string>;
  repeated: Record<string, string[]>;
  positional: string[];
  bools: Set<string>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {};
  const repeated: Record<string, string[]> = {};
  const positional: string[] = [];
  const bools = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      bools.add(name);
      continue;
    }
    i++;
    flags[name] = next;
    (repeated[name] ??= []).push(next);
  }
  return { flags, repeated, positional, bools };
}

function keyValue(entries: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq < 0) throw new Error(`Expected name=value, got "${entry}".`);
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

function configFrom(args: Args, overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return defaultConfig({
    ...(args.flags["base-url"] ? { baseUrl: args.flags["base-url"] } : {}),
    ...(args.flags["policy"] ? { policyPath: resolve(args.flags["policy"]) } : {}),
    ...(args.flags["operator-port"] ? { operatorPort: Number(args.flags["operator-port"]) } : {}),
    ...(args.bools.has("headed") ? { headless: false } : {}),
    ...overrides,
  });
}

// -------------------------------------------------------------------- reporting

function printResult(result: ReplayResult): void {
  const icon = result.status === "success" ? "✓" : result.status === "business_outcome" ? "•" : "✗";
  console.log("");
  console.log(`${icon} ${result.status.toUpperCase()}  ${result.outcomeCode}`);
  console.log(`  ${result.message}`);
  console.log(`  capability   ${result.capabilityId} v${result.capabilityVersion}`);
  console.log(`  duration     ${result.durationMs}ms across ${result.steps.length} step(s)`);

  if (Object.keys(result.outputs).length) {
    console.log(`  outputs`);
    for (const [key, value] of Object.entries(result.outputs)) {
      console.log(`    ${key} = ${JSON.stringify(value)}`);
    }
  }
  if (result.failure) {
    console.log(`  failure`);
    console.log(`    step         ${result.failure.stepId ?? "(none)"}`);
    console.log(`    class        ${result.failure.classification}`);
    console.log(`    expected     ${result.failure.expected}`);
    console.log(`    observed     ${result.failure.observed}`);
  }
  if (result.escalation) {
    console.log(`  escalation   ${result.escalation.interventionId} -> ${result.escalation.resolution}` +
      (result.escalation.humanActions ? ` (${result.escalation.humanActions} operator action(s))` : ""));
  }
  for (const warning of result.driftWarnings) console.log(`  ⚠ drift      ${warning}`);
  for (const step of result.steps) {
    const mark = step.status === "ok" ? "·" : step.status === "recovered" ? "~" : step.status === "human" ? "h" : "!";
    const via = step.locator?.resolvedBy ? ` via ${step.locator.resolvedBy}` : "";
    const rec = step.recoveries.length ? `  [recovered: ${step.recoveries.map((r) => r.outcomeCode).join(", ")}]` : "";
    console.log(`    ${mark} ${step.stepId.padEnd(4)} ${step.intent}${via}${rec}`);
  }
  console.log(`  evidence     ${result.evidenceDir}`);
  console.log("");
}

// ------------------------------------------------------------------- subcommands

async function cmdDiscover(args: Args): Promise<number> {
  const goal = args.flags["goal"];
  const id = args.flags["id"];
  if (!goal || !id) {
    console.error(`usage: discover --goal "<natural language goal>" --id <capability.id> [--target URL]`);
    console.error(`                [--param name=value] [--param-desc name="..."] [--param-type name=number]`);
    console.error(`                [--outcomes policy/outcomes.<app>.yaml] [--approve-risky] [--headed]`);
    return 2;
  }

  const config = configFrom(args);
  const targetUrl = args.flags["target"] ?? `${config.baseUrl}/desk`;
  const values = keyValue(args.repeated["param"]);
  const descriptions = keyValue(args.repeated["param-desc"]);
  const types = keyValue(args.repeated["param-type"]);

  const params: DeclaredParam[] = Object.entries(values).map(([name, value]) => ({
    name,
    value,
    type: (types[name] as DeclaredParam["type"]) ?? "string",
    description: descriptions[name] ?? `Value supplied for ${name}.`,
  }));

  const library = args.flags["outcomes"] ? loadOutcomeLibrary(resolve(args.flags["outcomes"])) : undefined;

  console.log(`Discovering: ${goal}`);
  console.log(`  target ${targetUrl}`);
  console.log(`  params ${params.map((p) => p.name).join(", ") || "(none)"}`);

  const run = await discover(
    { goal, targetUrl, params, autoApproveRisky: args.bools.has("approve-risky") },
    config
  );

  console.log(`\nDiscovery ${run.result.status} after ${run.result.turns} turn(s).`);
  console.log(`  evidence ${run.evidenceDir}`);

  if (run.result.status !== "succeeded") {
    console.error(`  ${run.result.reason ?? "no reason given"}`);
    console.error(`  No artifact written: only a successful run may be recorded.`);
    return 1;
  }

  const version = nextVersion(CAPABILITIES_DIR, id);
  const capability = compileCapability(run.result, {
    id,
    goal,
    baseUrl: config.baseUrl,
    params,
    library,
    model: run.model,
    runId: run.runId,
    version,
  });

  mkdirSync(CAPABILITIES_DIR, { recursive: true });
  const path = capabilityPath(CAPABILITIES_DIR, capability);
  writeFileSync(path, JSON.stringify(capability, null, 2) + "\n");

  console.log(`\n✓ Recorded ${capability.id} v${capability.version} (${capability.steps.length} steps, ` +
    `${capability.outputs.length} output(s), ${capability.outcomes.length} outcomes, risk ${capability.maxRisk})`);
  console.log(`  ${path}`);
  console.log(`  Approval state is "draft". Review it, then promote it before unattended use.`);
  return 0;
}

function loadCapability(id: string, version?: number): Capability {
  const catalog = new CapabilityCatalog(CAPABILITIES_DIR);
  if (version !== undefined) {
    const path = resolve(CAPABILITIES_DIR, `${id}@v${version}.json`);
    return parseCapability(JSON.parse(readFileSync(path, "utf8")));
  }
  const entry = catalog.get(id);
  if (!entry) throw new Error(`No capability "${id}" in ${CAPABILITIES_DIR}.`);
  return entry.capability;
}

async function cmdReplay(args: Args): Promise<number> {
  const id = args.flags["capability"] ?? args.positional[0];
  if (!id) {
    console.error(`usage: replay --capability <id> [--version N] [--input name=value ...] [--unattended] [--headed]`);
    return 2;
  }
  const capability = loadCapability(id, args.flags["version"] ? Number(args.flags["version"]) : undefined);
  const inputs = keyValue(args.repeated["input"]);
  const config = configFrom(args, { requireApproved: args.bools.has("unattended") });

  console.log(`Replaying ${capability.id} v${capability.version} with ${JSON.stringify(inputs)}`);
  const result = await replayCapability(capability, inputs, config);
  printResult(result);
  return exitCodeFor(result);
}

async function cmdCatalog(args: Args): Promise<number> {
  const catalog = new CapabilityCatalog(CAPABILITIES_DIR);
  const sub = args.positional[0] ?? "list";

  if (sub === "list") {
    const tools = catalog.tools();
    if (!tools.length) {
      console.log(`No capabilities in ${CAPABILITIES_DIR}. Record one with "npm run discover".`);
      return 0;
    }
    console.log(`\n${tools.length} capability/capabilities available to a calling agent:\n`);
    for (const tool of tools) {
      const required = (tool.input_schema["required"] as string[]) ?? [];
      console.log(`  ${tool.name}  v${tool.version}  [${tool.approval}, risk ${tool.maxRisk}]`);
      console.log(`    ${tool.description}`);
      console.log(`    args:    ${required.join(", ") || "(none)"}`);
      console.log(`    returns: ${Object.keys(tool.output_schema["properties"] as object).join(", ") || "(none)"}`);
      console.log(`    outcomes: ${tool.outcomes.map((o) => o.code).join(", ")}`);
      console.log("");
    }
    return 0;
  }

  if (sub === "describe") {
    const id = args.positional[1] ?? args.flags["capability"];
    if (!id) {
      console.error("usage: catalog describe <capability.id>");
      return 2;
    }
    const tool = catalog.tools().find((t) => t.name === id);
    if (!tool) {
      console.error(`No capability "${id}".`);
      return 1;
    }
    console.log(JSON.stringify(tool, null, 2));
    return 0;
  }

  if (sub === "invoke") {
    const id = args.positional[1] ?? args.flags["capability"];
    if (!id) {
      console.error(`usage: catalog invoke <capability.id> --args '{"memberId":"12345"}'`);
      return 2;
    }
    const rawArgs = args.flags["args"] ?? "{}";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawArgs);
    } catch {
      console.error(`--args must be valid JSON, got: ${rawArgs}`);
      return 2;
    }
    // Unattended by default: this is the production path, so drafts are refused.
    const unattended = !args.bools.has("attended");
    console.log(`Invoking ${id} with ${rawArgs}${unattended ? " (unattended)" : " (attended)"}`);
    const result = await catalog.invoke(id, parsed, configFrom(args), { unattended });
    printResult(result);
    return exitCodeFor(result);
  }

  console.error(`Unknown catalog subcommand "${sub}". Try list, describe, or invoke.`);
  return 2;
}

async function cmdOperator(args: Args): Promise<number> {
  const config = configFrom(args);
  const session = await openSession(config);
  await session.host.signOn();
  await session.host.surface.act({ kind: "navigate", url: `${config.baseUrl}/desk` });
  console.log(`\nLive session ${session.host.runId} is open and signed on.`);
  console.log(`Operator console: http://localhost:${config.operatorPort}`);
  console.log(`Ctrl-C to close the session.\n`);
  await new Promise<void>((resolvePromise) => {
    process.on("SIGINT", () => resolvePromise());
  });
  await session.close();
  return 0;
}

// --------------------------------------------------------------------- dispatch

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (command) {
    case "discover":
      return cmdDiscover(args);
    case "replay":
      return cmdReplay(args);
    case "catalog":
      return cmdCatalog(args);
    case "operator":
      return cmdOperator(args);
    default:
      console.error(`usage: cli.ts <discover|replay|catalog|operator> [options]`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
    if (process.env["CUA_DEBUG"]) console.error(err);
    process.exit(1);
  });
