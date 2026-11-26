import { readFileSync } from "node:fs";
import { inject } from "vitest";
import type { ValidatedValue } from "@lomi/core";
import { createDb, type Db } from "../src/client.js";

export function testDb(): Db {
  return createDb(inject("databaseUrl"));
}

export async function truncateAll(db: Db) {
  await db.$executeRawUnsafe(
    `TRUNCATE reviews, extracted_values, extraction_runs, version_files, document_versions, documents CASCADE`,
  );
}

export const fixture = (name: string) =>
  readFileSync(new URL(`../../../fixtures/documents/${name}`, import.meta.url));

/** Distinct fake PDF bytes (the db layer never parses them). */
export const bytes = (s: string) => new TextEncoder().encode(s);

export function val(field: string, value: string | null, evidence: string | null, text: string, unit: string | null = null): ValidatedValue {
  const start = evidence ? text.indexOf(evidence) : -1;
  return {
    field,
    fieldType: "string",
    value,
    unit,
    evidence: value === null ? null : evidence,
    evidenceStart: value === null ? null : start,
    evidenceEnd: value === null ? null : start + (evidence?.length ?? 0),
    gapReason: value === null ? "Not found in document" : null,
  };
}
