/**
 * Process one version: claim → parse (once) → LLM → validate → commit.
 * Every exit path leaves Postgres in a visible state: extracted, re-queued with
 * backoff, failed with a reason, or (if we lost the lease) untouched by us.
 */
import { EXTRACTION_POLICY, ExtractionError } from "@lomi/core";
import {
  claimVersion,
  commitExtraction,
  failAttempt,
  getVersionFile,
  heartbeat,
  saveParsedText,
  type Db,
  type RunLog,
} from "@lomi/db";
import { parsePdf, PARSER_VERSION, runExtraction, type LlmProvider } from "@lomi/extraction";
import { tryEnqueueExtraction, type ExtractionQueue } from "@lomi/queue";
import { log } from "./log.js";

export interface ProcessDeps {
  db: Db;
  queue: ExtractionQueue;
  workerId: string;
  /** Lazily built so a misconfigured provider fails the version (visibly) instead of the worker. */
  getProvider: () => LlmProvider;
  providerName: string;
}

export type ProcessResult = "skipped" | "committed" | "discarded" | "requeued" | "failed";

export async function processVersion(deps: ProcessDeps, versionId: string): Promise<ProcessResult> {
  const { db, queue, workerId } = deps;
  const claim = await claimVersion(db, versionId, workerId, deps.providerName);
  if (!claim) {
    log("claim.skip", { versionId });
    return "skipped";
  }
  log("claim.ok", { versionId, attempt: claim.attempt, doc: claim.documentId, v: claim.versionNumber });

  // Keep the lease alive; if it's lost (superseded / reclaimed), abort the LLM call.
  const abort = new AbortController();
  const beat = setInterval(() => {
    heartbeat(db, claim)
      .then((alive) => {
        if (!alive) {
          log("lease.lost", { versionId });
          abort.abort();
        }
      })
      .catch((err: unknown) => log("heartbeat.error", { versionId, error: (err as Error).message }));
  }, EXTRACTION_POLICY.heartbeatMs);

  let runLog: RunLog = {};
  try {
    let text = claim.parsedText;
    if (text === null) {
      const file = await getVersionFile(db, versionId);
      if (!file) throw new ExtractionError("Version has no stored file", "permanent");
      const parsed = await parsePdf(file.bytes);
      text = await saveParsedText(db, versionId, parsed.text, PARSER_VERSION);
      log("parse.ok", { versionId, chars: text.length, pages: parsed.pages });
    }

    const provider = deps.getProvider();
    const outcome = await runExtraction(provider, claim.documentType, text, abort.signal);
    runLog = outcome.log;
    const result = await commitExtraction(db, claim, outcome.values, outcome.log);
    log(`commit.${result}`, {
      versionId,
      gaps: outcome.values.filter((v) => v.value === null).length,
      latencyMs: outcome.log.latencyMs,
      model: outcome.log.model,
    });
    return result;
  } catch (err) {
    const e =
      err instanceof ExtractionError
        ? err
        : new ExtractionError(`Unexpected error: ${(err as Error)?.message ?? String(err)}`, "transient", { cause: err });
    const partialLog = (err as { log?: RunLog }).log ?? runLog;
    const res = await failAttempt(db, claim, { message: e.message, kind: e.kind }, partialLog);
    log(`attempt.${res.kind}`, { versionId, attempt: claim.attempt, kind: e.kind, error: e.message });
    if (res.kind === "requeued") {
      await tryEnqueueExtraction(queue, versionId, res.attempt, res.delayMs);
    }
    return res.kind;
  } finally {
    clearInterval(beat);
  }
}
