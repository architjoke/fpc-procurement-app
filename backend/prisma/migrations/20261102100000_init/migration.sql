-- CreateEnum
CREATE TYPE "Role" AS ENUM ('centre_operator', 'office_manager');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('DRAFT', 'SYNCED', 'FLAGGED', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "PaymentRunStatus" AS ENUM ('DRAFT', 'APPROVED', 'EXPORTED');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SmsStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "OcrStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentRunItemStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "centre_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "centres" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "village" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "centres_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "farmers" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "village" TEXT NOT NULL,
    "land_acres" DECIMAL(65,30) NOT NULL,
    "bank_account" TEXT NOT NULL,
    "bank_ifsc" TEXT NOT NULL,
    "consent_given_at" TIMESTAMP(3) NOT NULL,
    "centre_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "farmers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crops" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,

    CONSTRAINT "crops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_board" (
    "id" TEXT NOT NULL,
    "crop_id" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "rate_per_quintal" INTEGER NOT NULL,
    "effective_date" DATE NOT NULL,
    "set_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_board_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "farmer_id" TEXT NOT NULL,
    "centre_id" TEXT NOT NULL,
    "crop_id" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "gross_kg" DECIMAL(65,30) NOT NULL,
    "tare_kg" DECIMAL(65,30) NOT NULL,
    "moisture_pct" DECIMAL(65,30) NOT NULL,
    "net_kg" DECIMAL(65,30) NOT NULL,
    "rate" INTEGER NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "status" "PurchaseStatus" NOT NULL,
    "device_signature" TEXT,
    "device_timestamp" TIMESTAMP(3),
    "ocr_confidence" DECIMAL(65,30),
    "photo_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_runs" (
    "id" TEXT NOT NULL,
    "run_date" TIMESTAMP(3) NOT NULL,
    "status" "PaymentRunStatus" NOT NULL,
    "total_amount_paise" INTEGER NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_run_items" (
    "id" TEXT NOT NULL,
    "payment_run_id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "status" "PaymentRunItemStatus" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_run_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_log" (
    "id" TEXT NOT NULL,
    "purchase_uuid" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL,
    "reason" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_trail" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_trail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_outbox" (
    "id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "message_marathi" TEXT NOT NULL,
    "status" "SmsStatus" NOT NULL,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "sms_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ocr_jobs" (
    "id" TEXT NOT NULL,
    "purchase_id" TEXT,
    "image_url" TEXT NOT NULL,
    "raw_ocr_text" TEXT,
    "parsed_weight" DECIMAL(65,30),
    "parsed_moisture" DECIMAL(65,30),
    "confidence" DECIMAL(65,30),
    "status" "OcrStatus" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ocr_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "centres_code_key" ON "centres"("code");

-- CreateIndex
CREATE UNIQUE INDEX "farmers_member_id_key" ON "farmers"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_board_crop_id_grade_effective_date_key" ON "price_board"("crop_id", "grade", "effective_date");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_uuid_key" ON "purchases"("uuid");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_centre_id_fkey" FOREIGN KEY ("centre_id") REFERENCES "centres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "farmers" ADD CONSTRAINT "farmers_centre_id_fkey" FOREIGN KEY ("centre_id") REFERENCES "centres"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_board" ADD CONSTRAINT "price_board_crop_id_fkey" FOREIGN KEY ("crop_id") REFERENCES "crops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_board" ADD CONSTRAINT "price_board_set_by_user_id_fkey" FOREIGN KEY ("set_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_farmer_id_fkey" FOREIGN KEY ("farmer_id") REFERENCES "farmers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_centre_id_fkey" FOREIGN KEY ("centre_id") REFERENCES "centres"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_crop_id_fkey" FOREIGN KEY ("crop_id") REFERENCES "crops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_runs" ADD CONSTRAINT "payment_runs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_run_items" ADD CONSTRAINT "payment_run_items_payment_run_id_fkey" FOREIGN KEY ("payment_run_id") REFERENCES "payment_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_run_items" ADD CONSTRAINT "payment_run_items_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_trail" ADD CONSTRAINT "audit_trail_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_outbox" ADD CONSTRAINT "sms_outbox_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

