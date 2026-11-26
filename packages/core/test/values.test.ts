import { describe, expect, it } from "vitest";
import { canonicalizeValue, findDates, isValueSupportedByEvidence } from "../src/values.js";

const ok = (r: ReturnType<typeof canonicalizeValue>) => {
  if (!r.ok) throw new Error(r.reason);
  return r.value;
};

describe("canonicalizeValue", () => {
  it("money: strips symbols/separators, fixes 2dp, infers currency", () => {
    expect(ok(canonicalizeValue("money", "$5,230.29"))).toEqual({ value: "5230.29", unit: "USD" });
    expect(ok(canonicalizeValue("money", "1985", "reached $1,985 per month"))).toEqual({ value: "1985.00", unit: "USD" });
    expect(canonicalizeValue("money", "about five grand").ok).toBe(false);
  });

  it("dates: ISO, long-form and US numeric all become YYYY-MM-DD", () => {
    expect(ok(canonicalizeValue("date", "2025-10-14")).value).toBe("2025-10-14");
    expect(ok(canonicalizeValue("date", "March 1, 2025")).value).toBe("2025-03-01");
    expect(ok(canonicalizeValue("date", "1 March 2025")).value).toBe("2025-03-01");
    expect(ok(canonicalizeValue("date", "03/01/2025")).value).toBe("2025-03-01");
    expect(canonicalizeValue("date", "2025-02-30").ok).toBe(false);
    expect(canonicalizeValue("date", "soon").ok).toBe(false);
  });

  it("percent and number", () => {
    expect(ok(canonicalizeValue("percent", "4.2%"))).toEqual({ value: "4.2", unit: "%" });
    expect(ok(canonicalizeValue("percent", "3.80"))).toEqual({ value: "3.8", unit: "%" });
    expect(ok(canonicalizeValue("number", "24")).value).toBe("24");
    expect(canonicalizeValue("number", "twenty-four").ok).toBe(false);
  });

  it("string: collapses whitespace", () => {
    expect(ok(canonicalizeValue("string", "  Dana   Okafor ")).value).toBe("Dana Okafor");
  });
});

describe("isValueSupportedByEvidence", () => {
  it("accepts values literally present in the quote", () => {
    expect(isValueSupportedByEvidence("money", { value: "5230.29", unit: "USD" }, "Total Due: $5,230.29")).toBe(true);
    expect(isValueSupportedByEvidence("date", { value: "2025-03-01", unit: null }, "commencing on March 1, 2025")).toBe(true);
    expect(isValueSupportedByEvidence("number", { value: "24", unit: null }, "twenty-four (24)\nmonths")).toBe(true);
    expect(isValueSupportedByEvidence("string", { value: "Meridian Office Supplies LLC", unit: null }, "MERIDIAN OFFICE SUPPLIES LLC")).toBe(true);
  });

  it("rejects a real quote paired with the wrong value", () => {
    expect(isValueSupportedByEvidence("money", { value: "4815.00", unit: "USD" }, "Total Due: $5,230.29")).toBe(false);
    expect(isValueSupportedByEvidence("date", { value: "2025-10-15", unit: null }, "Due Date: 2025-10-14")).toBe(false);
  });
});

describe("findDates", () => {
  it("finds dates in order", () => {
    expect(findDates("from March 1, 2025 and ending on February 28, 2027")).toEqual(["2025-03-01", "2027-02-28"]);
  });
});
