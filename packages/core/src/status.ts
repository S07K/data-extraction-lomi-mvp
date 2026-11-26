/** Version lifecycle and extraction-coordination policy. */

export const VERSION_STATUSES = ["queued", "extracting", "extracted", "failed", "superseded"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

/** Statuses in which a version still needs (or is getting) work. */
export const IN_FLIGHT_STATUSES = ["queued", "extracting"] as const satisfies readonly VersionStatus[];

export const EXTRACTION_POLICY = {
  /** Attempts (claims) per version before it is parked as `failed`. */
  maxAttempts: 3,
  /** A claim is valid this long without a heartbeat; after that the reconciler reclaims it. */
  leaseMs: 60_000,
  heartbeatMs: 15_000,
  reconcileIntervalMs: 15_000,
  /** Backoff before re-queueing after a transient error: base * 2^(attempt-1). */
  retryBaseDelayMs: 5_000,
} as const;

/**
 * Errors are classified so a failure is always a *state*:
 *  - transient: worth retrying automatically (rate limits, timeouts, 5xx, network)
 *  - permanent: retrying the same input won't help (unparseable PDF, missing credentials)
 */
export type FailureKind = "transient" | "permanent";

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ExtractionError";
  }
}

export function retryDelayMs(attempt: number): number {
  return EXTRACTION_POLICY.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1);
}
