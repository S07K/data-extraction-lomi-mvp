/**
 * Carry-over: decide, per field, whether a new version's value is "unchanged"
 * relative to the base version (latest previously extracted version).
 *
 * Position-independent by design: inserting a paragraph shifts every offset in
 * the document, so offsets are never compared. A field is unchanged when
 *   (a) both versions have no value (gap → gap), or
 *   (b) same canonical value AND same whitespace-normalized evidence quote, or
 *   (c) same canonical value AND the OLD quote still appears verbatim in the NEW
 *       text — guards against the model wording the quote differently run-to-run.
 * Everything else is "changed" and goes back to the reviewer.
 */
import { containsQuote, normalizeForCompare } from "./text.js";
import { canonicalValuesEqual } from "./values.js";

export type CarryStatus = "new" | "unchanged" | "changed";

export interface ComparableValue {
  value: string | null;
  unit: string | null;
  evidence: string | null;
}

export interface CarryDecision {
  status: CarryStatus;
  /** Machine-readable explanation, useful in the UI and in tests. */
  rule: "no-base" | "both-gaps" | "gap-mismatch" | "same-quote" | "old-quote-still-present" | "evidence-changed";
}

export function decideCarryOver(
  base: ComparableValue | null,
  next: ComparableValue,
  nextDocumentText: string,
): CarryDecision {
  if (!base) return { status: "new", rule: "no-base" };

  const baseIsGap = base.value === null;
  const nextIsGap = next.value === null;
  if (baseIsGap && nextIsGap) return { status: "unchanged", rule: "both-gaps" };
  if (baseIsGap !== nextIsGap) return { status: "changed", rule: "gap-mismatch" };

  const sameValue = canonicalValuesEqual(
    { value: base.value!, unit: base.unit },
    { value: next.value!, unit: next.unit },
  );
  if (!sameValue) return { status: "changed", rule: "evidence-changed" };

  if (base.evidence && next.evidence && normalizeForCompare(base.evidence) === normalizeForCompare(next.evidence)) {
    return { status: "unchanged", rule: "same-quote" };
  }
  if (base.evidence && containsQuote(nextDocumentText, base.evidence)) {
    return { status: "unchanged", rule: "old-quote-still-present" };
  }
  return { status: "changed", rule: "evidence-changed" };
}
