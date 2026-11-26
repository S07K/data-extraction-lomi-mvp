-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('invoice', 'lease', 'market_report');

-- CreateEnum
CREATE TYPE "VersionStatus" AS ENUM ('queued', 'extracting', 'extracted', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "RunOutcome" AS ENUM ('running', 'succeeded', 'failed', 'discarded');

-- CreateEnum
CREATE TYPE "CarryStatus" AS ENUM ('new', 'unchanged', 'changed');

-- CreateEnum
CREATE TYPE "ReviewAction" AS ENUM ('approved', 'corrected');

-- CreateEnum
CREATE TYPE "ReviewSource" AS ENUM ('human', 'carried_over');

-- CreateEnum
CREATE TYPE "CorrectionTag" AS ENUM ('wrong_value', 'wrong_format', 'wrong_evidence', 'should_be_gap', 'missed_field', 'other');

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" "VersionStatus" NOT NULL DEFAULT 'queued',
    "failure_reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "parsed_text" TEXT,
    "parser_version" TEXT,
    "superseded_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "extracted_at" TIMESTAMP(3),

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "version_files" (
    "version_id" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "original_name" TEXT,

    CONSTRAINT "version_files_pkey" PRIMARY KEY ("version_id")
);

-- CreateTable
CREATE TABLE "extraction_runs" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "worker_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "prompt_version" TEXT,
    "prompt" JSONB,
    "raw_response" JSONB,
    "error" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "latency_ms" INTEGER,
    "outcome" "RunOutcome" NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "extraction_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extracted_values" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "field_type" TEXT NOT NULL,
    "value" TEXT,
    "unit" TEXT,
    "evidence" TEXT,
    "evidence_start" INTEGER,
    "evidence_end" INTEGER,
    "gap_reason" TEXT,
    "carry_status" "CarryStatus" NOT NULL,
    "carry_rule" TEXT,
    "previous_value_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extracted_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "value_id" TEXT NOT NULL,
    "action" "ReviewAction" NOT NULL,
    "corrected_value" TEXT,
    "note" TEXT,
    "tags" "CorrectionTag"[],
    "source" "ReviewSource" NOT NULL DEFAULT 'human',
    "carried_from_review_id" TEXT,
    "reviewer" TEXT NOT NULL DEFAULT 'reviewer',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_versions_status_next_attempt_at_idx" ON "document_versions"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "document_versions_status_lease_expires_at_idx" ON "document_versions"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_number_key" ON "document_versions"("document_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "extraction_runs_version_id_attempt_key" ON "extraction_runs"("version_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "extracted_values_version_id_field_key" ON "extracted_values"("version_id", "field");

-- CreateIndex
CREATE INDEX "reviews_value_id_created_at_idx" ON "reviews"("value_id", "created_at");

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "version_files" ADD CONSTRAINT "version_files_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "extraction_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_previous_value_id_fkey" FOREIGN KEY ("previous_value_id") REFERENCES "extracted_values"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_value_id_fkey" FOREIGN KEY ("value_id") REFERENCES "extracted_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_carried_from_review_id_fkey" FOREIGN KEY ("carried_from_review_id") REFERENCES "reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Invariants Prisma's schema language can't express (hand-written).
-- ---------------------------------------------------------------------------

-- A value is either present (with evidence) or a gap (with a reason) — never both, never neither.
ALTER TABLE "extracted_values" ADD CONSTRAINT "value_xor_gap"
  CHECK ((value IS NULL) = (gap_reason IS NOT NULL));
ALTER TABLE "extracted_values" ADD CONSTRAINT "value_has_evidence"
  CHECK (value IS NULL OR (evidence IS NOT NULL AND evidence_start IS NOT NULL AND evidence_end IS NOT NULL));

-- A correction must carry a value; an approval must not.
ALTER TABLE "reviews" ADD CONSTRAINT "correction_has_value"
  CHECK ((action = 'corrected') = (corrected_value IS NOT NULL));

-- Supersede policy, enforced by the database: at most one version per document
-- may be queued/extracting at a time. Uploading v(N+1) must supersede v(N) in the
-- same transaction or the insert fails.
CREATE UNIQUE INDEX "one_inflight_version_per_document"
  ON "document_versions" ("document_id")
  WHERE status IN ('queued', 'extracting');
