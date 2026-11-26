import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export type Db = PrismaClient;
/** The client handed to an interactive transaction callback. */
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

export function createDb(connectionString = process.env["DATABASE_URL"]): Db {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * Serialize all writes that touch one document (upload, commit, review) by locking
 * its row. Cheap, and it makes "carry-over reads the base version's reviews" and
 * "a review lands on a still-reviewable version" race-free.
 */
export async function lockDocument(tx: Tx, documentId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM documents WHERE id = ${documentId} FOR UPDATE`;
  return rows.length === 1;
}
