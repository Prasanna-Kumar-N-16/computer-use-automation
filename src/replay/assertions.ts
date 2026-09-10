/**
 * Assertion evaluation.
 *
 * Assertions are the only way replay learns anything about the screen: checkpoints
 * are assertions, outcome detection is assertions, and waits are assertions polled
 * until they hold. Keeping them declarative means an artifact can be reviewed for
 * what it will assert without running it.
 */

import type { Assertion } from "../schema/common.js";
import type { Observation, Surface } from "../surface/types.js";

/** The narrow slice of the surface assertions need. Keeps them testable without a browser. */
export interface AssertionSurface {
  resolve: Surface["resolve"];
  frameText(framePath: string[]): Promise<string>;
  allText(): Promise<string>;
}

export interface AssertionContext {
  surface: AssertionSurface;
  observation: Observation;
}

export async function evaluate(assertion: Assertion, ctx: AssertionContext): Promise<boolean> {
  switch (assertion.kind) {
    case "text_present":
    case "text_absent": {
      const haystack = assertion.framePath
        ? await ctx.surface.frameText(assertion.framePath)
        : await ctx.surface.allText();
      const present = assertion.caseSensitive
        ? haystack.includes(assertion.text)
        : haystack.toLowerCase().includes(assertion.text.toLowerCase());
      return assertion.kind === "text_present" ? present : !present;
    }
    case "element_present":
    case "element_absent": {
      const res = await ctx.surface.resolve(assertion.locator);
      const present = res.status === "resolved";
      return assertion.kind === "element_present" ? present : !present;
    }
    case "url_matches":
      return new RegExp(assertion.pattern).test(ctx.observation.url);
    case "title_matches":
      return new RegExp(assertion.pattern).test(ctx.observation.title);
    case "http_status": {
      const status = ctx.observation.httpStatus;
      if (status === undefined) return false;
      if (assertion.equals !== undefined) return status === assertion.equals;
      if (assertion.atLeast !== undefined) return status >= assertion.atLeast;
      return false;
    }
    case "all_of": {
      for (const a of assertion.of) if (!(await evaluate(a, ctx))) return false;
      return true;
    }
    case "any_of": {
      for (const a of assertion.of) if (await evaluate(a, ctx)) return true;
      return false;
    }
    case "not":
      return !(await evaluate(assertion.of, ctx));
  }
}

/** Human-readable form, used in failure reports so "expected" is legible. */
export function describe(assertion: Assertion): string {
  switch (assertion.kind) {
    case "text_present":
      return `text "${assertion.text}" is present`;
    case "text_absent":
      return `text "${assertion.text}" is absent`;
    case "element_present":
      return `element ${assertion.locator.description} is present`;
    case "element_absent":
      return `element ${assertion.locator.description} is absent`;
    case "url_matches":
      return `URL matches /${assertion.pattern}/`;
    case "title_matches":
      return `title matches /${assertion.pattern}/`;
    case "http_status":
      return assertion.equals !== undefined
        ? `HTTP status is ${assertion.equals}`
        : `HTTP status is at least ${assertion.atLeast}`;
    case "all_of":
      return assertion.of.map(describe).join(" and ");
    case "any_of":
      return assertion.of.map(describe).join(" or ");
    case "not":
      return `not (${describe(assertion.of)})`;
  }
}

/** Poll an assertion until it holds or the deadline passes. */
export async function waitUntil(
  assertion: Assertion,
  ctx: () => Promise<AssertionContext>,
  timeoutMs: number,
  pollMs = 350
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(assertion, await ctx())) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
