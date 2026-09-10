/**
 * The discovery loop: observe, decide, act, until the goal is met.
 *
 * This is the only place a model is ever in the decision path. Everything it does here
 * is recorded so that it never has to be here again.
 *
 * Two rules keep the recording honest:
 *
 *   - At most one action is executed per turn. The model may emit several tool calls,
 *     but element references are only valid for the screen that produced them, so
 *     acting on a stale reference would be acting blind. The rest are refused with an
 *     explanation rather than executed hopefully.
 *
 *   - The locator bundle for each control is captured *before* the action, from the
 *     screen the model was actually looking at. Recording it afterwards would describe
 *     a control on a page that has already moved on.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { LocatorBundle } from "../schema/common.js";
import type { Risk } from "../schema/capability.js";
import type { GuardedSurface, PolicyEngine } from "../policy/engine.js";
import { PolicyViolation } from "../policy/engine.js";
import type { PlaywrightSurface } from "../surface/web/playwright-surface.js";
import type { SurfaceFingerprint } from "../surface/types.js";
import type { SessionHost } from "../session/host.js";
import type { Intervention, InterventionStore } from "../escalation/store.js";
import { type DeclaredParam, goalMessage, renderObservation, systemPrompt, toolDefinitions } from "./prompts.js";
import type { LlmClient, LlmMessage, LlmToolCall } from "./llm.js";

export interface RecordedAction {
  tool: "click" | "type_text" | "select_option" | "navigate";
  intent: string;
  expect?: string;
  /** Verified against the screen after acting; a checkpoint that did not hold is dropped. */
  expectHeld?: boolean;
  locator?: LocatorBundle;
  framePath: string[];
  value?: string;
  boundParam?: string;
  url?: string;
  pressEnter?: boolean;
  risk: Risk;
}

export interface DeclaredOutput {
  name: string;
  description: string;
  type: "string" | "number" | "boolean";
  sourceKind: "table_cell" | "regex" | "element";
  frame?: string;
  tableHeaders?: string[];
  rowMatchColumn?: string;
  rowMatchValue?: string;
  valueColumn?: string;
  pattern?: string;
  locator?: LocatorBundle;
}

export interface DiscoveryResult {
  status: "succeeded" | "gave_up" | "exhausted" | "blocked";
  summary?: string;
  successText?: string;
  reason?: string;
  actions: RecordedAction[];
  outputs: DeclaredOutput[];
  entryUrl: string;
  fingerprint: SurfaceFingerprint;
  turns: number;
}

export interface DiscoveryOptions {
  goal: string;
  targetUrl: string;
  baseUrl: string;
  params: DeclaredParam[];
  host: SessionHost;
  raw: PlaywrightSurface;
  policy: PolicyEngine;
  llm: LlmClient;
  store: InterventionStore;
  onEscalation?: (intervention: Intervention) => void;
  escalationTimeoutMs?: number;
  /** Approve risky actions without a human. Only for unattended recording runs. */
  autoApproveRisky?: boolean;
}

const ACTION_TOOLS = new Set(["click", "type_text", "select_option", "navigate"]);

export class DiscoveryAgent {
  private readonly actions: RecordedAction[] = [];
  private readonly outputs: DeclaredOutput[] = [];
  private surface!: GuardedSurface;

  constructor(private readonly opts: DiscoveryOptions) {}

  async run(): Promise<DiscoveryResult> {
    const { host, raw, policy, llm } = this.opts;
    const ev = host.evidence;
    const maxSteps = policy.config.budgets.maxDiscoverySteps;

    ev.event("run_started", `Discovery run for goal: ${this.opts.goal}`, {
      goal: this.opts.goal,
      target: this.opts.targetUrl,
      model: llm.model,
      params: this.opts.params.map((p) => p.name),
    });

    this.surface = host.automationSurface({
      budget: maxSteps + 5,
      onEvent: (event) => ev.event("guard", `${event.type}: ${event.describe}`, { ...event }),
      requestApproval: (req) => this.approve(req.describe, req.risk),
    });

    await host.signOn();
    await this.surface.act({ kind: "navigate", url: this.opts.targetUrl });
    await raw.settle();

    const fingerprint = await raw.fingerprint();
    ev.event("observation", `Application fingerprint captured.`, { ...fingerprint });

    const system = systemPrompt();
    const tools = toolDefinitions();
    const messages: LlmMessage[] = [
      { role: "user", content: [{ type: "text", text: goalMessage(this.opts.goal, this.opts.params) }] },
    ];

    for (let turn = 1; turn <= maxSteps; turn++) {
      const observation = await this.surface.observe();
      messages.push({
        role: "user",
        content: [{ type: "text", text: renderObservation(observation, turn, maxSteps) }],
      });

      const { turn: modelTurn, assistant } = await llm.complete(system, messages, tools);
      ev.event("model_turn", modelTurn.thinking ?? modelTurn.text ?? "(no narration)", {
        turn,
        toolCalls: modelTurn.toolCalls.map((c) => ({ name: c.name, input: c.input })),
        usage: modelTurn.usage,
      });
      messages.push({ role: "assistant", content: assistant });

      if (modelTurn.toolCalls.length === 0) {
        // No tool call means the model has nothing left to do but has not said so.
        return this.finishExhausted(turn, "The model stopped without calling finish or give_up.");
      }

      const results: Anthropic.ContentBlockParam[] = [];
      let actionTaken = false;
      let terminal: DiscoveryResult | undefined;

      for (const call of modelTurn.toolCalls) {
        if (call.name === "finish") {
          terminal = {
            status: "succeeded",
            summary: String(call.input["summary"] ?? this.opts.goal),
            successText: String(call.input["success_text"] ?? ""),
            actions: this.actions,
            outputs: this.outputs,
            entryUrl: this.opts.targetUrl,
            fingerprint,
            turns: turn,
          };
          results.push(this.ok(call, "Recorded. Run complete."));
          break;
        }
        if (call.name === "give_up") {
          const reason = String(call.input["reason"] ?? "unspecified");
          terminal = await this.giveUp(reason, turn, fingerprint);
          results.push(this.ok(call, "Escalated to a human operator."));
          break;
        }
        if (call.name === "declare_output") {
          results.push(this.ok(call, await this.declareOutput(call)));
          continue;
        }
        if (!ACTION_TOOLS.has(call.name)) {
          results.push(this.err(call, `Unknown tool "${call.name}".`));
          continue;
        }
        if (actionTaken) {
          results.push(
            this.err(
              call,
              "Not executed. Only one action runs per turn, because element references are only valid for the screen that produced them. Look at the new screen and decide again."
            )
          );
          continue;
        }
        actionTaken = true;
        results.push(this.ok(call, await this.executeAction(call, observation.url)));
      }

      // What the model was told back is as much a part of the record as what it did.
      for (const block of results) {
        if (block.type !== "tool_result") continue;
        ev.event("observation", `tool result -> ${String(block.content).slice(0, 400)}`, {
          turn,
          isError: Boolean(block.is_error),
        });
      }
      messages.push({ role: "user", content: results });
      if (terminal) {
        ev.event("run_finished", `Discovery ${terminal.status} after ${turn} turns.`, {
          status: terminal.status,
          actions: this.actions.length,
          outputs: this.outputs.length,
        });
        return terminal;
      }
    }

    return this.finishExhausted(maxSteps, `Reached the discovery budget of ${maxSteps} turns without finishing.`);
  }

  // ------------------------------------------------------------------- actions

  private async executeAction(call: LlmToolCall, urlBefore: string): Promise<string> {
    const { raw, policy, host } = this.opts;
    const intent = String(call.input["intent"] ?? call.name);
    const expect = call.input["expect"] ? String(call.input["expect"]) : undefined;

    try {
      if (call.name === "navigate") {
        const url = String(call.input["url"] ?? "");
        await this.surface.act({ kind: "navigate", url });
        await raw.settle();
        this.actions.push({
          tool: "navigate",
          intent,
          expect,
          expectHeld: await this.verifyExpect(expect),
          framePath: [],
          url: this.canonicalise(url),
          risk: "safe",
        });
        return this.describeScreenChange(urlBefore);
      }

      const ref = String(call.input["ref"] ?? "");
      const element = (await this.surface.observe()).elements.find((e) => e.ref === ref);
      if (!element) {
        return `No control with reference "${ref}" is on the current screen. Re-read the control list.`;
      }

      // Captured from the screen the model was looking at, before anything moves.
      const locator = await raw.describeElement(ref);
      const risk = policy.classifyRisk(element);

      let value: string | undefined;
      let boundParam: string | undefined;
      let pressEnter: boolean | undefined;

      if (call.name === "click") {
        await this.surface.act({ kind: "click", ref });
      } else if (call.name === "type_text") {
        value = String(call.input["text"] ?? "");
        pressEnter = Boolean(call.input["press_enter"]);
        boundParam = this.bindParam(value);
        await this.surface.act({ kind: "type", ref, text: value, clearFirst: true, pressEnter });
      } else {
        value = String(call.input["value"] ?? "");
        boundParam = this.bindParam(value);
        await this.surface.act({ kind: "select", ref, value });
      }

      await raw.settle();
      this.actions.push({
        tool: call.name as RecordedAction["tool"],
        intent,
        expect,
        expectHeld: await this.verifyExpect(expect),
        locator,
        framePath: element.framePath,
        value,
        boundParam,
        pressEnter,
        risk,
      });

      host.evidence.screenshot(`discovery-${this.actions.length}-${call.name}`, await raw.screenshot());
      host.evidence.event("action", `${intent} (${call.name})`, {
        ref,
        risk,
        boundParam,
        locator: locator.description,
      });

      return this.describeScreenChange(urlBefore);
    } catch (err) {
      if (err instanceof PolicyViolation) {
        host.evidence.event("guard", `Blocked during discovery: ${err.message}`, { ...err.detail });
        return `Refused by policy: ${err.message}`;
      }
      return `That action failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Confirm the model's checkpoint phrase is really visible before recording it. */
  private async verifyExpect(expect?: string): Promise<boolean | undefined> {
    if (!expect) return undefined;
    const text = await this.opts.raw.allText();
    return text.toLowerCase().includes(expect.toLowerCase());
  }

  private async describeScreenChange(urlBefore: string): Promise<string> {
    const observation = await this.opts.raw.observe();
    const moved = observation.url !== urlBefore;
    return `Done. ${moved ? `Now at ${observation.url}.` : "Still on the same screen."} The updated screen follows.`;
  }

  /** Bind typed text to a parameter when it matches one exactly. */
  private bindParam(value: string): string | undefined {
    return this.opts.params.find((p) => p.value === value)?.name;
  }

  /** Replace concrete parameter values in a URL with their placeholders. */
  private canonicalise(url: string): string {
    let out = url.startsWith(this.opts.baseUrl) ? `{baseUrl}${url.slice(this.opts.baseUrl.length)}` : url;
    for (const p of this.opts.params) {
      out = out.split(encodeURIComponent(p.value)).join(`{${p.name}}`).split(p.value).join(`{${p.name}}`);
    }
    return out;
  }

  private async declareOutput(call: LlmToolCall): Promise<string> {
    const input = call.input;
    const sourceKind = String(input["source_kind"] ?? "regex") as DeclaredOutput["sourceKind"];
    const output: DeclaredOutput = {
      name: String(input["name"] ?? "value"),
      description: String(input["description"] ?? ""),
      type: (String(input["type"] ?? "string") as DeclaredOutput["type"]) ?? "string",
      sourceKind,
      frame: input["frame"] ? String(input["frame"]) : undefined,
      tableHeaders: Array.isArray(input["table_headers"]) ? (input["table_headers"] as string[]) : undefined,
      rowMatchColumn: input["row_match_column"] ? String(input["row_match_column"]) : undefined,
      rowMatchValue: input["row_match_value"] ? String(input["row_match_value"]) : undefined,
      valueColumn: input["value_column"] ? String(input["value_column"]) : undefined,
      pattern: input["pattern"] ? String(input["pattern"]) : undefined,
    };

    if (sourceKind === "element" && input["ref"]) {
      try {
        output.locator = await this.opts.raw.describeElement(String(input["ref"]));
      } catch {
        return `Could not build a durable locator for reference "${String(input["ref"])}". Try table_cell or regex instead.`;
      }
    }

    this.outputs.push(output);
    this.opts.host.evidence.event("observation", `Output declared: ${output.name}`, { ...output });
    return `Output "${output.name}" recorded.`;
  }

  // ---------------------------------------------------------------- escalation

  /**
   * Discovery escalates through the same channel replay does.
   *
   * The model gives up rather than guessing, and a human picks up the *same* live
   * session, so nothing about the state it reached is lost.
   */
  private async giveUp(reason: string, turn: number, fingerprint: DiscoveryResult["fingerprint"]): Promise<DiscoveryResult> {
    const { host, store, raw } = this.opts;
    const shot = host.evidence.screenshot("discovery-stuck", await raw.screenshot());
    host.evidence.textSnapshot("discovery-stuck", await raw.allText());
    host.control.transfer("none", `discovery stuck: ${reason}`);

    const observation = await raw.observe();
    const intervention = store.raise({
      runId: host.runId,
      kind: "stuck",
      reason,
      goal: this.opts.goal,
      context: {
        url: observation.url,
        title: observation.title,
        stepIntent: `Discovery turn ${turn}`,
        observed: (await raw.allText()).slice(0, 300),
        screenshotPath: shot,
      },
    });
    host.evidence.event("intervention_raised", `Discovery raised ${intervention.id}: ${reason}`, {
      interventionId: intervention.id,
    });
    this.opts.onEscalation?.(intervention);
    await store.awaitResolution(intervention.id, this.opts.escalationTimeoutMs ?? 10 * 60_000);

    return {
      status: "gave_up",
      reason,
      actions: this.actions,
      outputs: this.outputs,
      entryUrl: this.opts.targetUrl,
      fingerprint,
      turns: turn,
    };
  }

  private async approve(describe: string, risk: Risk): Promise<{ approved: boolean; by?: string }> {
    const { host, store } = this.opts;
    if (this.opts.autoApproveRisky) {
      host.evidence.event("guard", `Auto-approved ${risk} action during recording: ${describe}`, { describe, risk });
      return { approved: true, by: "unattended-recording" };
    }
    host.control.transfer("none", `awaiting approval for ${risk} action`);
    const intervention = store.raise({
      runId: host.runId,
      kind: "approval_required",
      reason: `Recording wants to perform a ${risk} action: ${describe}. A human must approve it.`,
      goal: this.opts.goal,
      context: { stepIntent: describe },
    });
    this.opts.onEscalation?.(intervention);
    const resolved = await store.awaitResolution(intervention.id, this.opts.escalationTimeoutMs ?? 10 * 60_000);
    const approved = resolved?.resolution?.decision === "approve" || resolved?.resolution?.decision === "resume";
    if (approved) host.control.transfer("automation", "approval granted");
    return { approved, by: resolved?.resolution?.by };
  }

  private finishExhausted(turns: number, reason: string): DiscoveryResult {
    this.opts.host.evidence.event("run_finished", reason, { turns });
    return {
      status: "exhausted",
      reason,
      actions: this.actions,
      outputs: this.outputs,
      entryUrl: this.opts.targetUrl,
      fingerprint: {},
      turns,
    };
  }

  private ok(call: LlmToolCall, text: string): Anthropic.ContentBlockParam {
    return { type: "tool_result", tool_use_id: call.id, content: text };
  }
  private err(call: LlmToolCall, text: string): Anthropic.ContentBlockParam {
    return { type: "tool_result", tool_use_id: call.id, content: text, is_error: true };
  }
}
