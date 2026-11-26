-- AlterTable
ALTER TABLE "document_versions" ADD COLUMN     "attempt_limit" INTEGER NOT NULL DEFAULT 3;
