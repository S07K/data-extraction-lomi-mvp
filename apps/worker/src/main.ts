import { hostname } from "node:os";
import { Worker } from "bullmq";
import { createDb, expireOwnStaleLeases } from "@lomi/db";
import { createProvider, type LlmProvider } from "@lomi/extraction";
import { createExtractionQueue, EXTRACTION_QUEUE, redisConnection, type ExtractionJobData } from "@lomi/queue";
import { log } from "./log.js";
import { processVersion } from "./process.js";
import { startReconciler } from "./reconciler.js";

const workerId = process.env["WORKER_ID"] ?? `${hostname()}-${process.pid}`;
const concurrency = Number(process.env["WORKER_CONCURRENCY"] ?? 2);
const providerName = process.env["LLM_PROVIDER"] ?? "anthropic";

const db = createDb();
const connection = redisConnection();
const queue = createExtractionQueue(connection);

let provider: LlmProvider | undefined;
const getProvider = () => (provider ??= createProvider());

const worker = new Worker<ExtractionJobData>(
  EXTRACTION_QUEUE,
  async (job) => processVersion({ db, queue, workerId, getProvider, providerName }, job.data.versionId),
  { connection, concurrency },
);
worker.on("error", (err) => log("bullmq.error", { error: err.message }));

const expired = await expireOwnStaleLeases(db, workerId);
if (expired) log("leases.recovered", { count: expired, workerId });
const stopReconciler = startReconciler(db, queue);
log("worker.started", { workerId, concurrency, provider: providerName });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("worker.stopping", { signal });
  stopReconciler();
  // Give in-flight jobs a moment; anything unfinished is recovered via lease expiry.
  await Promise.race([worker.close(), new Promise((r) => setTimeout(r, 8_000))]);
  await Promise.allSettled([queue.close(), db.$disconnect()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
