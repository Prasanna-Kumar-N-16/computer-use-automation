import { describe, expect, it } from "vitest";
import { ControlToken, ControlViolation } from "../src/session/control.js";
import { ControlledSurface } from "../src/session/controlled-surface.js";
import type { Surface } from "../src/surface/types.js";

function fake() {
  const performed: string[] = [];
  const surface = {
    kind: "web" as const,
    observe: async () => ({ url: "", title: "", elements: [], frameText: {}, grids: [], capturedAt: "" }),
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

describe("control transfer", () => {
  it("starts with the automation driving", () => {
    expect(new ControlToken().current).toBe("automation");
  });

  it("records who handed control to whom, and why", () => {
    const token = new ControlToken();
    token.transfer("none", "escalating");
    token.transfer("human", "claimed by operator");
    token.transfer("automation", "resumed");
    expect(token.transfers.map((t) => `${t.from}->${t.to}`)).toEqual([
      "automation->none",
      "none->human",
      "human->automation",
    ]);
    expect(token.transfers[0]!.reason).toBe("escalating");
  });

  it("passes through 'nobody driving' rather than implying a human was present", () => {
    // Between the automation pausing and an operator picking it up, no one is at the
    // wheel, and the evidence should say so.
    const token = new ControlToken();
    token.transfer("none", "escalating");
    expect(token.current).toBe("none");
  });

  it("refuses an automation action while a human holds the wheel", async () => {
    const token = new ControlToken();
    const { surface, performed } = fake();
    const controlled = new ControlledSurface(surface, token, "automation");
    token.transfer("human", "operator took over");
    await expect(controlled.act({ kind: "click", ref: "x" })).rejects.toBeInstanceOf(ControlViolation);
    expect(performed).toEqual([]);
  });

  it("still allows observation while a human is driving", async () => {
    const token = new ControlToken();
    const { surface } = fake();
    const controlled = new ControlledSurface(surface, token, "automation");
    token.transfer("human", "operator took over");
    await expect(controlled.observe()).resolves.toBeDefined();
  });

  it("lets the automation act again once control comes back", async () => {
    const token = new ControlToken();
    const { surface, performed } = fake();
    const controlled = new ControlledSurface(surface, token, "automation");
    token.transfer("human", "took over");
    token.transfer("automation", "handed back");
    await controlled.act({ kind: "click", ref: "x" });
    expect(performed).toEqual(["click"]);
  });

  it("wakes a waiter when control arrives", async () => {
    const token = new ControlToken();
    const waiting = token.waitFor("automation", 2_000);
    token.transfer("human", "took over");
    token.transfer("automation", "handed back");
    await expect(waiting).resolves.toBe(true);
  });

  it("gives up waiting rather than blocking forever", async () => {
    await expect(new ControlToken().waitFor("human", 60)).resolves.toBe(false);
  });
});
