import { ExtractionError, FIELD_SPECS, type FailureKind } from "@lomi/core";
import type { LlmProvider, LlmRequest, LlmResult } from "./types.js";

/**
 * Deterministic stand-in for an LLM, used by tests and for running the stack
 * without credentials. Label-anchored regexes over the fixture document shapes;
 * evidence is the full regex match, so it is always verbatim.
 *
 * Knobs (constructor or env): delayMs (FAKE_LLM_DELAY_MS) to make extractions slow
 * enough to kill mid-flight; failWith (FAKE_LLM_FAIL=transient|permanent).
 */
const PATTERNS: Record<string, RegExp> = {
  invoice_number: /Invoice Number:\s*(\S+)/,
  issue_date: /Issue Date:\s*(\S+)/,
  due_date: /Due Date:\s*(\S+)/,
  vendor_name: /^([A-Z][A-Z &.,]+(?:LLC|INC\.?|LTD\.?|CORP\.?))$/m,
  total_amount: /Total Due:\s*\$?([\d,]+\.\d{2})/,
  tenant_name: /and ([A-Z][a-z]+ [A-Z][a-z]+) \("Tenant"\)/,
  monthly_rent: /monthly rent of \$([\d,]+\.\d{2})/,
  security_deposit: /sum of \$([\d,]+\.\d{2}) as a security deposit/,
  lease_start: /commencing on ([A-Z][a-z]+ \d{1,2}, \d{4})/,
  term_months: /\((\d+)\)\s+months/,
  report_quarter: /Reporting Period:\s*(.+)/,
  market_area: /Market Area:\s*(.+)/,
  vacancy_rate: /vacancy rate declined to ([\d.]+)%/,
  average_rent_1br: /one-bedroom unit reached \$([\d,]+)/,
  year_over_year_rent_growth: /year-over-year increase of ([\d.]+)%/,
  median_household_income: /median household income[^$]*\$([\d,]+)/i,
};

export interface FakeOptions {
  delayMs?: number;
  failWith?: FailureKind;
  /** Override the output entirely (tests: hallucinations, malformed output, ...). */
  respond?: (req: LlmRequest) => unknown;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });
}

export class FakeProvider implements LlmProvider {
  readonly name = "fake";
  readonly model = "fake-regex-v1";

  constructor(private readonly opts: FakeOptions = {}) {}

  async extract(req: LlmRequest, signal?: AbortSignal): Promise<LlmResult> {
    if (this.opts.delayMs) await sleep(this.opts.delayMs, signal);
    if (this.opts.failWith) {
      throw new ExtractionError(`Fake LLM configured to fail (${this.opts.failWith})`, this.opts.failWith);
    }
    const output = this.opts.respond
      ? this.opts.respond(req)
      : {
          fields: FIELD_SPECS[req.docType].map(({ field }) => {
            const m = PATTERNS[field]?.exec(req.documentText);
            return m
              ? { field, value: m[1]!.replace(/,/g, "").trim(), evidence: m[0].trim(), gap_reason: null }
              : { field, value: null, evidence: null, gap_reason: "Not stated in the document" };
          }),
        };
    return { output, raw: { provider: "fake", output }, model: this.model, inputTokens: null, outputTokens: null };
  }
}
