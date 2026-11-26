import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  addVersion,
  claimVersion,
  commitExtraction,
  createDocument,
  failAttempt,
  getDocument,
  reconcile,
  retryLatestVersion,
  reviewValue,
  saveParsedText,
  type Claim,
} from "../src/index.js";
import { DomainError } from "../src/errors.js";
import { bytes, testDb, truncateAll, val } from "./helpers.js";

const db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => truncateAll(db));

const V1_TEXT = `INVOICE
Invoice Number: INV-1
Issue Date: 2025-09-14
Due Date: 2025-10-14
Total Due: $5,230.29`;

// v2 inserts a line at the top (every offset shifts) and changes two fields.
const V2_TEXT = `INVOICE (REVISED)
Note: supersedes the version issued on 2025-09-14.
Invoice Number: INV-1
Issue Date: 2025-09-14
Due Date: 2025-11-13
Total Due: $6,126.45`;

function invoiceValues(text: string, due: string, total: string) {
  return [
    val("invoice_number", "INV-1", "Invoice Number: INV-1", text),
    val("issue_date", "2025-09-14", "Issue Date: 2025-09-14", text),
    val("due_date", due, `Due Date: ${due}`, text),
    val("vendor_name", null, null, text),
    val("total_amount", total, `Total Due: $${Number(total).toLocaleString("en-US", { minimumFractionDigits: 2 })}`, text),
  ];
}

async function newDoc(content = "v1") {
  return createDocument(db, { type: "invoice", title: "Test invoice", file: { bytes: bytes(content) } });
}

async function extract(versionId: string, text: string, values: ReturnType<typeof invoiceValues>, worker = "w1") {
  const claim = await claimVersion(db, versionId, worker, "fake");
  if (!claim) throw new Error("claim failed");
  await saveParsedText(db, versionId, text, "test");
  const outcome = await commitExtraction(db, claim, values, { rawResponse: { ok: true } });
  return { claim, outcome };
}

const expireLease = (versionId: string) =>
  db.documentVersion.update({ where: { id: versionId }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });

describe("upload + claim", () => {
  it("an upload is queued and visible to the reconciler (covers a lost enqueue / FLUSHALL)", async () => {
    const up = await newDoc();
    const r = await reconcile(db);
    expect(r.due.map((d) => d.versionId)).toEqual([up.versionId]);
  });

  it("only one of many concurrent claims wins", async () => {
    const up = await newDoc();
    const claims = await Promise.all([1, 2, 3, 4, 5].map((i) => claimVersion(db, up.versionId, `w${i}`, "fake")));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("re-uploading identical bytes returns the existing version instead of a duplicate", async () => {
    const up = await newDoc("same");
    const again = await addVersion(db, up.documentId, { bytes: bytes("same") });
    expect(again).toMatchObject({ deduplicated: true, versionId: up.versionId, versionNumber: 1 });
  });
});

describe("idempotency", () => {
  it("extracting the same version twice never duplicates values", async () => {
    const up = await newDoc();
    const { claim, outcome } = await extract(up.versionId, V1_TEXT, invoiceValues(V1_TEXT, "2025-10-14", "5230.29"));
    expect(outcome).toBe("committed");

    // A duplicate job / retry of the same claim: rejected by the status+lease guard.
    const again = await commitExtraction(db, claim, invoiceValues(V1_TEXT, "2025-10-14", "5230.29"), {});
    expect(again).toBe("discarded");
    // A fresh claim on an extracted version is impossible.
    expect(await claimVersion(db, up.versionId, "w2", "fake")).toBeNull();

    expect(await db.extractedValue.count({ where: { versionId: up.versionId } })).toBe(5);
  });

  it("a worker whose lease was reclaimed cannot commit (crash-recovery race)", async () => {
    const up = await newDoc();
    const slow = (await claimVersion(db, up.versionId, "slow", "fake")) as Claim;
    await expireLease(up.versionId);
    await reconcile(db); // re-queues it
    const { outcome } = await extract(up.versionId, V1_TEXT, invoiceValues(V1_TEXT, "2025-10-14", "5230.29"), "fast");
    expect(outcome).toBe("committed");

    expect(await commitExtraction(db, slow, invoiceValues(V1_TEXT, "2025-10-14", "5230.29"), {})).toBe("discarded");
    expect(await db.extractedValue.count({ where: { versionId: up.versionId } })).toBe(5);
    const runs = await db.extractionRun.findMany({ where: { versionId: up.versionId }, orderBy: { attempt: "asc" } });
    expect(runs.map((r) => r.outcome)).toEqual(["discarded", "succeeded"]);
  });
});

describe("failure is a state", () => {
  it("expired lease → re-queued; after the attempt budget → failed (never stuck in extracting)", async () => {
    const up = await newDoc();
    for (let i = 1; i <= 3; i++) {
      expect(await claimVersion(db, up.versionId, "w", "fake")).not.toBeNull();
      await expireLease(up.versionId);
      const r = await reconcile(db);
      if (i < 3) expect(r.requeuedExpired).toEqual([up.versionId]);
      else expect(r.failedExpired).toEqual([up.versionId]);
    }
    const v = await db.documentVersion.findUniqueOrThrow({ where: { id: up.versionId } });
    expect(v.status).toBe("failed");
    expect(v.failureReason).toMatch(/lease expired/);
  });

  it("transient errors re-queue with backoff; permanent errors fail; manual retry re-queues", async () => {
    const up = await newDoc();
    const c1 = (await claimVersion(db, up.versionId, "w", "fake"))!;
    const r1 = await failAttempt(db, c1, { message: "429 rate limited", kind: "transient" });
    expect(r1).toMatchObject({ kind: "requeued", attempt: 1 });
    // Backoff is durable: not claimable until next_attempt_at.
    expect(await claimVersion(db, up.versionId, "w", "fake")).toBeNull();
    await db.documentVersion.update({ where: { id: up.versionId }, data: { nextAttemptAt: new Date() } });

    const c2 = (await claimVersion(db, up.versionId, "w", "fake"))!;
    expect(await failAttempt(db, c2, { message: "PDF has no text layer", kind: "permanent" })).toEqual({ kind: "failed" });
    let v = await db.documentVersion.findUniqueOrThrow({ where: { id: up.versionId } });
    expect(v).toMatchObject({ status: "failed", failureReason: "PDF has no text layer" });

    await retryLatestVersion(db, up.documentId, 3);
    v = await db.documentVersion.findUniqueOrThrow({ where: { id: up.versionId } });
    expect(v).toMatchObject({ status: "queued", attempts: 2, attemptLimit: 5, failureReason: null });
    expect(await claimVersion(db, up.versionId, "w", "fake")).toMatchObject({ attempt: 3 });
  });

  it("retry is rejected unless the latest version failed", async () => {
    const up = await newDoc();
    await expect(retryLatestVersion(db, up.documentId, 3)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("supersede: a new version arrives while the previous one is extracting", () => {
  it("supersedes the in-flight version and discards its late result", async () => {
    const up = await newDoc();
    const c1 = (await claimVersion(db, up.versionId, "w1", "fake"))!;

    const v2 = await addVersion(db, up.documentId, { bytes: bytes("v2") });
    expect(v2.supersededVersionIds).toEqual([up.versionId]);

    await saveParsedText(db, up.versionId, V1_TEXT, "test");
    expect(await commitExtraction(db, c1, invoiceValues(V1_TEXT, "2025-10-14", "5230.29"), {})).toBe("discarded");

    const { outcome } = await extract(v2.versionId, V2_TEXT, invoiceValues(V2_TEXT, "2025-11-13", "6126.45"));
    expect(outcome).toBe("committed");
    const detail = await getDocument(db, up.documentId);
    expect(detail.versions.map((v) => [v.versionNumber, v.status])).toEqual([
      [2, "extracted"],
      [1, "superseded"],
    ]);
    // No extracted base existed, so nothing is carried.
    expect(detail.values.every((v) => v.carryStatus === "new")).toBe(true);
  });

  it("the database refuses two in-flight versions for one document", async () => {
    const up = await newDoc();
    await expect(
      db.documentVersion.create({
        data: { documentId: up.documentId, versionNumber: 2, sha256: "x", status: "queued" },
      }),
    ).rejects.toThrow();
  });
});

describe("re-extraction carry-over", () => {
  async function reviewedV1() {
    const up = await newDoc();
    await extract(up.versionId, V1_TEXT, invoiceValues(V1_TEXT, "2025-10-14", "5230.29"));
    const d = await getDocument(db, up.documentId);
    const byField = Object.fromEntries(d.values.map((v) => [v.field, v]));
    await reviewValue(db, byField.invoice_number!.id, { action: "approve" });
    await reviewValue(db, byField.issue_date!.id, { action: "correct", value: "2025-09-15", note: "typo", tags: ["wrong_value"] });
    await reviewValue(db, byField.due_date!.id, { action: "approve" });
    await reviewValue(db, byField.vendor_name!.id, { action: "approve" }); // gap confirmed absent
    await reviewValue(db, byField.total_amount!.id, { action: "approve" });
    return up;
  }

  it("carries reviews for unchanged evidence and sends exactly the changed values back to pending", async () => {
    const up = await reviewedV1();
    const v2 = await addVersion(db, up.documentId, { bytes: bytes("v2") });
    await extract(v2.versionId, V2_TEXT, invoiceValues(V2_TEXT, "2025-11-13", "6126.45"));

    const d = await getDocument(db, up.documentId);
    expect(d.shownVersion).toMatchObject({ versionNumber: 2, reviewable: true });
    const byField = Object.fromEntries(d.values.map((v) => [v.field, v]));

    expect(byField.invoice_number).toMatchObject({ carryStatus: "unchanged", reviewState: "carried_over" });
    expect(byField.vendor_name).toMatchObject({ carryStatus: "unchanged", reviewState: "carried_over" });
    // A carried correction keeps its corrected value and note.
    expect(byField.issue_date).toMatchObject({ carryStatus: "unchanged", reviewState: "carried_over", effectiveValue: "2025-09-15" });
    expect(byField.issue_date!.currentReview).toMatchObject({ action: "corrected", note: "typo", tags: ["wrong_value"] });

    for (const f of ["due_date", "total_amount"]) {
      expect(byField[f]).toMatchObject({ carryStatus: "changed", reviewState: "pending" });
      expect(byField[f]!.previous).toMatchObject({ versionNumber: 1, review: { action: "approved" } });
    }
    expect(byField.due_date!.previous!.value).toBe("2025-10-14");
    expect(d.progress).toEqual({ total: 5, pending: 2, approved: 0, corrected: 0, carriedOver: 3 });

    // Nothing from v1 was lost.
    const old = await getDocument(db, up.documentId, 1);
    expect(old.shownVersion.reviewable).toBe(false);
    expect(old.progress).toEqual({ total: 5, pending: 0, approved: 4, corrected: 1, carriedOver: 0 });
  });

  it("old versions are read-only for review", async () => {
    const up = await reviewedV1();
    const v1Value = (await getDocument(db, up.documentId, 1)).values[0]!;
    const v2 = await addVersion(db, up.documentId, { bytes: bytes("v2") });
    await extract(v2.versionId, V2_TEXT, invoiceValues(V2_TEXT, "2025-11-13", "6126.45"));
    await expect(reviewValue(db, v1Value.id, { action: "approve" })).rejects.toBeInstanceOf(DomainError);
  });

  it("v1 stays reviewable while v2 extracts, and those late reviews are carried", async () => {
    const up = await newDoc();
    await extract(up.versionId, V1_TEXT, invoiceValues(V1_TEXT, "2025-10-14", "5230.29"));
    const v2 = await addVersion(db, up.documentId, { bytes: bytes("v2") });
    const claim = (await claimVersion(db, v2.versionId, "w", "fake"))!;

    const during = await getDocument(db, up.documentId);
    expect(during.status).toBe("extracting");
    expect(during.shownVersion).toMatchObject({ versionNumber: 1, reviewable: true });
    await reviewValue(db, during.values.find((v) => v.field === "invoice_number")!.id, { action: "approve" });

    await saveParsedText(db, v2.versionId, V2_TEXT, "test");
    await commitExtraction(db, claim, invoiceValues(V2_TEXT, "2025-11-13", "6126.45"), {});
    const after = await getDocument(db, up.documentId);
    expect(after.values.find((v) => v.field === "invoice_number")!.reviewState).toBe("carried_over");
  });

  it("rejects a correction that isn't valid for the field type", async () => {
    const up = await newDoc();
    await extract(up.versionId, V1_TEXT, invoiceValues(V1_TEXT, "2025-10-14", "5230.29"));
    const d = await getDocument(db, up.documentId);
    const due = d.values.find((v) => v.field === "due_date")!;
    await db.extractedValue.update({ where: { id: due.id }, data: { fieldType: "date" } });
    await expect(reviewValue(db, due.id, { action: "correct", value: "next tuesday" })).rejects.toMatchObject({ code: "invalid" });
  });
});
