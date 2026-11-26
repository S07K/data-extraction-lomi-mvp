/**
 * Read models for the API. Small-scale implementation: progress is computed from
 * rows on read (fine for a handful of documents; see README for the 10k plan).
 */
import { computeProgress, effectiveValue, reviewState, type Progress } from "@lomi/core";
import type { Db } from "./client.js";
import { DomainError } from "./errors.js";
import type { Prisma } from "./generated/prisma/client.js";

const reviewSelect = {
  id: true,
  action: true,
  correctedValue: true,
  note: true,
  tags: true,
  source: true,
  reviewer: true,
  createdAt: true,
  carriedFromReviewId: true,
} satisfies Prisma.ReviewSelect;

const valueInclude = {
  reviews: { orderBy: { createdAt: "desc" }, select: reviewSelect },
  previousValue: {
    include: {
      reviews: { orderBy: { createdAt: "desc" }, take: 1, select: reviewSelect },
      version: { select: { versionNumber: true } },
    },
  },
} satisfies Prisma.ExtractedValueInclude;

type ValueRow = Prisma.ExtractedValueGetPayload<{ include: typeof valueInclude }>;

const versionSummarySelect = {
  id: true,
  versionNumber: true,
  status: true,
  failureReason: true,
  attempts: true,
  createdAt: true,
  extractedAt: true,
} satisfies Prisma.DocumentVersionSelect;

function toValueView(v: ValueRow) {
  const current = v.reviews[0] ?? null;
  const prev = v.previousValue;
  const prevReview = prev?.reviews[0] ?? null;
  return {
    id: v.id,
    field: v.field,
    fieldType: v.fieldType,
    value: v.value,
    unit: v.unit,
    evidence: v.evidence,
    evidenceStart: v.evidenceStart,
    evidenceEnd: v.evidenceEnd,
    gapReason: v.gapReason,
    isGap: v.value === null,
    carryStatus: v.carryStatus,
    carryRule: v.carryRule,
    reviewState: reviewState(current),
    effectiveValue: effectiveValue(v.value, current),
    currentReview: current,
    reviewHistory: v.reviews,
    previous: prev
      ? {
          versionNumber: prev.version.versionNumber,
          value: prev.value,
          unit: prev.unit,
          evidence: prev.evidence,
          gapReason: prev.gapReason,
          effectiveValue: effectiveValue(prev.value, prevReview),
          review: prevReview,
        }
      : null,
  };
}

export type ValueView = ReturnType<typeof toValueView>;

function progressOf(values: { reviews: { action: "approved" | "corrected"; source: "human" | "carried_over"; correctedValue: string | null }[] }[]): Progress {
  return computeProgress(values.map((v) => v.reviews[0] ?? null));
}

export async function listDocuments(db: Db) {
  const docs = await db.document.findMany({
    orderBy: { createdAt: "asc" },
    include: { versions: { orderBy: { versionNumber: "desc" }, select: versionSummarySelect } },
  });
  // Values of each document's reviewable (latest extracted) version, for progress.
  const reviewableIds = docs
    .map((d) => d.versions.find((v) => v.status === "extracted")?.id)
    .filter((id): id is string => Boolean(id));
  const values = await db.extractedValue.findMany({
    where: { versionId: { in: reviewableIds } },
    select: {
      versionId: true,
      reviews: { orderBy: { createdAt: "desc" }, take: 1, select: { action: true, source: true, correctedValue: true } },
    },
  });

  return docs.map((d) => {
    const current = d.versions[0]!;
    const reviewable = d.versions.find((v) => v.status === "extracted") ?? null;
    const progress = reviewable ? progressOf(values.filter((v) => v.versionId === reviewable.id)) : null;
    return {
      id: d.id,
      type: d.type,
      title: d.title,
      createdAt: d.createdAt,
      currentVersion: current,
      reviewableVersionNumber: reviewable?.versionNumber ?? null,
      progress,
    };
  });
}

/**
 * Document detail. `currentVersion` is the latest upload (whatever its status).
 * Values come from the requested version, or by default the latest *extracted*
 * version — so while v2 extracts, the reviewer still sees and can work on v1.
 */
export async function getDocument(db: Db, documentId: string, versionNumber?: number) {
  const doc = await db.document.findUnique({
    where: { id: documentId },
    include: { versions: { orderBy: { versionNumber: "desc" }, select: versionSummarySelect } },
  });
  if (!doc) throw new DomainError("not_found", `Document ${documentId} not found`);

  const current = doc.versions[0]!;
  const reviewable = doc.versions.find((v) => v.status === "extracted") ?? null;
  const shownSummary =
    versionNumber !== undefined ? doc.versions.find((v) => v.versionNumber === versionNumber) : (reviewable ?? current);
  if (!shownSummary) throw new DomainError("not_found", `Version ${versionNumber} not found`);

  const shown = await db.documentVersion.findUniqueOrThrow({
    where: { id: shownSummary.id },
    select: {
      ...versionSummarySelect,
      parsedText: true,
      values: { include: valueInclude, orderBy: { createdAt: "asc" } },
    },
  });
  const values = shown.values.map(toValueView);

  return {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    createdAt: doc.createdAt,
    currentVersion: current,
    status: current.status,
    reviewableVersionNumber: reviewable?.versionNumber ?? null,
    versions: doc.versions,
    shownVersion: {
      id: shown.id,
      versionNumber: shown.versionNumber,
      status: shown.status,
      failureReason: shown.failureReason,
      extractedAt: shown.extractedAt,
      reviewable: reviewable?.id === shown.id,
      parsedText: shown.parsedText,
    },
    values,
    progress: shown.status === "extracted" ? progressOf(shown.values) : null,
  };
}

export async function getProgress(db: Db, documentId: string, versionNumber?: number) {
  const d = await getDocument(db, documentId, versionNumber);
  return {
    documentId,
    versionNumber: d.shownVersion.versionNumber,
    status: d.shownVersion.status,
    progress: d.progress ?? { total: 0, pending: 0, approved: 0, corrected: 0, carriedOver: 0 },
  };
}

export async function getVersionRuns(db: Db, documentId: string, versionNumber: number) {
  const v = await db.documentVersion.findUnique({
    where: { documentId_versionNumber: { documentId, versionNumber } },
    select: { runs: { orderBy: { attempt: "asc" } } },
  });
  if (!v) throw new DomainError("not_found", `Version ${versionNumber} not found`);
  return v.runs;
}

export async function findVersion(db: Db, documentId: string, versionNumber: number) {
  return db.documentVersion.findUnique({
    where: { documentId_versionNumber: { documentId, versionNumber } },
    select: { id: true },
  });
}
