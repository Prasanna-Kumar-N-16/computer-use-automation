/**
 * Evidence.
 *
 * Every run - discovery or replay - writes one directory containing a structured
 * event log, screenshots at each step, and a richer capture on failure. The log is
 * JSONL so it can be grepped and diffed; the screenshots are what a human actually
 * looks at when asked "what went wrong".
 *
 * Everything written here passes through the redactor first.
 */

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Redactor } from "../policy/redact.js";

export type EvidenceEventType =
  | "run_started"
  | "run_finished"
  | "precondition"
  | "model_turn"
  | "action"
  | "observation"
  | "checkpoint"
  | "outcome_matched"
  | "recovery"
  | "guard"
  | "control_transfer"
  | "intervention_raised"
  | "intervention_resolved"
  | "human_action"
  | "drift"
  | "error";

export interface EvidenceEvent {
  seq: number;
  at: string;
  type: EvidenceEventType;
  message: string;
  data?: Record<string, unknown>;
}

export class EvidenceRecorder {
  readonly dir: string;
  private seq = 0;
  private readonly logPath: string;

  constructor(root: string, readonly runId: string, private readonly redactor: Redactor) {
    this.dir = join(root, runId);
    mkdirSync(join(this.dir, "screens"), { recursive: true });
    this.logPath = join(this.dir, "run.jsonl");
  }

  event(type: EvidenceEventType, message: string, data?: Record<string, unknown>): EvidenceEvent {
    const entry: EvidenceEvent = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      type,
      message: this.redactor.redact(message),
      ...(data ? { data: this.redactor.redactDeep(data) } : {}),
    };
    appendFileSync(this.logPath, JSON.stringify(entry) + "\n");
    return entry;
  }

  /** Screenshots are binary and cannot be text-redacted; the filename encodes context only. */
  screenshot(label: string, buffer: Buffer): string {
    const name = `${String(this.seq).padStart(3, "0")}-${slug(label)}.png`;
    writeFileSync(join(this.dir, "screens", name), buffer);
    return join("screens", name);
  }

  /** The richer capture taken on failure: full visible text of every frame. */
  textSnapshot(label: string, text: string): string {
    const name = `${String(this.seq).padStart(3, "0")}-${slug(label)}.txt`;
    writeFileSync(join(this.dir, name), this.redactor.redact(text));
    return name;
  }

  /** The one exception to redaction: values returned to the authorised caller. */
  writeCallerResult(name: string, value: unknown): string {
    writeFileSync(join(this.dir, name), JSON.stringify(value, null, 2) + "\n");
    return name;
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "step";
}
