import { describe, expect, it } from "vitest";
import { decideCarryOver, type ComparableValue } from "../src/carryover.js";
import { INVOICE_V2 } from "./texts.js";

const v = (value: string | null, evidence: string | null, unit: string | null = null): ComparableValue => ({
  value,
  unit,
  evidence,
});

describe("decideCarryOver", () => {
  it("no base version → new", () => {
    expect(decideCarryOver(null, v("x", "x"), "x").status).toBe("new");
  });

  it("identical quote + value is unchanged even though every offset shifted", () => {
    // INVOICE_V2 inserts a paragraph and changes line items: positions move, the quote does not.
    const d = decideCarryOver(v("2025-09-14", "Issue Date: 2025-09-14"), v("2025-09-14", "Issue Date: 2025-09-14"), INVOICE_V2);
    expect(d).toEqual({ status: "unchanged", rule: "same-quote" });
  });

  it("changed value is changed (the invoice's due date and total)", () => {
    expect(decideCarryOver(v("2025-10-14", "Due Date: 2025-10-14"), v("2025-11-13", "Due Date: 2025-11-13"), INVOICE_V2).status).toBe("changed");
    expect(
      decideCarryOver(v("5230.29", "Total Due: $5,230.29", "USD"), v("6126.45", "Total Due: $6,126.45", "USD"), INVOICE_V2).status,
    ).toBe("changed");
  });

  it("model quoting differently across runs is still unchanged if the old quote survives", () => {
    const d = decideCarryOver(v("2025-09-14", "Issue Date: 2025-09-14"), v("2025-09-14", "2025-09-14"), INVOICE_V2);
    expect(d).toEqual({ status: "unchanged", rule: "old-quote-still-present" });
  });

  it("same value but the old passage is gone → changed (evidence moved/rewritten)", () => {
    const d = decideCarryOver(v("2025-09-14", "Issued: 2025-09-14"), v("2025-09-14", "Issue Date: 2025-09-14"), INVOICE_V2);
    expect(d.status).toBe("changed");
  });

  it("gap handling", () => {
    expect(decideCarryOver(v(null, null), v(null, null), INVOICE_V2)).toEqual({ status: "unchanged", rule: "both-gaps" });
    expect(decideCarryOver(v(null, null), v("x", "INVOICE"), INVOICE_V2).status).toBe("changed");
    expect(decideCarryOver(v("x", "INVOICE"), v(null, null), INVOICE_V2).status).toBe("changed");
  });

  it("whitespace-only differences in the quote don't count as a change", () => {
    const d = decideCarryOver(v("1", "a  b\nc"), v("1", "a b c"), "zzz");
    expect(d.rule).toBe("same-quote");
  });
});
