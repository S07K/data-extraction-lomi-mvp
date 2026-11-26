/**
 * Upload paths. Each is one transaction that writes the version row + PDF bytes,
 * so a version can never exist without its file (or vice versa). Enqueueing to
 * Redis happens AFTER commit and is best-effort: if it fails, the version is still
 * `queued` in Postgres and the reconciler will enqueue it.
 */
import { createHash, randomUUID } from "node:crypto";
import type { DocumentType } from "@lomi/core";
import { lockDocument, type Db, type Tx } from "./client.js";
import { DomainError } from "./errors.js";

export interface UploadedFile {
  bytes: Uint8Array;
  originalName?: string | null;
  mimeType?: string;
}

export interface UploadResult {
  documentId: string;
  versionId: string;
  versionNumber: number;
  /** True when the same bytes were already the latest version — nothing new was created. */
  deduplicated: boolean;
  /** Versions that were still in flight and got superseded by this upload. */
  supersededVersionIds: string[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function insertVersion(tx: Tx, documentId: string, versionNumber: number, file: UploadedFile, id = randomUUID()) {
  await tx.documentVersion.create({
    data: {
      id,
      documentId,
      versionNumber,
      sha256: sha256(file.bytes),
      status: "queued",
      file: {
        create: {
          bytes: Buffer.from(file.bytes),
          mimeType: file.mimeType ?? "application/pdf",
          sizeBytes: file.bytes.byteLength,
          originalName: file.originalName ?? null,
        },
      },
    },
  });
  return id;
}

export async function createDocument(
  db: Db,
  input: { id?: string; type: DocumentType; title: string; file: UploadedFile },
): Promise<UploadResult> {
  return db.$transaction(async (tx) => {
    const doc = await tx.document.create({ data: { id: input.id, type: input.type, title: input.title } });
    const versionId = await insertVersion(tx, doc.id, 1, input.file);
    return { documentId: doc.id, versionId, versionNumber: 1, deduplicated: false, supersededVersionIds: [] };
  });
}

/**
 * New version of an existing document. Policy when the previous version is still
 * queued/extracting: SUPERSEDE — it is marked `superseded` in this same transaction
 * (a partial unique index makes this mandatory), and its worker's eventual commit
 * is rejected because its lease no longer matches.
 */
export async function addVersion(db: Db, documentId: string, file: UploadedFile): Promise<UploadResult> {
  return db.$transaction(async (tx) => {
    if (!(await lockDocument(tx, documentId))) throw new DomainError("not_found", `Document ${documentId} not found`);

    const latest = await tx.documentVersion.findFirst({
      where: { documentId },
      orderBy: { versionNumber: "desc" },
      select: { id: true, versionNumber: true, sha256: true },
    });
    const digest = sha256(file.bytes);
    if (latest && latest.sha256 === digest) {
      // Impatient double-submit of the same file: return the existing version instead of a duplicate.
      return {
        documentId,
        versionId: latest.id,
        versionNumber: latest.versionNumber,
        deduplicated: true,
        supersededVersionIds: [],
      };
    }

    const newId = randomUUID();
    const inflight = await tx.documentVersion.findMany({
      where: { documentId, status: { in: ["queued", "extracting"] } },
      select: { id: true, versionNumber: true },
    });
    if (inflight.length > 0) {
      await tx.documentVersion.updateMany({
        where: { id: { in: inflight.map((v) => v.id) } },
        data: {
          status: "superseded",
          supersededById: newId,
          leaseOwner: null,
          leaseExpiresAt: null,
          failureReason: `Superseded by version ${(latest?.versionNumber ?? 0) + 1} before extraction finished`,
        },
      });
    }

    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    await insertVersion(tx, documentId, versionNumber, file, newId);
    return { documentId, versionId: newId, versionNumber, deduplicated: false, supersededVersionIds: inflight.map((v) => v.id) };
  });
}

/** Manual retry of a failed latest version. Raises the attempt budget rather than resetting it. */
export async function retryLatestVersion(db: Db, documentId: string, maxAttempts: number) {
  return db.$transaction(async (tx) => {
    if (!(await lockDocument(tx, documentId))) throw new DomainError("not_found", `Document ${documentId} not found`);
    const latest = await tx.documentVersion.findFirst({ where: { documentId }, orderBy: { versionNumber: "desc" } });
    if (!latest) throw new DomainError("not_found", "Document has no versions");
    if (latest.status !== "failed") {
      throw new DomainError("conflict", `Only a failed version can be retried (version ${latest.versionNumber} is ${latest.status})`);
    }
    await tx.documentVersion.update({
      where: { id: latest.id },
      data: {
        status: "queued",
        attemptLimit: latest.attempts + maxAttempts,
        nextAttemptAt: new Date(),
        failureReason: null,
      },
    });
    return { versionId: latest.id, attempts: latest.attempts };
  });
}

export async function getVersionFile(db: Db, versionId: string) {
  return db.versionFile.findUnique({ where: { versionId } });
}
