import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decideCarryOver, type ValidatedValue } from "@lomi/core";
import { FakeProvider, parsePdf, runExtraction } from "../src/index.js";

const pdf = (name: string) => new Uint8Array(readFileSync(new URL(`../../../fixtures/documents/${name}`, import.meta.url)));
const fake = new FakeProvider();

async function extractFixture(name: string, type: "invoice" | "lease" | "market_report") {
  const { text } = await parsePdf(pdf(name));
  const { values } = await runExtraction(fake, type, text);
  return { text, values, byField: Object.fromEntries(values.map((v) => [v.field, v])) as Record<string, ValidatedValue> };
}

describe("parsePdf on the fixtures", () => {
  it("extracts the text layer", async () => {
    const { text, pages } = await parsePdf(pdf("invoice-001.pdf"));
    expect(pages).toBe(1);
    expect(text).toContain("Invoice Number: INV-2025-0847");
    expect(text).toContain("Total Due:");
  });

  it("rejects non-PDF bytes as a permanent failure", async () => {
    await expect(parsePdf(new TextEncoder().encode("not a pdf"))).rejects.toMatchObject({ kind: "permanent" });
  });
});

describe("end-to-end extraction on real fixture text (fake LLM)", () => {
  it("invoice v1: all five fields with verbatim evidence", async () => {
    const { text, byField } = await extractFixture("invoice-001.pdf", "invoice");
    expect(byField.invoice_number!.value).toBe("INV-2025-0847");
    expect(byField.due_date!.value).toBe("2025-10-14");
    expect(byField.total_amount).toMatchObject({ value: "5230.29", unit: "USD" });
    expect(byField.vendor_name!.value).toBe("MERIDIAN OFFICE SUPPLIES LLC");
    for (const v of Object.values(byField)) {
      expect(text.slice(v.evidenceStart!, v.evidenceEnd!)).toBe(v.evidence);
    }
  });

  it("lease: multi-line evidence and long-form dates", async () => {
    const { byField } = await extractFixture("lease-excerpt-001.pdf", "lease");
    expect(byField.tenant_name!.value).toBe("Dana Okafor");
    expect(byField.lease_start!.value).toBe("2025-03-01");
    expect(byField.term_months!.value).toBe("24");
    expect(byField.security_deposit!.value).toBe("3525.00");
  });

  it("market report: the field that isn't in the document is a gap with a reason", async () => {
    const { byField } = await extractFixture("market-report-excerpt-001.pdf", "market_report");
    expect(byField.vacancy_rate).toMatchObject({ value: "4.2", unit: "%" });
    expect(byField.average_rent_1br!.value).toBe("1985.00");
    expect(byField.median_household_income).toMatchObject({ value: null, evidence: null });
    expect(byField.median_household_income!.gapReason).toBeTruthy();
  });

  it("a hallucinated quote from the LLM is stored as a gap, never a value", async () => {
    const { text } = await parsePdf(pdf("invoice-001.pdf"));
    const liar = new FakeProvider({
      respond: () => ({
        fields: [{ field: "total_amount", value: "9999.99", evidence: "Total Due: $9,999.99", gap_reason: null }],
      }),
    });
    const { values } = await runExtraction(liar, "invoice", text);
    const total = values.find((v) => v.field === "total_amount")!;
    expect(total.value).toBeNull();
    expect(total.gapReason).toMatch(/not found verbatim/);
  });

  it("malformed model output is a transient failure (retryable), not a crash", async () => {
    const broken = new FakeProvider({ respond: () => ({ nope: true }) });
    await expect(runExtraction(broken, "invoice", "x")).rejects.toMatchObject({ kind: "transient" });
  });
});

describe("ACCEPTANCE: invoice v1 → v2 re-extraction", () => {
  it("exactly the two changed fields need re-review; the rest carry over", async () => {
    const v1 = await extractFixture("invoice-001.pdf", "invoice");
    const v2 = await extractFixture("invoice-001.v2.pdf", "invoice");
    const decisions = Object.fromEntries(
      v2.values.map((nv) => [nv.field, decideCarryOver(v1.byField[nv.field] ?? null, nv, v2.text).status]),
    );
    expect(decisions).toEqual({
      invoice_number: "unchanged",
      issue_date: "unchanged",
      due_date: "changed",
      vendor_name: "unchanged",
      total_amount: "changed",
    });
    // Offsets did move — proving the comparison is position-independent.
    expect(v2.byField.invoice_number!.evidenceStart).not.toBe(v1.byField.invoice_number!.evidenceStart);
  });
});
