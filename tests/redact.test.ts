import { describe, expect, it } from "vitest";
import { Redactor, keepLast4, maskMiddle } from "../src/policy/redact.js";

const config = {
  rules: [
    { name: "account_number", pattern: "\\b\\d{10}\\b", mode: "keep_last4" as const },
    { name: "ssn", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b", mode: "mask_all" as const },
  ],
  maskSensitivity: ["pii", "secret"] as ("none" | "pii" | "secret")[],
};

describe("redaction", () => {
  it("keeps the last four digits of an account number", () => {
    const out = new Redactor(config).redact("Posted to account 0001284471 today.");
    expect(out).not.toContain("0001284471");
    expect(out).toContain("4471");
  });

  it("masks a tax identifier completely", () => {
    expect(new Redactor(config).redact("SSN 123-45-6789")).not.toContain("6789");
  });

  it("never lets a registered credential through, wherever it appears", () => {
    // Pattern rules only catch shapes someone predicted. A password can surface in an
    // error string or a URL, so the literal value is registered too.
    const redactor = new Redactor(config);
    redactor.registerSecret("hunter2-swordfish", "operator_password");
    const out = redactor.redact("login failed for hunter2-swordfish at /signon?p=hunter2-swordfish");
    expect(out).not.toContain("hunter2-swordfish");
    expect(out).toContain("[redacted:operator_password]");
  });

  it("masks a value declared as regulated but keeps it recognisable", () => {
    const redactor = new Redactor(config);
    redactor.registerSensitive("12345", "pii", "memberId");
    const out = redactor.redact("Looked up member 12345.");
    expect(out).not.toContain("12345");
    expect(out).toContain(maskMiddle("12345"));
  });

  it("leaves a value declared as non-sensitive alone", () => {
    const redactor = new Redactor(config);
    redactor.registerSensitive("Savings", "none", "productType");
    expect(redactor.redact("Product Savings")).toBe("Product Savings");
  });

  it("redacts through nested structures on their way to disk", () => {
    const redactor = new Redactor(config);
    const out = redactor.redactDeep({ steps: [{ note: "account 0002771830" }], count: 2 });
    expect(JSON.stringify(out)).not.toContain("0002771830");
    expect(out.count).toBe(2);
  });

  it("masks short values entirely rather than leaking most of them", () => {
    expect(keepLast4("12")).not.toContain("12");
  });
});
