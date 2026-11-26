import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { claimVersion, commitExtraction, createDb, saveParsedText, type ValidatedValue } from "@lomi/db";
import { createExtractionQueue, redisConnection } from "@lomi/queue";
import type { DocumentDetail, UploadResponse } from "@lomi/contracts";
import { buildApp } from "../src/app.js";

process.env["NODE_ENV"] = "test";
const db = createDb(inject("databaseUrl"));
const queue = createExtractionQueue(redisConnection(inject("redisUrl")));
const app = await buildApp({ db, queue });
const pdf = (name: string) => readFileSync(new URL(`../../../fixtures/documents/${name}`, import.meta.url));

function multipart(fields: Record<string, string>, file?: { name: string; bytes: Buffer }) {
  const boundary = "----lomitest";
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/pdf\r\n\r\n`),
      file.bytes,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function upload(type = "invoice", name = "invoice-001.pdf") {
  const res = await app.inject({ method: "POST", url: "/documents", ...multipart({ type }, { name, bytes: pdf(name) }) });
  return { res, body: res.json() as UploadResponse };
}

/** Stand-in for the worker: mark a version extracted with given values. */
async function extract(versionId: string, values: ValidatedValue[]) {
  const claim = (await claimVersion(db, versionId, "t", "fake"))!;
  await saveParsedText(db, versionId, "Invoice Number: INV-1\nDue Date: 2025-10-14", "t");
  await commitExtraction(db, claim, values, {});
}
const v = (field: string, value: string | null, evidence: string | null, fieldType = "string"): ValidatedValue => ({
  field,
  fieldType: fieldType as ValidatedValue["fieldType"],
  value,
  unit: null,
  evidence,
  evidenceStart: value ? 0 : null,
  evidenceEnd: value ? evidence!.length : null,
  gapReason: value ? null : "Not stated",
});

afterAll(async () => {
  await app.close();
  await queue.close();
  await db.$disconnect();
});
beforeEach(() =>
  db.$executeRawUnsafe(`TRUNCATE reviews, extracted_values, extraction_runs, version_files, document_versions, documents CASCADE`),
);

describe("POST /documents", () => {
  it("responds 202 immediately with a queued document (no LLM in the request path)", async () => {
    const t0 = Date.now();
    const { res, body } = await upload();
    expect(res.statusCode).toBe(202);
    expect(Date.now() - t0).toBeLessThan(1000);
    const doc = (await app.inject({ url: `/documents/${body.documentId}` })).json() as DocumentDetail;
    expect(doc).toMatchObject({ status: "queued", title: "invoice-001", currentVersion: { versionNumber: 1 } });
    expect(doc.values).toEqual([]);
  });

  it("still accepts uploads when Redis is unreachable — the reconciler enqueues later", async () => {
    const deadQueue = createExtractionQueue(redisConnection("redis://127.0.0.1:1"));
    deadQueue.on("error", () => undefined);
    const offline = await buildApp({ db, queue: deadQueue });
    const t0 = Date.now();
    const res = await offline.inject({ method: "POST", url: "/documents", ...multipart({ type: "lease" }, { name: "l.pdf", bytes: pdf("lease-excerpt-001.pdf") }) });
    expect(res.statusCode).toBe(202);
    expect(Date.now() - t0).toBeLessThan(3000);
    const stored = await db.documentVersion.findFirstOrThrow({ where: { documentId: (res.json() as UploadResponse).documentId } });
    expect(stored.status).toBe("queued");
    await offline.close();
    await deadQueue.close().catch(() => undefined);
  });

  it("rejects non-PDFs, unknown types and missing files with 400", async () => {
    const notPdf = await app.inject({ method: "POST", url: "/documents", ...multipart({ type: "invoice" }, { name: "x.pdf", bytes: Buffer.from("hello") }) });
    expect(notPdf.statusCode).toBe(400);
    expect(notPdf.json().error.message).toMatch(/not a PDF/);
    const badType = await app.inject({ method: "POST", url: "/documents", ...multipart({ type: "receipt" }, { name: "i.pdf", bytes: pdf("invoice-001.pdf") }) });
    expect(badType.statusCode).toBe(400);
    const noFile = await app.inject({ method: "POST", url: "/documents", ...multipart({ type: "invoice" }) });
    expect(noFile.statusCode).toBe(400);
  });
});

describe("POST /documents/:id/versions", () => {
  it("creates v2 (202), dedupes identical re-uploads (200), 404s unknown documents", async () => {
    const { body } = await upload();
    const v2 = await app.inject({ method: "POST", url: `/documents/${body.documentId}/versions`, ...multipart({}, { name: "v2.pdf", bytes: pdf("invoice-001.v2.pdf") }) });
    expect(v2.statusCode).toBe(202);
    expect(v2.json()).toMatchObject({ versionNumber: 2, supersededVersionIds: [body.versionId] });
    const again = await app.inject({ method: "POST", url: `/documents/${body.documentId}/versions`, ...multipart({}, { name: "v2.pdf", bytes: pdf("invoice-001.v2.pdf") }) });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ versionNumber: 2, deduplicated: true });
    const missing = await app.inject({ method: "POST", url: `/documents/nope/versions`, ...multipart({}, { name: "v.pdf", bytes: pdf("invoice-001.pdf") }) });
    expect(missing.statusCode).toBe(404);
  });
});

describe("review + progress", () => {
  it("approve, correct (with tags), validation errors, progress counts", async () => {
    const { body } = await upload();
    await extract(body.versionId, [
      v("invoice_number", "INV-1", "Invoice Number: INV-1"),
      v("due_date", "2025-10-14", "Due Date: 2025-10-14", "date"),
      v("vendor_name", null, null),
    ]);
    const doc = (await app.inject({ url: `/documents/${body.documentId}` })).json() as DocumentDetail;
    const byField = (f: string) => doc.values.find((x) => x.field === f)!;
    const [inv, due, vendor] = [byField("invoice_number"), byField("due_date"), byField("vendor_name")];

    expect((await app.inject({ method: "POST", url: `/values/${inv!.id}/review`, payload: { action: "approve" } })).statusCode).toBe(201);

    const badDate = await app.inject({ method: "POST", url: `/values/${due!.id}/review`, payload: { action: "correct", value: "someday" } });
    expect(badDate.statusCode).toBe(400);
    const noValue = await app.inject({ method: "POST", url: `/values/${due!.id}/review`, payload: { action: "correct" } });
    expect(noValue.statusCode).toBe(400);
    const badTag = await app.inject({ method: "POST", url: `/values/${due!.id}/review`, payload: { action: "correct", value: "2025-10-15", tags: ["vibes"] } });
    expect(badTag.statusCode).toBe(400);

    const corrected = await app.inject({
      method: "POST",
      url: `/values/${due!.id}/review`,
      payload: { action: "correct", value: "October 15, 2025", note: "typo on invoice", tags: ["wrong_value"] },
    });
    expect(corrected.statusCode).toBe(201);
    expect(corrected.json()).toMatchObject({ action: "corrected", correctedValue: "2025-10-15", tags: ["wrong_value"], source: "human" });

    const progress = (await app.inject({ url: `/documents/${body.documentId}/progress` })).json();
    expect(progress).toMatchObject({ versionNumber: 1, status: "extracted", progress: { total: 3, pending: 1, approved: 1, corrected: 1, carriedOver: 0 } });

    const after = (await app.inject({ url: `/documents/${body.documentId}` })).json() as DocumentDetail;
    const dueAfter = after.values.find((x) => x.field === "due_date")!;
    expect(dueAfter).toMatchObject({ value: "2025-10-14", effectiveValue: "2025-10-15", reviewState: "corrected" });
    expect(after.values.find((x) => x.id === vendor!.id)).toMatchObject({ isGap: true, gapReason: "Not stated" });
  });

  it("404 for unknown value / document; 409 for retry of a non-failed version", async () => {
    expect((await app.inject({ method: "POST", url: `/values/nope/review`, payload: { action: "approve" } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/documents/nope` })).statusCode).toBe(404);
    const { body } = await upload();
    expect((await app.inject({ method: "POST", url: `/documents/${body.documentId}/retry` })).statusCode).toBe(409);
  });

  it("serves the original PDF per version", async () => {
    const { body } = await upload();
    const res = await app.inject({ url: `/documents/${body.documentId}/versions/1/file` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
