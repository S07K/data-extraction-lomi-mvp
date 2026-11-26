import { createDb } from "@lomi/db";
import { createExtractionQueue, redisConnection } from "@lomi/queue";
import { buildApp } from "./app.js";

const db = createDb();
const queue = createExtractionQueue(redisConnection());
const app = await buildApp({ db, queue });

const port = Number(process.env["PORT"] ?? 4000);
await app.listen({ host: "0.0.0.0", port });

async function shutdown() {
  await app.close();
  await Promise.allSettled([queue.close(), db.$disconnect()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
