/**
 * The extraction contract shared by every LLM provider: prompt, output schema,
 * and post-hoc validation. Providers only move bytes; correctness lives here.
 */
import { z } from "zod";
import { FIELD_SPECS, type DocumentType, type FieldSpec, type FieldType } from "./fields.js";
import { locateQuote } from "./text.js";
import { canonicalizeValue, isValueSupportedByEvidence } from "./values.js";

export const PROMPT_VERSION = "extract-v1";

/** What we ask the model to return. Values are strings; we canonicalize ourselves. */
export const llmFieldSchema = z.object({
  field: z.string(),
  value: z.string().nullable(),
  evidence: z.string().nullable(),
  gap_reason: z.string().nullable(),
});
export const llmOutputSchema = z.object({ fields: z.array(llmFieldSchema) });
export type LlmOutput = z.infer<typeof llmOutputSchema>;

/** JSON Schema handed to the provider (Anthropic tool input / Agent SDK outputFormat). */
export function buildOutputJsonSchema(docType: DocumentType): Record<string, unknown> {
  const names = FIELD_SPECS[docType].map((f) => f.field);
  return {
    type: "object",
    additionalProperties: false,
    required: ["fields"],
    properties: {
      fields: {
        type: "array",
        description: "Exactly one entry per requested field.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["field", "value", "evidence", "gap_reason"],
          properties: {
            field: { type: "string", enum: names },
            value: { type: ["string", "null"], description: "Normalized value, or null if the field is not stated." },
            evidence: {
              type: ["string", "null"],
              description: "Exact contiguous passage copied character-for-character from the document, or null.",
            },
            gap_reason: { type: ["string", "null"], description: "Why the field is missing; null when a value is given." },
          },
        },
      },
    },
  };
}

const FORMAT_RULES: Record<FieldType, string> = {
  string: "the text as written",
  date: "YYYY-MM-DD",
  money: "decimal number without currency symbols or thousands separators, e.g. 1234.50",
  percent: "percentage points as a plain number without the % sign, e.g. 4.2 for 4.2%",
  number: "plain number in digits, e.g. 24",
};

export const EXTRACTION_SYSTEM_PROMPT = `You extract structured fields from business documents for a human review workflow.
Every value you return is checked against the document by software and then by a human reviewer.

Rules:
1. evidence MUST be copied character-for-character from the document: one contiguous passage, no ellipses, no paraphrasing, no added or removed words. Include the label or surrounding words that identify the value (e.g. "Due Date: 2025-10-14", not just "2025-10-14"). Prefer a single line or sentence.
2. Only report values that are explicitly stated. Never compute, infer, or guess (do not add up line items, do not derive dates).
3. If a field is not explicitly stated, set value and evidence to null and give a short gap_reason.
4. Return exactly one entry per requested field.`;

export interface ExtractionPrompt {
  system: string;
  user: string;
  schema: Record<string, unknown>;
}

export function buildExtractionPrompt(docType: DocumentType, documentText: string): ExtractionPrompt {
  const fieldLines = FIELD_SPECS[docType]
    .map((f) => `- ${f.field} (${f.type}; value format: ${FORMAT_RULES[f.type]})`)
    .join("\n");
  const user = `Document type: ${docType}

Fields to extract:
${fieldLines}

<document>
${documentText}
</document>`;
  return { system: EXTRACTION_SYSTEM_PROMPT, user, schema: buildOutputJsonSchema(docType) };
}

/** A validated value ready to persist. Either a value with verified evidence, or a gap. */
export interface ValidatedValue {
  field: string;
  fieldType: FieldType;
  value: string | null;
  unit: string | null;
  evidence: string | null;
  evidenceStart: number | null;
  evidenceEnd: number | null;
  gapReason: string | null;
}

function gap(spec: FieldSpec, reason: string): ValidatedValue {
  return {
    field: spec.field,
    fieldType: spec.type,
    value: null,
    unit: null,
    evidence: null,
    evidenceStart: null,
    evidenceEnd: null,
    gapReason: reason,
  };
}

function clip(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Turn raw model output into exactly one ValidatedValue per expected field.
 * Anything that is not verifiable against `documentText` becomes a gap with a reason:
 *  - model reported the field missing
 *  - value without evidence
 *  - evidence not found verbatim in THIS version's parsed text  (hallucination defense)
 *  - value not parseable for the field type
 *  - value not supported by its own evidence quote
 */
export function validateExtraction(docType: DocumentType, documentText: string, output: LlmOutput): ValidatedValue[] {
  const byField = new Map<string, LlmOutput["fields"][number]>();
  for (const item of output.fields) if (!byField.has(item.field)) byField.set(item.field, item);

  return FIELD_SPECS[docType].map((spec) => {
    const item = byField.get(spec.field);
    if (!item) return gap(spec, "Model returned no entry for this field");

    if (item.value === null || item.value.trim() === "") {
      return gap(spec, item.gap_reason?.trim() || "Not found in document");
    }
    if (item.evidence === null || item.evidence.trim() === "") {
      return gap(spec, `Model gave a value ("${clip(item.value)}") without an evidence quote`);
    }

    const span = locateQuote(documentText, item.evidence);
    if (!span) {
      return gap(
        spec,
        `Evidence not found verbatim in document text (model claimed "${clip(item.value)}" from quote "${clip(item.evidence)}")`,
      );
    }
    const evidence = documentText.slice(span.start, span.end);

    const canonical = canonicalizeValue(spec.type, item.value, evidence);
    if (!canonical.ok) return gap(spec, `Value could not be interpreted as ${spec.type}: ${canonical.reason}`);

    if (!isValueSupportedByEvidence(spec.type, canonical.value, evidence)) {
      return gap(spec, `Value "${clip(item.value)}" does not appear in its evidence quote "${clip(evidence)}"`);
    }

    return {
      field: spec.field,
      fieldType: spec.type,
      value: canonical.value.value,
      unit: canonical.value.unit,
      evidence,
      evidenceStart: span.start,
      evidenceEnd: span.end,
      gapReason: null,
    };
  });
}
