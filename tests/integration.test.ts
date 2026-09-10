/**
 * The end-to-end thread, with no model anywhere in it.
 *
 * These run the committed artifact against a real browser and a real (if small)
 * legacy application, which is the only way to have any confidence that locator
 * resolution and outcome classification actually work.
 */

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, stopApp, inject, TEST_BASE_URL } from "./helpers/app.js";
import { defaultConfig, openSession, replayCapability, type Session } from "../src/runtime.js";
import { parseCapability } from "../src/schema/capability.js";
import type { LocatorBundle } from "../src/schema/common.js";

const capability = parseCapability(
  JSON.parse(readFileSync("capabilities/member.savings_balance.lookup@v1.json", "utf8"))
);

const config = defaultConfig({
  baseUrl: TEST_BASE_URL,
  evidenceRoot: "evidence/tmp",
  operatorPort: 4281,
  escalationTimeoutMs: 3_000,
});

beforeAll(async () => {
  await startApp();
}, 90_000);

afterAll(async () => {
  await stopApp();
});

describe("deterministic replay", () => {
  it("completes the goal and returns typed outputs", async () => {
    await inject("/dev/reset");
    const result = await replayCapability(capability, { memberId: "12345" }, config);
    expect(result.status).toBe("success");
    expect(result.outcomeCode).toBe("SUCCESS");
    expect(result.outputs["savingsBalance"]).toBe(4182.55);
    expect(result.outputs["memberName"]).toBe("Dolores Ferrante");
    // Every step should have been found by the most durable strategy available.
    expect(result.steps.every((s) => s.locator?.resolvedBy === "control_name")).toBe(true);
  }, 90_000);

  it("reports a missing record as a business outcome, not a crash", async () => {
    await inject("/dev/reset");
    const result = await replayCapability(capability, { memberId: "99999" }, config);
    expect(result.status).toBe("business_outcome");
    expect(result.outcomeCode).toBe("MEMBER_NOT_FOUND");
    expect(result.failure).toBeUndefined();
    expect(result.message).toContain("99999");
  }, 90_000);

  it("reports an entitlement refusal as a business outcome the caller can act on", async () => {
    await inject("/dev/reset");
    const result = await replayCapability(capability, { memberId: "70001" }, config);
    expect(result.status).toBe("business_outcome");
    expect(result.outcomeCode).toBe("PERMISSION_DENIED");
  }, 90_000);

  it("reports an application error as a failure with a debuggable trail", async () => {
    await inject("/dev/reset");
    const result = await replayCapability(capability, { memberId: "50000" }, config);
    expect(result.status).toBe("failed");
    expect(result.outcomeCode).toBe("APPLICATION_ERROR");
    expect(result.failure?.classification).toBe("app_error");
    expect(result.failure?.observed).toContain("SQLCODE");
    expect(result.evidenceDir).toBeTruthy();
  }, 90_000);

  it("dismisses a broadcast dialog and carries on without repeating the action", async () => {
    await inject("/dev/reset");
    const result = await replayCapability(capability, { memberId: "55555" }, config);
    expect(result.status).toBe("success");
    expect(result.steps.some((s) => s.recoveries.some((r) => r.outcomeCode === "SYSTEM_MESSAGE"))).toBe(true);
    // The recovery must not have re-run the click; the step ran exactly once.
    expect(result.steps.filter((s) => s.stepId === "s2")).toHaveLength(1);
  }, 90_000);

  it("re-authenticates and restarts the flow when the session expires mid-run", async () => {
    await inject("/dev/reset");
    await inject("/dev/expire-after?n=3");
    const result = await replayCapability(capability, { memberId: "12345" }, config);
    expect(result.status).toBe("success");
    expect(result.outputs["savingsBalance"]).toBe(4182.55);
  }, 120_000);

  it("rejects bad arguments before opening the application", async () => {
    await inject("/dev/reset");
    const result = await replayCapability(capability, {}, config);
    expect(result.status).toBe("failed");
    expect(result.failure?.classification).toBe("input_invalid");
    expect(result.steps).toHaveLength(0);
  }, 60_000);

  it("refuses to run a draft capability unattended", async () => {
    await inject("/dev/reset");
    const result = await replayCapability(capability, { memberId: "12345" }, { ...config, requireApproved: true });
    expect(result.status).toBe("failed");
    expect(result.failure?.classification).toBe("precondition_failed");
    expect(result.message).toContain("draft");
  }, 60_000);
});

describe("locator resolution against real legacy markup", () => {
  let session: Session;

  beforeAll(async () => {
    session = await openSession({ ...config, operatorPort: 4282 });
    await session.host.signOn();
    await session.host.surface.act({ kind: "navigate", url: `${TEST_BASE_URL}/desk` });
    await session.host.surface.settle();
  }, 90_000);

  afterAll(async () => {
    await session?.close();
  });

  it("builds several independent strategies for one control and they all agree", async () => {
    const surface = session.host.surface;
    const observation = await surface.observe();
    const field = observation.elements.find((e) => e.meta?.["controlName"] === "txtMbrNo")!;
    const bundle = await surface.describeElement(field.ref);

    // The label lives in a sibling table cell with no <label for>, so reconstructing
    // that association is the only way a label-based strategy can exist at all.
    expect(bundle.strategies.map((s) => s.kind)).toContain("label_anchor");
    expect(bundle.strategies.map((s) => s.kind)).toContain("control_name");
    expect(bundle.framePath).toEqual(["mainFrame"]);

    const resolution = await surface.resolve(bundle);
    expect(resolution.status).toBe("resolved");
    expect(resolution.resolvedBy).toBe("control_name");
    // Agreement between independent signals is the confidence signal.
    expect(resolution.disagreements).toEqual([]);
    expect(resolution.attempted.filter((a) => a.matches === 1).length).toBeGreaterThan(2);
  }, 60_000);

  it("refuses to guess when a strategy matches more than one control", async () => {
    const surface = session.host.surface;
    // The nav frame (loaded alongside mainFrame in the frameset) has "Member
    // Inquiry" and "Reports", both of which contain "e" — a genuine collision.
    const ambiguous: LocatorBundle = {
      description: "any link whose text contains 'e'",
      framePath: ["navFrame"],
      strategies: [{ kind: "text_anchor", text: "e", role: "link", exact: false }],
    };
    const resolution = await surface.resolve(ambiguous);
    expect(resolution.status).toBe("ambiguous");
    expect(resolution.ref).toBeUndefined();
  }, 60_000);

  it("reports a control that is simply not there, rather than throwing", async () => {
    const resolution = await session.host.surface.resolve({
      description: "a control that does not exist",
      framePath: ["mainFrame"],
      strategies: [{ kind: "control_name", name: "txtNoSuchField" }],
    });
    expect(resolution.status).toBe("unresolved");
  }, 60_000);

  it("reads a grid value by header and row rather than by position", async () => {
    const surface = session.host.surface;
    const observation = await surface.observe();
    const field = observation.elements.find((e) => e.meta?.["controlName"] === "txtMbrNo")!;
    await surface.act({ kind: "type", ref: field.ref, text: "24680" });
    const search = (await surface.observe()).elements.find((e) => e.meta?.["controlName"] === "cmdSearch")!;
    await surface.act({ kind: "click", ref: search.ref });
    await surface.settle();

    const frozen = await surface.extract({
      kind: "table_cell",
      framePath: ["mainFrame"],
      tableHeaders: ["Account", "Type", "Status", "Current Balance", "Opened"],
      rowMatchColumn: "Type",
      rowMatchValue: "Money Market",
      rowMatchMode: "equals",
      valueColumn: "Status",
      transform: "trim",
    });
    expect(frozen).toBe("Frozen");
  }, 60_000);
});
