CREATE TABLE "device_sessions" (
    "device_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_secret_hash" TEXT NOT NULL,
    "last_accepted_timestamp" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "device_sessions_pkey" PRIMARY KEY ("device_id")
);

CREATE TABLE "sync_nonces" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_nonces_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "device_sessions_user_id_idx" ON "device_sessions"("user_id");
CREATE UNIQUE INDEX "sync_nonces_device_id_nonce_key" ON "sync_nonces"("device_id", "nonce");
CREATE INDEX "sync_nonces_expires_at_idx" ON "sync_nonces"("expires_at");

ALTER TABLE "device_sessions"
    ADD CONSTRAINT "device_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sync_nonces"
    ADD CONSTRAINT "sync_nonces_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "device_sessions"("device_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
