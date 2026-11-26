import { readFileSync } from "node:fs";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { addVersion, createDb, createDocument, getDocument, reconcile, reviewValue } from "@lomi/db";
import { FakeProvider, type LlmProvider } from "@lomi/extraction";
import { createExtractionQueue, EXTRACTION_QUEUE, redisConnection, tryEnqueueExtraction, type ExtractionJobData } from "@lomi/queue";
import { processVersion } from "../src/process.js";
import { reconcileOnce } from "../src/reconciler.js";

const db = createDb(inject("databaseUrl"));
const connection = redisConnection(inject("redisUrl"));
const queue = createExtractionQueue(connection);
const redis = new Redis(inject("redisUrl"));
const pdf = (name: string) => new Uint8Array(readFileSync(new URL(`../../../fixtures/documents/${name}`, import.meta.url)));

let provider: LlmProvider = new FakeProvider();
let worker: Worker<ExtractionJobData> | undefined;

function startWorker() {
  worker = new Worker<ExtractionJobData>(
    EXTRACTION_QUEUE,
    (job) => processVersion({ db, queue, workerId: "test", getProvider: () => provider, providerName: "fake" }, job.data.versionId),
    { connection, concurrency: 2 },
  );
}

async function waitForStatus(documentId: string, status: string, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const d = await getDocument(db, documentId);
    if (d.status === status) return d;
    if (Date.now() > until) throw new Error(`timeout waiting for ${status}; still ${d.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(() => startWorker());
afterAll(async () => {
  await worker?.close();
  await queue.close();
  redis.disconnect();
  await db.$disconnect();
});
beforeEach(async () => {
  provider = new FakeProvider();
  await redis.flushall();
  await db.$executeRawUnsafe(
    `TRUNCATE reviews, extracted_values, extraction_runs, version_files, document_versions, documents CASCADE`,
  );
});

async function upload(name = "invoice-001.pdf") {
  const up = await createDocument(db, { type: "invoice", title: "Invoice", file: { bytes: pdf(name) } });
  await tryEnqueueExtraction(queue, up.versionId, 0);
  return up;
}

describe("worker end to end (real BullMQ + Postgres, fake LLM)", () => {
  it("upload → queued → extracted with values, prompt and raw response logged", async () => {
    const up = await upload();
    const d = await waitForStatus(up.documentId, "extracted");
    expect(d.values).toHaveLength(5);
    const runs = await db.extractionRun.findMany({ where: { versionId: up.versionId } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "succeeded", provider: "fake" });
    expect(runs[0]!.prompt).toBeTruthy();
    expect(runs[0]!.rawResponse).toBeTruthy();
  });

  it("FLUSHALL before the job runs: nothing is lost, the reconciler re-enqueues from Postgres", async () => {
    await worker!.close();
    const up = await upload();
    await redis.flushall(); // the job is gone
    expect(await queue.getJobCounts("waiting")).toEqual({ waiting: 0 });
    expect((await getDocument(db, up.documentId)).status).toBe("queued");

    startWorker();
    await reconcileOnce(db, queue);
    await waitForStatus(up.documentId, "extracted");
  });

  it("worker dies mid-extraction (lease expires): reconciler re-queues and it completes", async () => {
    await worker!.close();
    const up = await upload();
    await redis.flushall();
    // Simulate a crashed worker: claimed, never finished, lease in the past.
    await db.documentVersion.update({
      where: { id: up.versionId },
      data: { status: "extracting", attempts: 1, leaseOwner: "dead", leaseExpiresAt: new Date(Date.now() - 1) },
    });
    startWorker();
    await reconcileOnce(db, queue);
    const d = await waitForStatus(up.documentId, "extracted");
    expect(d.versions[0]!.attempts).toBe(2);
  });

  it("LLM failure is a visible state: permanent → failed with reason", async () => {
    provider = new FakeProvider({ failWith: "permanent" });
    const up = await upload();
    const d = await waitForStatus(up.documentId, "failed");
    expect(d.currentVersion.failureReason).toMatch(/configured to fail/);
  });

  it("transient LLM failure re-queues with backoff instead of failing", async () => {
    provider = new FakeProvider({ failWith: "transient" });
    const up = await upload();
    await waitForStatus(up.documentId, "queued", 10_000).catch(() => undefined);
    for (let i = 0; i < 50; i++) {
      const v = await db.documentVersion.findUniqueOrThrow({ where: { id: up.versionId } });
      if (v.attempts === 1 && v.status === "queued") {
        expect(v.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
        expect(v.failureReason).toMatch(/retrying automatically/);
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("version was not re-queued");
  });

  it("re-extraction of the real revised invoice: exactly 2 values to re-review", async () => {
    const up = await upload();
    let d = await waitForStatus(up.documentId, "extracted");
    for (const v of d.values) await reviewValue(db, v.id, { action: "approve" });

    const v2 = await addVersion(db, up.documentId, { bytes: pdf("invoice-001.v2.pdf") });
    await tryEnqueueExtraction(queue, v2.versionId, 0);
    d = await waitForStatus(up.documentId, "extracted");
    expect(d.shownVersion.versionNumber).toBe(2);
    const needsReview = d.values.filter((v) => v.reviewState === "pending").map((v) => v.field);
    expect(needsReview.sort()).toEqual(["due_date", "total_amount"]);
    expect(d.progress).toMatchObject({ pending: 2, carriedOver: 3 });
  });

  it("v2 uploaded while v1 is extracting: v1 superseded, v2 completes", async () => {
    provider = new FakeProvider({ delayMs: 1500 });
    const up = await upload();
    await waitForStatus(up.documentId, "extracting");
    const v2 = await addVersion(db, up.documentId, { bytes: pdf("invoice-001.v2.pdf") });
    await tryEnqueueExtraction(queue, v2.versionId, 0);
    const d = await waitForStatus(up.documentId, "extracted");
    expect(d.versions.map((v) => [v.versionNumber, v.status])).toEqual([
      [2, "extracted"],
      [1, "superseded"],
    ]);
    // v1's late result was discarded, not stored.
    expect(await db.extractedValue.count({ where: { versionId: up.versionId } })).toBe(0);
    expect((await reconcile(db)).due).toEqual([]);
  });
});
