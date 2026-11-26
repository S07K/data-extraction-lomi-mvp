import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDocumentType } from "@lomi/core";
import type { Db } from "./client.js";
import { createDocument } from "./documents.js";

interface ManifestEntry {
  id: string;
  type: string;
  title: string;
  versions: { version: number; file: string }[];
}

/**
 * Seed VERSION 1 of each fixture document, as `queued`. Idempotent (skips existing ids).
 * Seeded documents go through the real extraction pipeline: the worker's reconciler
 * picks them up — no special path for seed data.
 */
export async function seedFixtures(db: Db, fixturesDir: string): Promise<{ created: string[]; skipped: string[] }> {
  const manifest = JSON.parse(await readFile(join(fixturesDir, "documents.json"), "utf8")) as ManifestEntry[];
  const created: string[] = [];
  const skipped: string[] = [];
  for (const entry of manifest) {
    if (!isDocumentType(entry.type)) throw new Error(`Unknown document type in manifest: ${entry.type}`);
    if (await db.document.findUnique({ where: { id: entry.id }, select: { id: true } })) {
      skipped.push(entry.id);
      continue;
    }
    const v1 = entry.versions.find((v) => v.version === 1);
    if (!v1) throw new Error(`Manifest entry ${entry.id} has no version 1`);
    const bytes = await readFile(join(fixturesDir, v1.file));
    await createDocument(db, {
      id: entry.id,
      type: entry.type,
      title: entry.title,
      file: { bytes, originalName: v1.file.split("/").pop() ?? null },
    });
    created.push(entry.id);
  }
  return { created, skipped };
}
