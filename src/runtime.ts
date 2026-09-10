/**
 * Composition root.
 *
 * Everything that needs a browser, a policy, an escalation channel, and an evidence
 * directory gets it from here, so the CLI, the catalog, and the tests all assemble the
 * system the same way.
 */

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { PolicyEngine } from "./policy/engine.js";
import { SessionHost } from "./session/host.js";
import { InterventionStore, type Intervention } from "./escalation/store.js";
import { OperatorConsole } from "./escalation/console.js";
import { ReplayEngine } from "./replay/engine.js";
import { DiscoveryAgent, type DiscoveryResult } from "./discovery/agent.js";
import { AnthropicClient, type LlmClient } from "./discovery/llm.js";
import type { DeclaredParam } from "./discovery/prompts.js";
import type { Capability } from "./schema/capability.js";
import type { ReplayResult } from "./schema/result.js";

loadEnv();

export interface RuntimeConfig {
  baseUrl: string;
  policyPath: string;
  evidenceRoot: string;
  headless: boolean;
  operatorPort: number;
  operatorId: string;
  password: string;
  escalationTimeoutMs: number;
  requireApproved: boolean;
}

export function defaultConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    baseUrl: process.env["LEGACY_CORE_URL"] ?? `http://localhost:${process.env["LEGACY_CORE_PORT"] ?? 4173}`,
    policyPath: resolve("policy/allowlist.yaml"),
    evidenceRoot: resolve("evidence"),
    headless: process.env["CUA_HEADLESS"] !== "false",
    operatorPort: Number(process.env["OPERATOR_PORT"] ?? 4180),
    operatorId: process.env["LEGACY_CORE_OPERATOR"] ?? "OPR01",
    // A demo credential for a mock application. Real deployments resolve this from a
    // secrets manager; either way it is registered with the redactor before use and
    // never reaches an artifact or a log.
    password: process.env["LEGACY_CORE_PASSWORD"] ?? "demo",
    escalationTimeoutMs: Number(process.env["CUA_ESCALATION_TIMEOUT_MS"] ?? 120_000),
    requireApproved: false,
    ...overrides,
  };
}

export interface Session {
  host: SessionHost;
  policy: PolicyEngine;
  store: InterventionStore;
  console: OperatorConsole;
  close(): Promise<void>;
}

/** Start a browser session with an operator console attached to it. */
export async function openSession(config: RuntimeConfig, runId?: string): Promise<Session> {
  const policy = PolicyEngine.load(config.policyPath);
  const store = new InterventionStore();
  const host = new SessionHost({
    baseUrl: config.baseUrl,
    policy,
    evidenceRoot: config.evidenceRoot,
    runId,
    headless: config.headless,
    operatorId: config.operatorId,
    password: config.password,
  });
  await host.start();

  const operatorConsole = new OperatorConsole({ port: config.operatorPort, host, store });
  await operatorConsole.start();

  return {
    host,
    policy,
    store,
    console: operatorConsole,
    async close() {
      await operatorConsole.stop();
      await host.close();
    },
  };
}

export function announceEscalation(config: RuntimeConfig) {
  return (intervention: Intervention) => {
    const url = `http://localhost:${config.operatorPort}/i/${intervention.id}`;
    process.stderr.write(
      [
        ``,
        `  ⏸  AUTOMATION PAUSED - human intervention required`,
        `     ${intervention.reason}`,
        `     Take control here: ${url}`,
        `     Waiting up to ${Math.round(config.escalationTimeoutMs / 1000)}s for an operator.`,
        ``,
      ].join("\n")
    );
  };
}

export async function replayCapability(
  capability: Capability,
  inputs: Record<string, unknown>,
  config: RuntimeConfig
): Promise<ReplayResult> {
  const session = await openSession(config);
  try {
    const engine = new ReplayEngine({
      capability,
      inputs,
      host: session.host,
      raw: session.host.surface,
      policy: session.policy,
      store: session.store,
      baseUrl: config.baseUrl,
      escalationTimeoutMs: config.escalationTimeoutMs,
      onEscalation: announceEscalation(config),
      requireApproved: config.requireApproved,
    });
    return await engine.run();
  } finally {
    await session.close();
  }
}

export interface DiscoveryRun {
  result: DiscoveryResult;
  runId: string;
  model: string;
  evidenceDir: string;
}

export async function discover(
  options: {
    goal: string;
    targetUrl: string;
    params: DeclaredParam[];
    autoApproveRisky?: boolean;
    llm?: LlmClient;
  },
  config: RuntimeConfig
): Promise<DiscoveryRun> {
  const session = await openSession(config);
  const llm = options.llm ?? new AnthropicClient();
  try {
    const agent = new DiscoveryAgent({
      goal: options.goal,
      targetUrl: options.targetUrl,
      baseUrl: config.baseUrl,
      params: options.params,
      host: session.host,
      raw: session.host.surface,
      policy: session.policy,
      llm,
      store: session.store,
      escalationTimeoutMs: config.escalationTimeoutMs,
      onEscalation: announceEscalation(config),
      autoApproveRisky: options.autoApproveRisky,
    });
    const result = await agent.run();
    return { result, runId: session.host.runId, model: llm.model, evidenceDir: session.host.evidence.dir };
  } finally {
    await session.close();
  }
}
