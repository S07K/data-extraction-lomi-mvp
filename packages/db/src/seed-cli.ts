import { createDb } from "./client.js";
import { seedFixtures } from "./seed.js";

const fixturesDir = process.env["FIXTURES_DIR"] ?? new URL("../../../fixtures", import.meta.url).pathname;
const db = createDb();
try {
  const { created, skipped } = await seedFixtures(db, fixturesDir);
  console.warn(`[seed] created: ${created.join(", ") || "none"}; already present: ${skipped.join(", ") || "none"}`);
} finally {
  await db.$disconnect();
}
