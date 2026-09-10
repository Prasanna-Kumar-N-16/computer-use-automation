import { describe, expect, it } from "vitest";
import { selectGoverningOutcome } from "../src/replay/outcomes.js";
import type { Outcome } from "../src/schema/capability.js";

function outcome(id: string, kind: Outcome["kind"], maxAttempts = 2): Outcome {
  return {
    id,
    kind,
    code: id.toUpperCase(),
    description: id,
    detect: { kind: "text_present", text: id },
    scope: "global",
    afterSteps: [],
    maxAttempts,
    ...(kind === "recoverable" ? { recovery: { action: "wait_and_retry" as const, waitMs: 10 } } : {}),
  };
}

describe("outcome precedence", () => {
  it("clears a blocker before believing what is underneath it", () => {
    // The nightly-batch overlay sits on top of the relationship summary. Reading the
    // balance through the dialog would be wrong; dismissing first is the point.
    const matched = [outcome("success", "success"), outcome("overlay", "recoverable")];
    expect(selectGoverningOutcome(matched, { attempts: {} })?.id).toBe("overlay");
  });

  it("prefers a hard failure over a business outcome", () => {
    const matched = [outcome("not_found", "business"), outcome("app_error", "hard_failure")];
    expect(selectGoverningOutcome(matched, { attempts: {} })?.id).toBe("app_error");
  });

  it("prefers a business outcome over success", () => {
    const matched = [outcome("success", "success"), outcome("denied", "business")];
    expect(selectGoverningOutcome(matched, { attempts: {} })?.id).toBe("denied");
  });

  it("retires a recovery that has used up its attempts", () => {
    const matched = [outcome("success", "success"), outcome("overlay", "recoverable", 2)];
    expect(selectGoverningOutcome(matched, { attempts: { overlay: 2 } })?.id).toBe("success");
  });

  it("returns nothing when only an exhausted recovery matches", () => {
    // The step then fails on its own checkpoint, which produces a real
    // expected-versus-observed report rather than a silent loop.
    const matched = [outcome("overlay", "recoverable", 1)];
    expect(selectGoverningOutcome(matched, { attempts: { overlay: 1 } })).toBeUndefined();
  });

  it("breaks ties within a kind by declaration order, every time", () => {
    const matched = [outcome("specific", "business"), outcome("catch_all", "business")];
    for (let i = 0; i < 5; i++) {
      expect(selectGoverningOutcome(matched, { attempts: {} })?.id).toBe("specific");
    }
  });

  it("carries on when nothing matched", () => {
    expect(selectGoverningOutcome([], { attempts: {} })).toBeUndefined();
  });
});
