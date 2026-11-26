/**
 * Extraction coordination — the Postgres half. Redis/BullMQ only delivers
 * "look at version X"; every state transition is a conditional write here:
 *
 *   queued ──claim──▶ extracting ──commit──▶ extracted
 *     ▲                  │  │
 *     │   transient err  │  └─ permanent err / budget exhausted ──▶ failed ──retry──▶ queued
 *     └──────────────────┘
 *     ▲   lease expired (worker died, container restarted)
 *     └── reconciler
 *
 * A claim is a lease identified by a unique token. Heartbeats extend it; commit and
 * fail only succeed while the token still matches, so a superseded version, a stale
 * worker, or a duplicate job can never write values.
 */
import { randomUUID } from "node:crypto";
import {
  EXTRACTION_POLICY,
  decideCarryOver,
  retryDelayMs,
  type DocumentType,
  type FailureKind,
  type ValidatedValue,
} from "@lomi/core";
import { lockDocument, type Db } from "./client.js";
import type { Prisma } from "./generated/prisma/client.js";

export interface Claim {
  versionId: string;
  documentId: string;
  documentType: DocumentType;
  versionNumber: number;
  attempt: number;
  token: string;
  runId: string;
  parsedText: string | null;
}

/**
 * Atomically take the lease on a queued version. Returns null when there is nothing
 * to do (already claimed, extracted, superseded, failed, or backoff not elapsed) —
 * this is what makes duplicate/stale queue jobs harmless.
 */
export async function claimVersion(db: Db, versionId: string, workerId: string, provider: string): Promise<Claim | null> {
  const token = `${workerId}:${randomUUID()}`;
  const now = new Date();
  const claimed = await db.documentVersion.updateMany({
    where: { id: versionId, status: "queued", nextAttemptAt: { lte: now } },
    data: {
      status: "extracting",
      attempts: { increment: 1 },
      leaseOwner: token,
      leaseExpiresAt: new Date(now.getTime() + EXTRACTION_POLICY.leaseMs),
    },
  });
  if (claimed.count === 0) return null;

  const v = await db.documentVersion.findUniqueOrThrow({
    where: { id: versionId },
    include: { document: { select: { type: true } } },
  });
  const run = await db.extractionRun.create({
    data: { versionId, attempt: v.attempts, workerId, provider },
  });
  return {
    versionId,
    documentId: v.documentId,
    documentType: v.document.type,
    versionNumber: v.versionNumber,
    attempt: v.attempts,
    token,
    runId: run.id,
    parsedText: v.parsedText,
  };
}

/** Extend the lease. Returns false when the lease was lost (superseded / reclaimed) — the worker should stop. */
export async function heartbeat(db: Db, claim: Pick<Claim, "versionId" | "token">): Promise<boolean> {
  const r = await db.documentVersion.updateMany({
    where: { id: claim.versionId, status: "extracting", leaseOwner: claim.token },
    data: { leaseExpiresAt: new Date(Date.now() + EXTRACTION_POLICY.leaseMs) },
  });
  return r.count === 1;
}

/** Store parsed text once per version (first successful parse wins; later attempts reuse it). */
export async function saveParsedText(db: Db, versionId: string, text: string, parserVersion: string): Promise<string> {
  await db.documentVersion.updateMany({
    where: { id: versionId, parsedText: null },
    data: { parsedText: text, parserVersion },
  });
  const v = await db.documentVersion.findUniqueOrThrow({ where: { id: versionId }, select: { parsedText: true } });
  return v.parsedText!;
}

export interface RunLog {
  model?: string | null;
  promptVersion?: string | null;
  prompt?: unknown;
  rawResponse?: unknown;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
}

function runLogData(log: RunLog) {
  return {
    model: log.model ?? null,
    promptVersion: log.promptVersion ?? null,
    prompt: (log.prompt ?? undefined) as Prisma.InputJsonValue | undefined,
    rawResponse: (log.rawResponse ?? undefined) as Prisma.InputJsonValue | undefined,
    inputTokens: log.inputTokens ?? null,
    outputTokens: log.outputTokens ?? null,
    latencyMs: log.latencyMs ?? null,
  };
}

export type CommitOutcome = "committed" | "discarded";

/**
 * Persist validated values, compute carry-over against the base version, copy
 * reviews for unchanged evidence, and flip the version to `extracted` — all in one
 * transaction, guarded by the lease token. Either everything lands or nothing does.
 */
export async function commitExtraction(
  db: Db,
  claim: Pick<Claim, "versionId" | "documentId" | "token" | "runId">,
  values: ValidatedValue[],
  log: RunLog,
): Promise<CommitOutcome> {
  return db.$transaction(async (tx) => {
    await lockDocument(tx, claim.documentId);
    const v = await tx.documentVersion.findUniqueOrThrow({ where: { id: claim.versionId } });

    if (v.status !== "extracting" || v.leaseOwner !== claim.token) {
      // Superseded, reclaimed after lease expiry, or a duplicate run: keep the log, drop the result.
      await tx.extractionRun.update({
        where: { id: claim.runId },
        data: { ...runLogData(log), outcome: "discarded", finishedAt: new Date(), error: `Discarded: version is ${v.status}` },
      });
      return "discarded";
    }

    // Base for carry-over = latest *extracted* earlier version (superseded/failed ones are skipped).
    const base = await tx.documentVersion.findFirst({
      where: { documentId: claim.documentId, status: "extracted", versionNumber: { lt: v.versionNumber } },
      orderBy: { versionNumber: "desc" },
      include: { values: { include: { reviews: { orderBy: { createdAt: "desc" }, take: 1 } } } },
    });
    const baseByField = new Map((base?.values ?? []).map((bv) => [bv.field, bv]));
    const text = v.parsedText ?? "";

    const rows: Prisma.ExtractedValueCreateManyInput[] = [];
    const carriedReviews: Prisma.ReviewCreateManyInput[] = [];
    for (const val of values) {
      const prev = baseByField.get(val.field) ?? null;
      const decision = decideCarryOver(prev, val, text);
      const id = randomUUID();
      rows.push({
        id,
        versionId: v.id,
        runId: claim.runId,
        field: val.field,
        fieldType: val.fieldType,
        value: val.value,
        unit: val.unit,
        evidence: val.evidence,
        evidenceStart: val.evidenceStart,
        evidenceEnd: val.evidenceEnd,
        gapReason: val.gapReason,
        carryStatus: decision.status,
        carryRule: decision.rule,
        previousValueId: prev?.id ?? null,
      });
      const prevReview = prev?.reviews[0];
      if (decision.status === "unchanged" && prevReview) {
        carriedReviews.push({
          valueId: id,
          action: prevReview.action,
          correctedValue: prevReview.correctedValue,
          note: prevReview.note,
          tags: prevReview.tags,
          reviewer: prevReview.reviewer,
          source: "carried_over",
          carriedFromReviewId: prevReview.id,
        });
      }
    }

    // UNIQUE(version_id, field) is the backstop: a duplicate commit would abort this transaction.
    await tx.extractedValue.createMany({ data: rows });
    if (carriedReviews.length) await tx.review.createMany({ data: carriedReviews });

    await tx.documentVersion.update({
      where: { id: v.id },
      data: { status: "extracted", extractedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, failureReason: null },
    });
    await tx.extractionRun.update({
      where: { id: claim.runId },
      data: { ...runLogData(log), outcome: "succeeded", finishedAt: new Date() },
    });
    return "committed";
  });
}

export type FailOutcome =
  | { kind: "requeued"; delayMs: number; attempt: number }
  | { kind: "failed" }
  | { kind: "discarded" };

/** Record a failed attempt. Transient errors re-queue with backoff until the attempt budget runs out. */
export async function failAttempt(
  db: Db,
  claim: Pick<Claim, "versionId" | "documentId" | "token" | "runId">,
  error: { message: string; kind: FailureKind },
  log: RunLog = {},
): Promise<FailOutcome> {
  return db.$transaction(async (tx) => {
    await lockDocument(tx, claim.documentId);
    const v = await tx.documentVersion.findUniqueOrThrow({ where: { id: claim.versionId } });
    const finishRun = (outcome: "failed" | "discarded") =>
      tx.extractionRun.update({
        where: { id: claim.runId },
        data: { ...runLogData(log), outcome, error: error.message, finishedAt: new Date() },
      });

    if (v.status !== "extracting" || v.leaseOwner !== claim.token) {
      await finishRun("discarded");
      return { kind: "discarded" } as const;
    }
    await finishRun("failed");

    if (error.kind === "transient" && v.attempts < v.attemptLimit) {
      const delayMs = retryDelayMs(v.attempts);
      await tx.documentVersion.update({
        where: { id: v.id },
        data: {
          status: "queued",
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: new Date(Date.now() + delayMs),
          failureReason: `Attempt ${v.attempts} failed (${error.message}); retrying automatically`,
        },
      });
      return { kind: "requeued", delayMs, attempt: v.attempts } as const;
    }

    await tx.documentVersion.update({
      where: { id: v.id },
      data: {
        status: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        failureReason:
          error.kind === "transient"
            ? `Failed after ${v.attempts} attempts: ${error.message}`
            : error.message,
      },
    });
    return { kind: "failed" } as const;
  });
}

export interface ReconcileResult {
  /** Queued versions whose backoff has elapsed — (re)enqueue them; BullMQ dedupes by job id. */
  due: { versionId: string; attempts: number }[];
  requeuedExpired: string[];
  failedExpired: string[];
}

/**
 * The self-healing loop. Runs at worker startup and on an interval. Because it
 * only reads Postgres, it recovers from a Redis FLUSHALL, a crashed worker, or an
 * enqueue that failed after the upload committed.
 */
export async function reconcile(db: Db, now = new Date()): Promise<ReconcileResult> {
  const expired = await db.documentVersion.findMany({
    where: { status: "extracting", leaseExpiresAt: { lt: now } },
    select: { id: true, documentId: true, attempts: true, attemptLimit: true, leaseOwner: true },
  });

  const requeuedExpired: string[] = [];
  const failedExpired: string[] = [];
  for (const v of expired) {
    const canRetry = v.attempts < v.attemptLimit;
    const updated = await db.$transaction(async (tx) => {
      await lockDocument(tx, v.documentId);
      // Conditional on the same lease still being expired — a late heartbeat wins.
      const r = await tx.documentVersion.updateMany({
        where: { id: v.id, status: "extracting", leaseOwner: v.leaseOwner, leaseExpiresAt: { lt: now } },
        data: canRetry
          ? {
              status: "queued",
              leaseOwner: null,
              leaseExpiresAt: null,
              nextAttemptAt: now,
              failureReason: `Worker lost during attempt ${v.attempts} (lease expired); re-queued`,
            }
          : {
              status: "failed",
              leaseOwner: null,
              leaseExpiresAt: null,
              failureReason: `Worker lost during attempt ${v.attempts} (lease expired); attempt budget exhausted`,
            },
      });
      if (r.count === 1) {
        await tx.extractionRun.updateMany({
          where: { versionId: v.id, outcome: "running" },
          data: { outcome: "failed", error: "Lease expired (worker crashed or was restarted)", finishedAt: now },
        });
      }
      return r.count === 1;
    });
    if (updated) (canRetry ? requeuedExpired : failedExpired).push(v.id);
  }

  const due = await db.documentVersion.findMany({
    where: { status: "queued", nextAttemptAt: { lte: now } },
    select: { id: true, attempts: true },
    orderBy: { createdAt: "asc" },
  });
  return { due: due.map((d) => ({ versionId: d.id, attempts: d.attempts })), requeuedExpired, failedExpired };
}
