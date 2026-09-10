import { describe, expect, it } from "vitest";
import { InputError, renderTemplate, resolveValue, typeOutput, validateInputs } from "../src/replay/values.js";
import type { Capability, OutputField } from "../src/schema/capability.js";

const capability = {
  inputs: [
    { name: "memberId", type: "string", required: true, description: "", sensitivity: "pii", pattern: "^\\d{1,9}$" },
    { name: "includeClosed", type: "boolean", required: false, description: "", sensitivity: "none" },
  ],
} as unknown as Capability;

describe("input contract", () => {
  it("accepts arguments that match the declared contract", () => {
    expect(validateInputs(capability, { memberId: "12345" })).toEqual({ memberId: "12345" });
  });

  it("rejects a missing required argument before a browser is ever opened", () => {
    expect(() => validateInputs(capability, {})).toThrow(InputError);
  });

  it("rejects an argument the capability does not declare", () => {
    expect(() => validateInputs(capability, { memberId: "1", sqlInjection: "x" })).toThrow(/Unknown input/);
  });

  it("enforces a declared pattern", () => {
    expect(() => validateInputs(capability, { memberId: "not-a-number" })).toThrow(/does not match/);
  });

  it("coerces a boolean given as a string", () => {
    expect(validateInputs(capability, { memberId: "1", includeClosed: "true" })).toEqual({
      memberId: "1",
      includeClosed: true,
    });
  });
});

describe("templates and values", () => {
  it("fills placeholders from arguments and the runtime base URL", () => {
    expect(renderTemplate("{baseUrl}/frame/member?id={memberId}", { memberId: "12345" }, { baseUrl: "http://x" })).toBe(
      "http://x/frame/member?id=12345"
    );
  });

  it("refuses a template that references an argument nobody supplied", () => {
    expect(() => renderTemplate("{baseUrl}/{missing}", {}, { baseUrl: "http://x" })).toThrow(InputError);
  });

  it("resolves a secret from the runtime, never from the artifact", () => {
    const secrets = (name: string) => (name === "operator_password" ? "from-vault" : undefined);
    expect(resolveValue({ kind: "secret_ref", name: "operator_password" }, {}, secrets)).toBe("from-vault");
    expect(() => resolveValue({ kind: "secret_ref", name: "absent" }, {}, secrets)).toThrow(/No runtime value/);
  });

  it("types a currency string as a number the caller can do arithmetic on", () => {
    const field = { name: "b", type: "number", extract: { transform: "money" } } as unknown as OutputField;
    expect(typeOutput(field, "$4,182.55")).toBe(4182.55);
  });
});
