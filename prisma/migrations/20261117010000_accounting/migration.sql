-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "next_post_at" TIMESTAMPTZ(3),
ADD COLUMN     "post_attempts" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "accounting_connections" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "tenant_name" TEXT,
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "access_token_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_refreshed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "accounting_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounting_connections_provider_key" ON "accounting_connections"("provider");

-- CreateIndex
CREATE INDEX "invoices_status_next_post_at_idx" ON "invoices"("status", "next_post_at");
