import { canonicalizeValue, type CorrectionTag, type FieldType } from "@lomi/core";
import { lockDocument, type Db } from "./client.js";
import { DomainError } from "./errors.js";

export type ReviewInput =
  | { action: "approve"; note?: string | null; reviewer?: string }
  | { action: "correct"; value: string; note?: string | null; tags?: CorrectionTag[]; reviewer?: string };

/**
 * Append a human review. Only values of the document's latest *extracted* version
 * are reviewable; older versions stay readable but frozen (their reviews are history,
 * and a new version's carry-over has already been computed from them).
 */
export async function reviewValue(db: Db, valueId: string, input: ReviewInput) {
  return db.$transaction(async (tx) => {
    const value = await tx.extractedValue.findUnique({
      where: { id: valueId },
      include: { version: { select: { id: true, documentId: true, versionNumber: true } } },
    });
    if (!value) throw new DomainError("not_found", `Value ${valueId} not found`);

    await lockDocument(tx, value.version.documentId);
    const reviewable = await tx.documentVersion.findFirst({
      where: { documentId: value.version.documentId, status: "extracted" },
      orderBy: { versionNumber: "desc" },
      select: { id: true, versionNumber: true },
    });
    if (reviewable?.id !== value.versionId) {
      throw new DomainError(
        "conflict",
        `Version ${value.version.versionNumber} is read-only; review version ${reviewable?.versionNumber ?? "?"} instead`,
      );
    }

    let correctedValue: string | null = null;
    if (input.action === "correct") {
      const c = canonicalizeValue(value.fieldType as FieldType, input.value);
      if (!c.ok) throw new DomainError("invalid", `Correction is not a valid ${value.fieldType}: ${c.reason}`);
      correctedValue = c.value.value;
    }

    return tx.review.create({
      data: {
        valueId,
        action: input.action === "approve" ? "approved" : "corrected",
        correctedValue,
        note: input.note?.trim() || null,
        tags: input.action === "correct" ? (input.tags ?? []) : [],
        reviewer: input.reviewer ?? "reviewer",
        source: "human",
      },
    });
  });
}
