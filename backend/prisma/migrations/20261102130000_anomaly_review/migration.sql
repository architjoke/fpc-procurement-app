ALTER TYPE "PurchaseStatus" ADD VALUE 'REJECTED';

ALTER TABLE "purchases" ADD COLUMN "flag_reason" TEXT;

ALTER TABLE "ocr_jobs" ADD COLUMN "image_data" TEXT;
