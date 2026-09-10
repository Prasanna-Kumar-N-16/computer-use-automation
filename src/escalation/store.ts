/**
 * Intervention requests.
 *
 * An escalation is not a log line - it is a piece of state with a lifecycle, because
 * the run genuinely blocks on it. The request carries enough context for an operator
 * who was not watching to understand what the automation was trying to do, where it
 * stopped, and what it saw.
 *
 * The store is in-process on purpose. The operator console has to reach the *live*
 * browser session, which means it runs alongside the run rather than as a detached
 * service. Making this durable and multi-process is a deployment concern; the seam it
 * would need (this interface) is already the only thing the engine depends on.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export type InterventionKind = "stuck" | "approval_required" | "recovery_exhausted" | "precondition_failed";
export type InterventionState = "pending" | "in_progress" | "resolved";
export type InterventionDecision = "resume" | "abort" | "approve" | "deny" | "fail";

export interface InterventionContext {
  url?: string;
  title?: string;
  stepId?: string;
  stepIntent?: string;
  expected?: string;
  observed?: string;
  screenshotPath?: string;
}

export interface Intervention {
  id: string;
  runId: string;
  kind: InterventionKind;
  reason: string;
  capabilityId?: string;
  capabilityVersion?: number;
  goal?: string;
  context: InterventionContext;
  raisedAt: string;
  state: InterventionState;
  /** Every input event relayed from the operator into the live session. */
  humanActions: { at: string; describe: string }[];
  resolution?: {
    decision: InterventionDecision;
    by: string;
    at: string;
    note?: string;
  };
}

export class InterventionStore extends EventEmitter {
  private readonly items = new Map<string, Intervention>();

  raise(input: Omit<Intervention, "id" | "raisedAt" | "state" | "humanActions">): Intervention {
    const intervention: Intervention = {
      ...input,
      id: `iv-${randomUUID().slice(0, 8)}`,
      raisedAt: new Date().toISOString(),
      state: "pending",
      humanActions: [],
    };
    this.items.set(intervention.id, intervention);
    this.emit("raised", intervention);
    return intervention;
  }

  get(id: string): Intervention | undefined {
    return this.items.get(id);
  }

  list(): Intervention[] {
    return [...this.items.values()].sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
  }

  claim(id: string, operator: string): Intervention | undefined {
    const item = this.items.get(id);
    if (!item || item.state === "resolved") return undefined;
    item.state = "in_progress";
    this.emit("claimed", item, operator);
    return item;
  }

  recordHumanAction(id: string, describe: string): void {
    const item = this.items.get(id);
    if (!item) return;
    item.humanActions.push({ at: new Date().toISOString(), describe });
    this.emit("human_action", item, describe);
  }

  resolve(id: string, decision: InterventionDecision, by: string, note?: string): Intervention | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    item.state = "resolved";
    item.resolution = { decision, by, at: new Date().toISOString(), note };
    this.emit("resolved", item);
    return item;
  }

  /** Block until this intervention is resolved, or the deadline passes. */
  async awaitResolution(id: string, timeoutMs: number): Promise<Intervention | undefined> {
    const existing = this.items.get(id);
    if (existing?.state === "resolved") return existing;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off("resolved", onResolved);
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
      const onResolved = (item: Intervention) => {
        if (item.id !== id) return;
        clearTimeout(timer);
        this.off("resolved", onResolved);
        resolve(item);
      };
      this.on("resolved", onResolved);
    });
  }
}
