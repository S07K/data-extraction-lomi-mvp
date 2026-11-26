import { EXTRACTION_POLICY } from "@lomi/core";
import { reconcile, type Db } from "@lomi/db";
import { tryEnqueueExtraction, type ExtractionQueue } from "@lomi/queue";
import { log } from "./log.js";

/**
 * Postgres → Redis repair loop. Runs at startup and every few seconds:
 *  - extracting versions with an expired lease → re-queued (or failed when out of attempts)
 *  - queued versions whose backoff has elapsed → (re)enqueued; deterministic job ids dedupe
 * This is what makes `FLUSHALL`, a killed container, or a failed post-commit enqueue harmless.
 */
export async function reconcileOnce(db: Db, queue: ExtractionQueue) {
  const r = await reconcile(db);
  let enqueued = 0;
  for (const d of r.due) if (await tryEnqueueExtraction(queue, d.versionId, d.attempts)) enqueued++;
  if (r.requeuedExpired.length || r.failedExpired.length || r.due.length) {
    log("reconcile", {
      due: r.due.length,
      enqueued,
      requeuedExpired: r.requeuedExpired,
      failedExpired: r.failedExpired,
    });
  }
  return r;
}

export function startReconciler(db: Db, queue: ExtractionQueue, intervalMs: number = EXTRACTION_POLICY.reconcileIntervalMs) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileOnce(db, queue);
    } catch (err) {
      log("reconcile.error", { error: (err as Error).message });
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}
