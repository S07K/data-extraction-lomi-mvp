import { CORRECTION_TAGS, DOCUMENT_TYPES, type CarryStatus, type DocumentType, type Progress, type ReviewState, type VersionStatus } from "@lomi/core";
import { z } from "zod";

// ---------- Requests ----------

export const createDocumentFieldsSchema = z.object({
  type: z.enum(DOCUMENT_TYPES),
  title: z.string().trim().min(1).max(200).optional(),
});

export const reviewRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), note: z.string().max(2000).optional() }),
  z.object({
    action: z.literal("correct"),
    value: z.string().trim().min(1, "A correction needs a value"),
    note: z.string().max(2000).optional(),
    tags: z.array(z.enum(CORRECTION_TAGS)).max(CORRECTION_TAGS.length).optional(),
  }),
]);
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

// ---------- Responses (dates are ISO strings on the wire) ----------

export interface VersionSummary {
  id: string;
  versionNumber: number;
  status: VersionStatus;
  failureReason: string | null;
  attempts: number;
  createdAt: string;
  extractedAt: string | null;
}

export interface ReviewDto {
  id: string;
  action: "approved" | "corrected";
  correctedValue: string | null;
  note: string | null;
  tags: string[];
  source: "human" | "carried_over";
  reviewer: string;
  createdAt: string;
  carriedFromReviewId: string | null;
}

export interface ValueDto {
  id: string;
  field: string;
  fieldType: string;
  value: string | null;
  unit: string | null;
  evidence: string | null;
  evidenceStart: number | null;
  evidenceEnd: number | null;
  gapReason: string | null;
  isGap: boolean;
  carryStatus: CarryStatus;
  carryRule: string | null;
  reviewState: ReviewState;
  effectiveValue: string | null;
  currentReview: ReviewDto | null;
  reviewHistory: ReviewDto[];
  previous: {
    versionNumber: number;
    value: string | null;
    unit: string | null;
    evidence: string | null;
    gapReason: string | null;
    effectiveValue: string | null;
    review: ReviewDto | null;
  } | null;
}

export interface DocumentListItem {
  id: string;
  type: DocumentType;
  title: string;
  createdAt: string;
  currentVersion: VersionSummary;
  reviewableVersionNumber: number | null;
  progress: Progress | null;
}

export interface DocumentDetail {
  id: string;
  type: DocumentType;
  title: string;
  createdAt: string;
  /** Latest uploaded version — its status is the document's status. */
  currentVersion: VersionSummary;
  status: VersionStatus;
  reviewableVersionNumber: number | null;
  versions: VersionSummary[];
  /** The version whose values are returned (default: latest extracted). */
  shownVersion: {
    id: string;
    versionNumber: number;
    status: VersionStatus;
    failureReason: string | null;
    extractedAt: string | null;
    reviewable: boolean;
    parsedText: string | null;
  };
  values: ValueDto[];
  progress: Progress | null;
}

export interface ProgressResponse {
  documentId: string;
  versionNumber: number;
  status: VersionStatus;
  progress: Progress;
}

export interface UploadResponse {
  documentId: string;
  versionId: string;
  versionNumber: number;
  deduplicated: boolean;
  supersededVersionIds: string[];
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export type { CarryStatus, DocumentType, Progress, ReviewState, VersionStatus };
export { CORRECTION_TAGS, DOCUMENT_TYPES };
