/**
 * What the model sees, and the tools it is allowed to use.
 *
 * The model never sees markup and cannot express a selector. It sees a rendered view
 * of the screen - roles, names, labels, grid contents - and acts through opaque
 * element references. That constraint is the whole reason the resulting artifact can
 * later target a surface that has no DOM at all.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Observation } from "../surface/types.js";

export interface DeclaredParam {
  name: string;
  value: string;
  type: "string" | "number" | "boolean";
  description: string;
}

export function systemPrompt(): string {
  return `You are operating a back-office banking application on behalf of a human operator, \
the way that operator would: by looking at the screen and clicking and typing.

You are driving a real, live application. Every action you take really happens.

## How you see the screen

Each turn you receive the current screen as a list of controls. Every control has an \
opaque reference like \`mainFrame#3\`. You act on controls by reference. You cannot \
write CSS selectors, XPath, or JavaScript, and you should not try - the reference is \
the only way to name a control.

Screens in this application are split into frames. A reference always tells you which \
frame its control lives in. Data grids are rendered separately, with their column \
headers, so you can read values out of them.

## What you are producing

You are not just completing the task once. This run is being recorded into a reusable \
capability that will later be replayed thousands of times with no model involved. So:

- Take the most direct path to the goal. Do not explore, browse, or "look around \
first" - every action you take becomes a permanent step in the recording.
- Give every action a short \`intent\`, written the way an operator would describe it.
- Give every action an \`expect\`: a short, distinctive phrase that will be visible on \
screen if the action worked. This becomes the checkpoint that proves the step \
succeeded on every future replay. Choose something that is stable across different \
inputs, not a value specific to today's data.
- When a parameter is available, type its exact value. That is how the recording \
learns which text is a parameter rather than a constant.

## Declaring outputs

If the goal asks you to read something back, call \`declare_output\` for each value \
before finishing. Prefer \`table_cell\` when the value lives in a grid: addressing it \
by column header and matching row survives rows being added or reordered, which a \
position never does.

## Finishing

Call \`finish\` when the goal is met, with a \`success_text\` phrase that is visible on \
the final screen and distinctive to having succeeded.

Call \`give_up\` if you are stuck, blocked, or would have to guess. A human operator \
will be brought in. Guessing is worse than stopping.

Never attempt to sign in or handle credentials. Your session is already authenticated.`;
}

export function goalMessage(goal: string, params: DeclaredParam[]): string {
  const paramBlock = params.length
    ? `\n\nParameters available for this run. Type these exact values where the flow calls for them:\n` +
      params.map((p) => `  ${p.name} (${p.type}) = ${p.value}   // ${p.description}`).join("\n")
    : "";
  return `Goal: ${goal}${paramBlock}`;
}

/** Render an observation as the model's view of the screen. */
export function renderObservation(observation: Observation, stepNumber: number, maxSteps: number): string {
  const lines: string[] = [];
  lines.push(`SCREEN (action ${stepNumber} of at most ${maxSteps})`);
  lines.push(`  url:    ${observation.url}`);
  lines.push(`  title:  ${observation.title}`);
  if (observation.httpStatus !== undefined) lines.push(`  status: ${observation.httpStatus}`);

  const byFrame = new Map<string, typeof observation.elements>();
  for (const e of observation.elements) {
    const key = e.framePath.join("/") || "(top)";
    if (!byFrame.has(key)) byFrame.set(key, []);
    byFrame.get(key)!.push(e);
  }

  for (const [frame, elements] of byFrame) {
    lines.push(``, `FRAME ${frame}`);
    lines.push(`  CONTROLS`);
    for (const e of elements) {
      const bits = [`    ${e.ref}`, e.role.padEnd(9), `"${e.name}"`];
      if (e.labelText && e.labelText !== e.name) bits.push(`label="${e.labelText}"`);
      if (e.value) bits.push(`value="${e.value}"`);
      if (e.meta?.["options"]) bits.push(`options=[${e.meta["options"]}]`);
      if (!e.enabled) bits.push(`(disabled)`);
      lines.push(bits.join(" "));
    }
  }

  const grids = observation.grids ?? [];
  if (grids.length) {
    lines.push(``, `GRIDS`);
    for (const g of grids) {
      lines.push(`  in frame ${g.framePath.join("/") || "(top)"}`);
      lines.push(`    | ${g.headers.join(" | ")} |`);
      for (const row of g.rows) lines.push(`    | ${row.join(" | ")} |`);
    }
  }

  lines.push(``, `VISIBLE TEXT`);
  for (const [frame, text] of Object.entries(observation.frameText)) {
    if (!text.trim()) continue;
    lines.push(`  [${frame || "(top)"}] ${text.slice(0, 1200)}`);
  }

  return lines.join("\n");
}

/**
 * The action surface.
 *
 * Deliberately small. Each tool maps one-to-one onto something the replay engine can
 * execute deterministically, so there is no gap between what the model can do during
 * discovery and what the artifact can express.
 */
export function toolDefinitions(): Anthropic.Tool[] {
  const intent: Record<string, unknown> = {
    intent: {
      type: "string",
      description: "What you are doing, in an operator's words. Becomes the step description in the recording.",
    },
    expect: {
      type: "string",
      description:
        "A short distinctive phrase that should be visible after this action succeeds. Becomes the replay checkpoint. Prefer stable page furniture over data values.",
    },
  };

  return [
    {
      name: "click",
      description: "Click a control by its reference.",
      input_schema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Reference of the control to click, e.g. mainFrame#4." },
          ...intent,
        },
        required: ["ref", "intent"],
      },
    },
    {
      name: "type_text",
      description: "Type into a text field. Clears the field first.",
      input_schema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Reference of the text field." },
          text: { type: "string", description: "Text to type. Use a parameter's exact value when one applies." },
          press_enter: { type: "boolean", description: "Press Enter afterwards to submit the form. Default false." },
          ...intent,
        },
        required: ["ref", "text", "intent"],
      },
    },
    {
      name: "select_option",
      description: "Choose an option in a dropdown, by the option's value.",
      input_schema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Reference of the dropdown." },
          value: { type: "string", description: "The option value to select, not its label." },
          ...intent,
        },
        required: ["ref", "value", "intent"],
      },
    },
    {
      name: "navigate",
      description: "Go directly to a URL within the application. Only use when no on-screen control will do.",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute URL inside the application." },
          ...intent,
        },
        required: ["url", "intent"],
      },
    },
    {
      name: "declare_output",
      description:
        "Declare a value this capability returns to its caller. Call once per output, before finish.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Output field name, e.g. savingsBalance." },
          description: { type: "string", description: "What this value is, for the calling agent." },
          type: { type: "string", enum: ["string", "number", "boolean"], description: "Declared type." },
          source_kind: {
            type: "string",
            enum: ["table_cell", "regex", "element"],
            description:
              "table_cell for a value in a grid (preferred). regex to capture from visible text. element to read one control.",
          },
          frame: { type: "string", description: "Frame the value lives in, e.g. mainFrame." },
          table_headers: {
            type: "array",
            items: { type: "string" },
            description: "table_cell: every column header of the grid, exactly as shown.",
          },
          row_match_column: { type: "string", description: "table_cell: header of the column that identifies the row." },
          row_match_value: { type: "string", description: "table_cell: value that identifies the row." },
          value_column: { type: "string", description: "table_cell: header of the column holding the value." },
          pattern: {
            type: "string",
            description: "regex: JavaScript regular expression against the frame's visible text, with one capture group.",
          },
          ref: { type: "string", description: "element: reference of the control holding the value." },
        },
        required: ["name", "description", "type", "source_kind"],
      },
    },
    {
      name: "finish",
      description: "The goal has been achieved. Ends the run and records the capability.",
      input_schema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "One sentence describing what this capability does." },
          success_text: {
            type: "string",
            description:
              "A distinctive phrase visible on the final screen that means the goal was reached. Becomes the success condition every replay asserts.",
          },
        },
        required: ["summary", "success_text"],
      },
    },
    {
      name: "give_up",
      description: "Stop and hand over to a human operator. Use when stuck, blocked, or unsure.",
      input_schema: {
        type: "object",
        properties: {
          reason: { type: "string", description: "What you were trying to do and what stopped you." },
        },
        required: ["reason"],
      },
    },
  ];
}
