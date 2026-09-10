/**
 * Redaction.
 *
 * The rule this module encodes: regulated data may flow *through* the system to an
 * authorised caller, but it must not come to *rest* in an artifact, a log line, or a
 * screenshot sidecar. Those outlive the request, get copied into tickets, and end up
 * in places nobody audited.
 *
 * So `redact()` is applied at every write to disk, and never to the value returned to
 * the caller who invoked the capability.
 */

import { z } from "zod";

export const RedactionRuleSchema = z.object({
  name: z.string(),
  pattern: z.string(),
  mode: z.enum(["mask_all", "keep_last4"]).default("mask_all"),
});
export type RedactionRule = z.infer<typeof RedactionRuleSchema>;

export const RedactionConfigSchema = z.object({
  rules: z.array(RedactionRuleSchema).default([]),
  maskSensitivity: z.array(z.enum(["none", "pii", "secret"])).default(["pii", "secret"]),
});
export type RedactionConfig = z.infer<typeof RedactionConfigSchema>;

const MASK = "•";

export class Redactor {
  private readonly compiled: { rule: RedactionRule; re: RegExp }[];
  /** Literal values registered at runtime (credentials, PII parameter values). */
  private readonly literals = new Map<string, string>();

  constructor(private readonly config: RedactionConfig) {
    this.compiled = config.rules.map((rule) => ({ rule, re: new RegExp(rule.pattern, "g") }));
  }

  /**
   * Register a value that must never appear in persisted output.
   *
   * Pattern-based redaction only catches shapes it was told about. Registering the
   * actual credential or PII value the run is using closes the gap where a password
   * shows up somewhere nobody predicted - an error message, a URL, a page title.
   */
  registerSecret(value: string, label = "secret"): void {
    if (!value || value.length < 3) return;
    this.literals.set(value, `[redacted:${label}]`);
  }

  registerSensitive(value: string, sensitivity: "none" | "pii" | "secret", label: string): void {
    if (sensitivity === "none") return;
    if (!this.config.maskSensitivity.includes(sensitivity)) return;
    if (!value) return;
    this.literals.set(value, sensitivity === "secret" ? `[redacted:${label}]` : maskMiddle(value));
  }

  redact(input: string): string {
    let out = input;
    for (const [literal, replacement] of this.literals) {
      out = out.split(literal).join(replacement);
    }
    for (const { rule, re } of this.compiled) {
      out = out.replace(re, (match) => (rule.mode === "keep_last4" ? keepLast4(match) : maskAll(match)));
    }
    return out;
  }

  /** Deep-redact any JSON-serialisable structure on its way to disk. */
  redactDeep<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as unknown as T;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.redactDeep(v);
      return out as unknown as T;
    }
    return value;
  }
}

export function maskAll(s: string): string {
  return MASK.repeat(Math.min(s.length, 12));
}

/** Keep the last four characters, which is what an operator needs to confirm identity. */
export function keepLast4(s: string): string {
  const digits = s.replace(/\D/g, "");
  if (digits.length <= 4) return maskAll(s);
  return MASK.repeat(Math.min(digits.length - 4, 10)) + digits.slice(-4);
}

/** Keep the first and last character, mask the middle. Readable, but not the value. */
export function maskMiddle(s: string): string {
  if (s.length <= 2) return maskAll(s);
  if (s.length <= 4) return s[0] + MASK.repeat(s.length - 1);
  return s[0] + MASK.repeat(s.length - 2) + s[s.length - 1];
}
