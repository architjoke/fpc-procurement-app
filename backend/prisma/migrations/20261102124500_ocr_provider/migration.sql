ALTER TABLE "ocr_jobs" ADD COLUMN "operator_id" TEXT;

CREATE INDEX "ocr_jobs_operator_id_status_idx" ON "ocr_jobs"("operator_id", "status");

ALTER TABLE "ocr_jobs"
ADD CONSTRAINT "ocr_jobs_operator_id_fkey"
FOREIGN KEY ("operator_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
