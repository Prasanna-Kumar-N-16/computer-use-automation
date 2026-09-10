/**
 * Input validation, template binding, and output typing.
 *
 * A capability is only invocable by another agent if its argument contract is
 * enforced rather than assumed. Bad arguments have to fail as `input_invalid` before
 * a browser is ever opened - not halfway through a form, having already written
 * something to the core.
 */

import type { Capability, InputParam, OutputField } from "../schema/capability.js";
import type { Transform, ValueSource } from "../schema/common.js";

export class InputError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "InputError";
  }
}

export type Inputs = Record<string, string | number | boolean>;

export function validateInputs(capability: Capability, raw: Record<string, unknown>): Inputs {
  const out: Inputs = {};
  const declared = new Set(capability.inputs.map((i) => i.name));

  for (const key of Object.keys(raw)) {
    if (!declared.has(key)) throw new InputError(`Unknown input "${key}".`, key);
  }

  for (const param of capability.inputs) {
    const value = raw[param.name];
    if (value === undefined || value === null || value === "") {
      if (param.required) throw new InputError(`Input "${param.name}" is required.`, param.name);
      continue;
    }
    out[param.name] = coerce(param, value);
  }
  return out;
}

function coerce(param: InputParam, value: unknown): string | number | boolean {
  const asString = String(value);
  switch (param.type) {
    case "number": {
      const n = Number(asString);
      if (Number.isNaN(n)) throw new InputError(`Input "${param.name}" must be a number.`, param.name);
      return n;
    }
    case "boolean":
      if (["true", "1", "yes"].includes(asString.toLowerCase())) return true;
      if (["false", "0", "no"].includes(asString.toLowerCase())) return false;
      throw new InputError(`Input "${param.name}" must be a boolean.`, param.name);
    case "enum":
      if (param.enumValues && !param.enumValues.includes(asString)) {
        throw new InputError(
          `Input "${param.name}" must be one of ${param.enumValues.join(", ")}.`,
          param.name
        );
      }
      return asString;
    default:
      if (param.pattern && !new RegExp(param.pattern).test(asString)) {
        throw new InputError(`Input "${param.name}" does not match ${param.pattern}.`, param.name);
      }
      return asString;
  }
}

/** Fill {placeholders} from inputs plus the runtime-supplied baseUrl. */
export function renderTemplate(template: string, inputs: Inputs, extra: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (name in extra) return extra[name]!;
    if (name in inputs) return String(inputs[name]);
    throw new InputError(`Template references unknown parameter "{${name}}".`, name);
  });
}

export interface SecretResolver {
  (name: string): string | undefined;
}

/** Resolve what a step should type. Secrets come from the runtime, never the artifact. */
export function resolveValue(source: ValueSource, inputs: Inputs, secrets: SecretResolver): string {
  if (source.kind === "literal") return source.value;
  if (source.kind === "param") {
    if (!(source.name in inputs)) throw new InputError(`Step references unbound parameter "${source.name}".`, source.name);
    return String(inputs[source.name]);
  }
  const secret = secrets(source.name);
  if (secret === undefined) throw new InputError(`No runtime value configured for secret "${source.name}".`, source.name);
  return secret;
}

export function applyTransform(raw: string, transform: Transform): string {
  switch (transform) {
    case "none":
      return raw;
    case "trim":
      return raw.trim();
    case "digits":
      return raw.replace(/\D/g, "");
    case "money":
    case "number": {
      const cleaned = raw.replace(/[^0-9.\-]/g, "");
      return cleaned === "" ? raw.trim() : cleaned;
    }
  }
}

/** Cast an extracted string to the type the capability declared it returns. */
export function typeOutput(field: OutputField, raw: string): unknown {
  const value = applyTransform(raw, extractTransform(field));
  switch (field.type) {
    case "number": {
      const n = Number(value);
      return Number.isNaN(n) ? null : n;
    }
    case "boolean":
      return ["true", "yes", "1"].includes(value.toLowerCase());
    default:
      return value;
  }
}

function extractTransform(field: OutputField): Transform {
  return "transform" in field.extract ? (field.extract.transform as Transform) : "trim";
}
