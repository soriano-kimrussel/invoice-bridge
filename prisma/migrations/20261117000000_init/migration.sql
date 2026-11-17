-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('pending', 'processing', 'needs_review', 'approved', 'submitted', 'posted', 'mismatch', 'rejected', 'failed');

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'pending',
    "content_hash" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "extracted" JSONB,
    "extracted_at" TIMESTAMPTZ(3),
    "reviewed" JSONB,
    "reviewed_by" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(3),
    "locked_by" TEXT,
    "last_error" TEXT,
    "accounting_provider" TEXT,
    "external_id" TEXT,
    "posted_at" TIMESTAMPTZ(3),
    "reconciled_at" TIMESTAMPTZ(3),
    "reconcile_result" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_events" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_content_hash_key" ON "invoices"("content_hash");

-- CreateIndex
CREATE INDEX "invoices_status_next_attempt_at_idx" ON "invoices"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_accounting_provider_external_id_key" ON "invoices"("accounting_provider", "external_id");

-- CreateIndex
CREATE INDEX "invoice_events_invoice_id_created_at_idx" ON "invoice_events"("invoice_id", "created_at");

-- AddForeignKey
ALTER TABLE "invoice_events" ADD CONSTRAINT "invoice_events_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
