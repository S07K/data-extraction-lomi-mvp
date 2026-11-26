import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import {
  createDocumentFieldsSchema,
  reviewRequestSchema,
  type ApiErrorBody,
  type DocumentDetail,
  type DocumentListItem,
  type ProgressResponse,
  type ReviewDto,
  type UploadResponse,
} from "@lomi/contracts";
import { EXTRACTION_POLICY } from "@lomi/core";
import {
  addVersion,
  createDocument,
  DomainError,
  findVersion,
  getDocument,
  getProgress,
  getVersionFile,
  getVersionRuns,
  listDocuments,
  retryLatestVersion,
  reviewValue,
  type Db,
} from "@lomi/db";
import { tryEnqueueExtraction, type ExtractionQueue } from "@lomi/queue";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Date → string, recursively: the shape a value has after JSON serialization. */
type Jsonify<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? Jsonify<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;

/**
 * Compile-time contract check: the read model, once serialized, must be assignable
 * to the public DTO. No runtime cost — Fastify's JSON.stringify does the Date → ISO.
 */
function wire<Dto>() {
  return <T>(value: T & (Jsonify<T> extends Dto ? unknown : never)): Dto => value as unknown as Dto;
}

export interface AppDeps {
  db: Db;
  queue: ExtractionQueue;
}

async function readUpload(req: FastifyRequest) {
  const fields: Record<string, string> = {};
  let file: { bytes: Buffer; filename: string; mimetype: string } | undefined;
  for await (const part of req.parts()) {
    if (part.type === "file") {
      if (file) throw new DomainError("invalid", "Upload exactly one file");
      file = { bytes: await part.toBuffer(), filename: part.filename, mimetype: part.mimetype };
    } else if (typeof part.value === "string") {
      fields[part.fieldname] = part.value;
    }
  }
  if (!file) throw new DomainError("invalid", 'Missing file part "file"');
  // Cheap, honest validation before we persist anything: is this actually a PDF?
  if (file.bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new DomainError("invalid", "File is not a PDF");
  }
  return { fields, file };
}

const idParams = z.object({ id: z.string().min(1) });
const versionQuery = z.object({ version: z.coerce.number().int().positive().optional() });
const versionParams = z.object({ id: z.string().min(1), n: z.coerce.number().int().positive() });

export async function buildApp({ db, queue }: AppDeps) {
  const app = Fastify({
    logger: process.env["NODE_ENV"] === "test" ? false : { level: process.env["LOG_LEVEL"] ?? "info" },
  });
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  app.setErrorHandler((err, _req, reply: FastifyReply) => {
    const send = (status: number, code: string, message: string) =>
      reply.code(status).send({ error: { code, message } } satisfies ApiErrorBody);
    if (err instanceof DomainError) {
      return send({ not_found: 404, conflict: 409, invalid: 400 }[err.code], err.code, err.message);
    }
    if (err instanceof ZodError) {
      return send(400, "invalid", err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return send(status, "invalid", (err as Error).message);
    app.log.error(err);
    return send(500, "internal", "Internal server error");
  });

  app.get("/health", async () => {
    await db.$queryRaw`SELECT 1`;
    return { ok: true };
  });

  // ---- Upload: write Postgres, ring the queue (best effort), answer immediately. ----

  app.post("/documents", async (req, reply) => {
    const { fields, file } = await readUpload(req);
    const meta = createDocumentFieldsSchema.parse(fields);
    const result = await createDocument(db, {
      type: meta.type,
      title: meta.title ?? file.filename.replace(/\.pdf$/i, ""),
      file: { bytes: file.bytes, originalName: file.filename, mimeType: file.mimetype },
    });
    await tryEnqueueExtraction(queue, result.versionId, 0);
    return reply.code(202).send(result satisfies UploadResponse);
  });

  app.post("/documents/:id/versions", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { file } = await readUpload(req);
    const result = await addVersion(db, id, {
      bytes: file.bytes,
      originalName: file.filename,
      mimeType: file.mimetype,
    });
    if (!result.deduplicated) await tryEnqueueExtraction(queue, result.versionId, 0);
    return reply.code(result.deduplicated ? 200 : 202).send(result satisfies UploadResponse);
  });

  app.post("/documents/:id/retry", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const r = await retryLatestVersion(db, id, EXTRACTION_POLICY.maxAttempts);
    await tryEnqueueExtraction(queue, r.versionId, r.attempts);
    return reply.code(202).send({ versionId: r.versionId, status: "queued" });
  });

  // ---- Reads ----

  app.get("/documents", async () => wire<DocumentListItem[]>()(await listDocuments(db)));

  app.get("/documents/:id", async (req) => {
    const { id } = idParams.parse(req.params);
    const { version } = versionQuery.parse(req.query);
    return wire<DocumentDetail>()(await getDocument(db, id, version));
  });

  app.get("/documents/:id/progress", async (req) => {
    const { id } = idParams.parse(req.params);
    const { version } = versionQuery.parse(req.query);
    return (await getProgress(db, id, version)) satisfies ProgressResponse;
  });

  app.get("/documents/:id/versions/:n/runs", async (req) => {
    const { id, n } = versionParams.parse(req.params);
    return getVersionRuns(db, id, n);
  });

  app.get("/documents/:id/versions/:n/file", async (req, reply) => {
    const { id, n } = versionParams.parse(req.params);
    const v = await findVersion(db, id, n);
    const file = v && (await getVersionFile(db, v.id));
    if (!file) throw new DomainError("not_found", `Version ${n} not found`);
    return reply
      .header("content-type", file.mimeType)
      .header("content-disposition", `inline; filename="${(file.originalName ?? `v${n}.pdf`).replace(/"/g, "")}"`)
      .send(Buffer.from(file.bytes));
  });

  // ---- Review ----

  app.post("/values/:id/review", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = reviewRequestSchema.parse(req.body);
    const review = await reviewValue(
      db,
      id,
      body.action === "approve"
        ? { action: "approve", note: body.note }
        : { action: "correct", value: body.value, note: body.note, tags: body.tags },
    );
    return reply.code(201).send(wire<ReviewDto>()(review));
  });

  return app;
}
