/**
 * Transcript to artifact.
 *
 * The recording is deliberately *not* the model transcript. A transcript is a record
 * of a conversation; an artifact is a contract. This is where one becomes the other:
 * concrete values become typed parameters, the model's checkpoint phrases become
 * assertions that were verified to hold, and application-level conditions are merged
 * in from the outcome library.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACT_SCHEMA_VERSION,
  CapabilitySchema,
  type Capability,
  type InputParam,
  type Outcome,
  type OutputField,
  type Risk,
  type Step,
} from "../schema/capability.js";
import type { Assertion, ExtractionSpec, Transform } from "../schema/common.js";
import type { DeclaredOutput, DiscoveryResult, RecordedAction } from "./agent.js";
import type { DeclaredParam } from "./prompts.js";
import { mergeOutcomes, type OutcomeLibrary } from "./outcome-library.js";

export interface CompileOptions {
  id: string;
  goal: string;
  baseUrl: string;
  params: DeclaredParam[];
  library?: OutcomeLibrary;
  model?: string;
  runId?: string;
  tenant?: string;
  version?: number;
}

/**
 * Values whose names imply regulated data.
 *
 * Classifying by name is a heuristic, and a heuristic that fails open would be the
 * wrong shape here - so it is deliberately broad, and an author can always tighten a
 * field afterwards. Being over-redacted in a log is recoverable; being under-redacted
 * is not.
 */
const PII_NAME = /(member|account|customer|ssn|tax|tin|card|routing|dob|birth|address|phone|email|name|balance|amount)/i;

export function inferSensitivity(name: string): "none" | "pii" {
  return PII_NAME.test(name) ? "pii" : "none";
}

export function compileCapability(result: DiscoveryResult, options: CompileOptions): Capability {
  if (result.status !== "succeeded") {
    throw new Error(`Refusing to compile an artifact from a run that ${result.status}.`);
  }

  const steps = result.actions.map((action, index) => toStep(action, index));
  const maxRisk = steps.reduce<Risk>((worst, s) => rank(s.risk) > rank(worst) ? s.risk : worst, "safe");

  const successOutcome: Outcome = {
    id: "success",
    kind: "success",
    code: "SUCCESS",
    description: result.summary ?? options.goal,
    // Scoped so it is only asserted at the end. A success condition evaluated after
    // every step could fire early on a screen that merely looks finished.
    scope: "step",
    afterSteps: [],
    detect: { kind: "text_present", text: result.successText ?? "" },
    maxAttempts: 1,
  };

  const capability: Capability = CapabilitySchema.parse({
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    id: options.id,
    version: options.version ?? 1,
    name: humanise(options.id),
    description: result.summary ?? options.goal,
    surface: {
      kind: "web",
      entryUrlTemplate: canonicaliseUrl(result.entryUrl, options.baseUrl, options.params),
      requires: ["authenticated_session"],
      viewport: { width: 1280, height: 900 },
    },
    inputs: options.params.map(toInput),
    outputs: result.outputs.map(toOutput),
    preconditions: [],
    steps,
    outcomes: mergeOutcomes([successOutcome], options.library?.outcomes ?? []),
    approval: "draft",
    maxRisk,
    provenance: {
      recordedAt: new Date().toISOString(),
      model: options.model,
      discoveryRunId: options.runId,
      goal: options.goal,
      tenant: options.tenant ?? "default",
      appFingerprint: result.fingerprint,
    },
  });

  return capability;
}

function rank(risk: Risk): number {
  return risk === "irreversible" ? 2 : risk === "sensitive" ? 1 : 0;
}

function toInput(param: DeclaredParam): InputParam {
  return {
    name: param.name,
    type: param.type,
    required: true,
    description: param.description,
    sensitivity: inferSensitivity(param.name),
    // The recorded value is an example, not data: it is not carried into the artifact
    // for any parameter classified as regulated.
    example: inferSensitivity(param.name) === "pii" ? undefined : param.value,
  };
}

function toOutput(declared: DeclaredOutput): OutputField {
  return {
    name: declared.name,
    type: declared.type,
    description: declared.description,
    required: true,
    sensitivity: inferSensitivity(declared.name),
    extract: toExtraction(declared),
  };
}

function toExtraction(declared: DeclaredOutput): ExtractionSpec {
  const framePath = declared.frame ? [declared.frame] : [];
  const transform: Transform = declared.type === "number" ? "money" : "trim";

  if (declared.sourceKind === "table_cell" && declared.tableHeaders?.length) {
    return {
      kind: "table_cell",
      framePath,
      tableHeaders: declared.tableHeaders,
      rowMatchColumn: declared.rowMatchColumn ?? declared.tableHeaders[0]!,
      rowMatchValue: declared.rowMatchValue ?? "",
      rowMatchMode: "equals",
      valueColumn: declared.valueColumn ?? declared.tableHeaders.at(-1)!,
      transform,
    };
  }
  if (declared.sourceKind === "element" && declared.locator) {
    return { kind: "element_text", locator: declared.locator, transform };
  }
  return {
    kind: "regex_capture",
    framePath,
    pattern: declared.pattern ?? "(.*)",
    group: 1,
    transform,
  };
}

function toStep(action: RecordedAction, index: number): Step {
  const id = `s${index + 1}`;
  const timeoutMs = 15_000;

  if (action.tool === "navigate") {
    return {
      id,
      intent: action.intent,
      action: { kind: "navigate", urlTemplate: action.url ?? "" },
      risk: action.risk,
      waitFor: [],
      checkpoint: checkpointFor(action),
      timeoutMs,
    };
  }

  const target = action.locator!;
  // Waiting for the control to appear, rather than resolving once and failing, is what
  // makes a slow screen a wait instead of a locator error.
  const waitFor: Assertion[] = [{ kind: "element_present", locator: target }];

  if (action.tool === "click") {
    return {
      id,
      intent: action.intent,
      action: { kind: "click", target },
      risk: action.risk,
      waitFor,
      checkpoint: checkpointFor(action),
      timeoutMs,
    };
  }
  if (action.tool === "select_option") {
    return {
      id,
      intent: action.intent,
      action: {
        kind: "select",
        target,
        value: action.boundParam
          ? { kind: "param", name: action.boundParam }
          : { kind: "literal", value: action.value ?? "" },
      },
      risk: action.risk,
      waitFor,
      checkpoint: checkpointFor(action),
      timeoutMs,
    };
  }
  return {
    id,
    intent: action.intent,
    action: {
      kind: "type",
      target,
      value: action.boundParam
        ? { kind: "param", name: action.boundParam }
        : { kind: "literal", value: action.value ?? "" },
      clearFirst: true,
      pressEnter: action.pressEnter ?? false,
    },
    risk: action.risk,
    waitFor,
    checkpoint: checkpointFor(action),
    timeoutMs,
  };
}

/**
 * Only keep a checkpoint the recording actually observed.
 *
 * A checkpoint the model imagined would fail on every replay and be indistinguishable
 * from a real regression, which is worse than having no checkpoint at all.
 */
function checkpointFor(action: RecordedAction): Assertion | undefined {
  if (!action.expect || action.expectHeld !== true) return undefined;
  return { kind: "text_present", text: action.expect };
}

function canonicaliseUrl(url: string, baseUrl: string, params: DeclaredParam[]): string {
  let out = url.startsWith(baseUrl) ? `{baseUrl}${url.slice(baseUrl.length)}` : url;
  for (const p of params) {
    out = out.split(encodeURIComponent(p.value)).join(`{${p.name}}`).split(p.value).join(`{${p.name}}`);
  }
  return out;
}

function humanise(id: string): string {
  return id
    .split(".")
    .map((part) => part.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
    .join(" / ");
}

/** Next version number for an id, so re-recording never silently overwrites. */
export function nextVersion(capabilitiesDir: string, id: string): number {
  if (!existsSync(capabilitiesDir)) return 1;
  const prefix = `${id}@v`;
  const versions = readdirSync(capabilitiesDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => Number(f.slice(prefix.length, -".json".length)))
    .filter((n) => Number.isFinite(n));
  return versions.length ? Math.max(...versions) + 1 : 1;
}

export function capabilityPath(capabilitiesDir: string, cap: Capability): string {
  return join(capabilitiesDir, `${cap.id}@v${cap.version}.json`);
}
