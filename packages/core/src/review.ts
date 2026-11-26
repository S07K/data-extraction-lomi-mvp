/**
 * Review model (annotation style): the extracted value is immutable; reviews are
 * append-only rows beside it. The latest review is the effective one.
 */

export const REVIEW_ACTIONS = ["approved", "corrected"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export const REVIEW_SOURCES = ["human", "carried_over"] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

/** Fixed taxonomy so corrections can be aggregated into extraction evals later. */
export const CORRECTION_TAGS = [
  "wrong_value",
  "wrong_format",
  "wrong_evidence",
  "should_be_gap",
  "missed_field",
  "other",
] as const;
export type CorrectionTag = (typeof CORRECTION_TAGS)[number];

export interface ReviewLike {
  action: ReviewAction;
  source: ReviewSource;
  correctedValue: string | null;
}

export type ReviewState = "pending" | "approved" | "corrected" | "carried_over";

export function reviewState(current: ReviewLike | null): ReviewState {
  if (!current) return "pending";
  if (current.source === "carried_over") return "carried_over";
  return current.action;
}

/** What downstream consumers should treat as the value. */
export function effectiveValue(extracted: string | null, current: ReviewLike | null): string | null {
  return current?.action === "corrected" ? current.correctedValue : extracted;
}

export interface Progress {
  total: number;
  pending: number;
  approved: number;
  corrected: number;
  carriedOver: number;
}

export function computeProgress(currentReviews: readonly (ReviewLike | null)[]): Progress {
  const p: Progress = { total: currentReviews.length, pending: 0, approved: 0, corrected: 0, carriedOver: 0 };
  for (const r of currentReviews) {
    const s = reviewState(r);
    if (s === "pending") p.pending++;
    else if (s === "approved") p.approved++;
    else if (s === "corrected") p.corrected++;
    else p.carriedOver++;
  }
  return p;
}
