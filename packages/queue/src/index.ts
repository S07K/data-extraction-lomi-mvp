/**
 * The Redis side of extraction. A job carries ONLY a version id: it is a doorbell,
 * not a record. Losing every job (FLUSHALL) loses nothing — Postgres holds the
 * state and the worker's reconciler re-rings the bell for anything still queued.
 */
import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";

export const EXTRACTION_QUEUE = "extraction";

export interface ExtractionJobData {
  versionId: string;
}

export function redisConnection(url = process.env["REDIS_URL"] ?? "redis://localhost:6379"): ConnectionOptions {
  // maxRetriesPerRequest: null is required for BullMQ workers' blocking commands.
  return { url, maxRetriesPerRequest: null };
}

/**
 * Deterministic id per (version, attempt): BullMQ ignores an add whose id already
 * exists, so the API, the worker's retry path, and the reconciler can all enqueue
 * the same attempt without creating duplicate jobs. Completed/failed jobs are
 * removed so the id is free again if the reconciler needs to re-ring.
 */
export function extractionJobId(versionId: string, attempts: number): string {
  return `v_${versionId}_a${attempts}`;
}

const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 1, // retries are decided in Postgres (attempt budget + backoff), not by BullMQ
  removeOnComplete: true,
  removeOnFail: true,
};

export function createExtractionQueue(connection: ConnectionOptions = redisConnection()) {
  return new Queue<ExtractionJobData>(EXTRACTION_QUEUE, { connection });
}

export type ExtractionQueue = ReturnType<typeof createExtractionQueue>;

export async function enqueueExtraction(
  queue: ExtractionQueue,
  versionId: string,
  attempts: number,
  delayMs = 0,
): Promise<void> {
  await queue.add("extract", { versionId }, { ...DEFAULT_JOB_OPTS, jobId: extractionJobId(versionId, attempts), delay: delayMs });
}

/**
 * Best-effort enqueue used right after a Postgres commit. If Redis is down the
 * version simply stays `queued` and the reconciler picks it up — so we log, never throw.
 */
export async function tryEnqueueExtraction(
  queue: ExtractionQueue,
  versionId: string,
  attempts: number,
  delayMs = 0,
): Promise<boolean> {
  try {
    await enqueueExtraction(queue, versionId, attempts, delayMs);
    return true;
  } catch (err) {
    console.warn(`[queue] enqueue failed for ${versionId}; reconciler will retry:`, (err as Error).message);
    return false;
  }
}
