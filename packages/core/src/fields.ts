/**
 * Field specs per document type. Mirrors fixtures/expected-fields.json
 * (a test asserts they stay in sync) so runtime code never reads the fixtures dir.
 */
export const DOCUMENT_TYPES = ["invoice", "lease", "market_report"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const FIELD_TYPES = ["string", "date", "money", "number", "percent"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldSpec {
  field: string;
  type: FieldType;
}

export const FIELD_SPECS: Record<DocumentType, readonly FieldSpec[]> = {
  invoice: [
    { field: "invoice_number", type: "string" },
    { field: "issue_date", type: "date" },
    { field: "due_date", type: "date" },
    { field: "vendor_name", type: "string" },
    { field: "total_amount", type: "money" },
  ],
  lease: [
    { field: "tenant_name", type: "string" },
    { field: "monthly_rent", type: "money" },
    { field: "security_deposit", type: "money" },
    { field: "lease_start", type: "date" },
    { field: "term_months", type: "number" },
  ],
  market_report: [
    { field: "report_quarter", type: "string" },
    { field: "market_area", type: "string" },
    { field: "vacancy_rate", type: "percent" },
    { field: "average_rent_1br", type: "money" },
    { field: "year_over_year_rent_growth", type: "percent" },
    { field: "median_household_income", type: "money" },
  ],
};

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === "string" && (DOCUMENT_TYPES as readonly string[]).includes(value);
}
