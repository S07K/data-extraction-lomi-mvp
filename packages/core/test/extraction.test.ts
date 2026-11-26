import { describe, expect, it } from "vitest";
import { buildExtractionPrompt, validateExtraction, type LlmOutput } from "../src/extraction.js";
import { INVOICE_V1 } from "./texts.js";

const item = (field: string, value: string | null, evidence: string | null, gap_reason: string | null = null) => ({
  field,
  value,
  evidence,
  gap_reason,
});

describe("validateExtraction", () => {
  it("keeps values whose evidence is verbatim and supports the value", () => {
    const out: LlmOutput = {
      fields: [
        item("invoice_number", "INV-2025-0847", "Invoice Number: INV-2025-0847"),
        item("issue_date", "2025-09-14", "Issue Date: 2025-09-14"),
        item("due_date", "2025-10-14", "Due Date: 2025-10-14"),
        item("vendor_name", "Meridian Office Supplies LLC", "MERIDIAN OFFICE SUPPLIES LLC"),
        item("total_amount", "5230.29", "Total Due: $5,230.29"),
      ],
    };
    const values = validateExtraction("invoice", INVOICE_V1, out);
    expect(values.map((v) => v.gapReason)).toEqual([null, null, null, null, null]);
    const total = values.find((v) => v.field === "total_amount")!;
    expect(total).toMatchObject({ value: "5230.29", unit: "USD", evidence: "Total Due: $5,230.29" });
    expect(INVOICE_V1.slice(total.evidenceStart!, total.evidenceEnd!)).toBe("Total Due: $5,230.29");
  });

  it("turns a hallucinated quote into a gap — the value is never kept", () => {
    const out: LlmOutput = { fields: [item("total_amount", "5230.29", "Amount payable: $5,230.29")] };
    const total = validateExtraction("invoice", INVOICE_V1, out).find((v) => v.field === "total_amount")!;
    expect(total.value).toBeNull();
    expect(total.evidence).toBeNull();
    expect(total.gapReason).toMatch(/not found verbatim/);
  });

  it("turns a real quote with a mismatched value into a gap", () => {
    const out: LlmOutput = { fields: [item("total_amount", "4815.00", "Total Due: $5,230.29")] };
    const total = validateExtraction("invoice", INVOICE_V1, out).find((v) => v.field === "total_amount")!;
    expect(total.value).toBeNull();
    expect(total.gapReason).toMatch(/does not appear in its evidence/);
  });

  it("keeps the model's gap reason, and fills gaps for missing/valueless/unparseable entries", () => {
    const out: LlmOutput = {
      fields: [
        item("invoice_number", null, null, "No invoice number on the page"),
        item("issue_date", "2025-09-14", null),
        item("due_date", "next month", "Due Date: 2025-10-14"),
        item("not_a_field", "x", "INVOICE"),
      ],
    };
    const byField = Object.fromEntries(validateExtraction("invoice", INVOICE_V1, out).map((v) => [v.field, v]));
    expect(byField.invoice_number!.gapReason).toBe("No invoice number on the page");
    expect(byField.issue_date!.gapReason).toMatch(/without an evidence quote/);
    expect(byField.due_date!.gapReason).toMatch(/could not be interpreted as date/);
    expect(byField.vendor_name!.gapReason).toMatch(/no entry/);
    expect(Object.keys(byField)).not.toContain("not_a_field");
  });

  it("always returns exactly one value per expected field, in spec order", () => {
    const out: LlmOutput = {
      fields: [item("due_date", "2025-10-14", "Due Date: 2025-10-14"), item("due_date", "2025-01-01", "INVOICE")],
    };
    const values = validateExtraction("invoice", INVOICE_V1, out);
    expect(values.map((v) => v.field)).toEqual(["invoice_number", "issue_date", "due_date", "vendor_name", "total_amount"]);
    expect(values[2]!.value).toBe("2025-10-14"); // first entry wins
  });
});

describe("buildExtractionPrompt", () => {
  it("lists every field and embeds the document", () => {
    const p = buildExtractionPrompt("lease", "DOC TEXT");
    for (const f of ["tenant_name", "monthly_rent", "security_deposit", "lease_start", "term_months"]) {
      expect(p.user).toContain(f);
    }
    expect(p.user).toContain("<document>\nDOC TEXT\n</document>");
  });
});
