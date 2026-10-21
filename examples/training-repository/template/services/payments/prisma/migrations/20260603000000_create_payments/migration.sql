-- order_id points at the orders service's orders table, but not through a
-- foreign key: the two tables live in different databases.
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "provider_reference" TEXT,
    "decline_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "captured_at" TIMESTAMP(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");
