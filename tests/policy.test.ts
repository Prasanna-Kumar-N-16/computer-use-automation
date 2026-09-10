import { describe, expect, it } from "vitest";
import { GuardedSurface, PolicyEngine, PolicyViolation, compilePattern } from "../src/policy/engine.js";
import type { ObservedElement, Surface } from "../src/surface/types.js";

const policy = PolicyEngine.load("policy/allowlist.yaml");

function element(over: Partial<ObservedElement> = {}): ObservedElement {
  return {
    ref: "mainFrame#1",
    role: "button",
    name: "Search",
    framePath: ["mainFrame"],
    visible: true,
    enabled: true,
    meta: { controlName: "cmdSearch" },
    ...over,
  };
}

/** A surface that records what reached it, so we can prove the guard stopped things. */
function fakeSurface(elements: ObservedElement[]) {
  const performed: string[] = [];
  const surface = {
    kind: "web" as const,
    observe: async () => ({
      url: "http://localhost:4173/desk",
      title: "t",
      elements,
      frameText: {},
      grids: [],
      capturedAt: new Date().toISOString(),
    }),
    act: async (a: any) => {
      performed.push(a.kind);
      return { ok: true };
    },
    settle: async () => {},
    screenshot: async () => Buffer.alloc(0),
    resolve: async () => ({ attempted: [], disagreements: [], status: "unresolved" as const }),
    describeElement: async () => ({ description: "", framePath: [], strategies: [] as never[] }),
    extract: async () => null,
    fingerprint: async () => ({}),
  } as unknown as Surface;
  return { surface, performed };
}

describe("allowlist", () => {
  it("permits a route inside the application", () => {
    expect(policy.checkNavigation("http://localhost:4173/frame/member").allowed).toBe(true);
  });

  it("refuses an origin that is not listed", () => {
    const verdict = policy.checkNavigation("https://example.com/frame/member");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("not on the allowlist");
  });

  it("refuses the test-injection surface even on an allowed origin", () => {
    // An agent that could reach /dev/* could disarm its own guardrails.
    expect(policy.checkNavigation("http://localhost:4173/dev/expire").allowed).toBe(false);
  });

  it("refuses a route that matches nothing", () => {
    expect(policy.checkNavigation("http://localhost:4173/admin/secrets").allowed).toBe(false);
  });
});

describe("risk classification", () => {
  it("treats an ordinary search button as safe", () => {
    expect(policy.classifyRisk(element())).toBe("safe");
  });

  it("classifies by the control name even when the label has been rebranded", () => {
    // The visible label is what a tenant changes; the name attribute is part of the
    // server contract, so a renamed "Post Account" must not become safe.
    expect(policy.classifyRisk(element({ name: "Submit Request", meta: { controlName: "cmdPost" } }))).toBe(
      "irreversible"
    );
  });

  it("classifies by visible label when there is no control name", () => {
    expect(policy.classifyRisk(element({ name: "Post Account", meta: {} }))).toBe("irreversible");
  });

  it("understands an inline case-insensitive flag in a configured pattern", () => {
    expect(compilePattern("(?i)^post account$").test("POST ACCOUNT")).toBe(true);
  });
});

describe("the guarded surface is the only way to act", () => {
  it("blocks navigation outside the allowlist before it reaches the browser", async () => {
    const { surface, performed } = fakeSurface([]);
    const guarded = new GuardedSurface(surface, policy, { budget: 10 });
    await expect(guarded.act({ kind: "navigate", url: "https://example.com/" })).rejects.toBeInstanceOf(
      PolicyViolation
    );
    expect(performed).toEqual([]);
  });

  it("refuses an irreversible action when no approval channel exists", async () => {
    const el = element({ name: "Post Account", meta: { controlName: "cmdPost" } });
    const { surface, performed } = fakeSurface([el]);
    const guarded = new GuardedSurface(surface, policy, { budget: 10 });
    await guarded.observe();
    await expect(guarded.act({ kind: "click", ref: el.ref })).rejects.toThrow(/requires human approval/);
    expect(performed).toEqual([]);
  });

  it("performs an irreversible action once a human approves it", async () => {
    const el = element({ name: "Post Account", meta: { controlName: "cmdPost" } });
    const { surface, performed } = fakeSurface([el]);
    const guarded = new GuardedSurface(surface, policy, {
      budget: 10,
      requestApproval: async () => ({ approved: true, by: "tester" }),
    });
    await guarded.observe();
    await guarded.act({ kind: "click", ref: el.ref });
    expect(performed).toEqual(["click"]);
  });

  it("does not perform an irreversible action a human declined", async () => {
    const el = element({ name: "Post Account", meta: { controlName: "cmdPost" } });
    const { surface, performed } = fakeSurface([el]);
    const guarded = new GuardedSurface(surface, policy, {
      budget: 10,
      requestApproval: async () => ({ approved: false, by: "tester" }),
    });
    await guarded.observe();
    await expect(guarded.act({ kind: "click", ref: el.ref })).rejects.toThrow(/approval denied/i);
    expect(performed).toEqual([]);
  });

  it("stops at the action budget", async () => {
    const el = element();
    const { surface } = fakeSurface([el]);
    const guarded = new GuardedSurface(surface, policy, { budget: 2 });
    await guarded.observe();
    await guarded.act({ kind: "click", ref: el.ref });
    await guarded.act({ kind: "click", ref: el.ref });
    await expect(guarded.act({ kind: "click", ref: el.ref })).rejects.toThrow(/budget/);
  });
});
