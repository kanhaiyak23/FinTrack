-- CreateEnum
CREATE TYPE "account_type" AS ENUM ('CHECKING', 'SAVINGS', 'BROKERAGE');

-- CreateEnum
CREATE TYPE "transaction_type" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'BUY', 'SELL');

-- CreateEnum
CREATE TYPE "transaction_status" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "plan_type" AS ENUM ('SIP', 'LUMPSUM', 'RECURRING');

-- CreateEnum
CREATE TYPE "plan_frequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY');

-- CreateEnum
CREATE TYPE "plan_status" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_type" "account_type" NOT NULL,
    "balance" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "type" "transaction_type" NOT NULL,
    "symbol" TEXT,
    "quantity" DECIMAL(20,8),
    "price" DECIMAL(20,4),
    "amount" DECIMAL(20,4) NOT NULL,
    "transaction_time" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "transaction_status" NOT NULL DEFAULT 'COMPLETED',
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investment_plans" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "plan_type" "plan_type" NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "frequency" "plan_frequency" NOT NULL,
    "status" "plan_status" NOT NULL DEFAULT 'ACTIVE',
    "start_date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "investment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "subscription_status" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "processor" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id","processor")
);

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE INDEX "idx_transactions_account_time" ON "transactions"("account_id", "transaction_time" DESC);

-- CreateIndex
CREATE INDEX "idx_transactions_account_type" ON "transactions"("account_id", "type");

-- CreateIndex
CREATE INDEX "idx_transactions_account_symbol" ON "transactions"("account_id", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "uq_transactions_account_idempotency" ON "transactions"("account_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "idx_plans_user_status" ON "investment_plans"("user_id", "status");

-- CreateIndex
CREATE INDEX "idx_subscriptions_user_status" ON "subscriptions"("user_id", "status");

-- CreateIndex
CREATE INDEX "subscriptions_plan_id_idx" ON "subscriptions"("plan_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investment_plans" ADD CONSTRAINT "investment_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "investment_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Constraints and indexes Prisma's schema language cannot express.
-- These are business rules the database enforces itself, so a bug in the
-- service layer cannot write a state that should be impossible.
-- ---------------------------------------------------------------------------

-- A balance may never go negative. The service also checks, under a row lock,
-- and returns a clean 422; this is the backstop for when the service is wrong.
ALTER TABLE "accounts"
  ADD CONSTRAINT "chk_accounts_balance_non_negative" CHECK ("balance" >= 0);

-- Amounts are always positive; direction is carried by the transaction type,
-- not by the sign. A negative DEPOSIT would otherwise be a withdrawal in disguise.
ALTER TABLE "transactions"
  ADD CONSTRAINT "chk_transactions_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "transactions"
  ADD CONSTRAINT "chk_transactions_quantity_positive"
  CHECK ("quantity" IS NULL OR "quantity" > 0);

ALTER TABLE "transactions"
  ADD CONSTRAINT "chk_transactions_price_positive"
  CHECK ("price" IS NULL OR "price" > 0);

-- Trades carry symbol/quantity/price; cash movements carry none of them. Writing
-- this as an equivalence rejects both a BUY with no symbol and a DEPOSIT with one.
ALTER TABLE "transactions"
  ADD CONSTRAINT "chk_transactions_trade_fields"
  CHECK (
    ("type" IN ('BUY', 'SELL'))
    = ("symbol" IS NOT NULL AND "quantity" IS NOT NULL AND "price" IS NOT NULL)
  );

ALTER TABLE "investment_plans"
  ADD CONSTRAINT "chk_plans_amount_positive" CHECK ("amount" > 0);

-- A cancelled subscription has an end date; an active one does not.
ALTER TABLE "subscriptions"
  ADD CONSTRAINT "chk_subscriptions_ended_at"
  CHECK (
    ("status" = 'CANCELLED' AND "ended_at" IS NOT NULL)
    OR ("status" = 'ACTIVE' AND "ended_at" IS NULL)
  );

-- One active subscription per user per plan. Partial, so the history of past
-- CANCELLED subscriptions to the same plan is still allowed to accumulate.
CREATE UNIQUE INDEX "uq_subscriptions_one_active_per_plan"
  ON "subscriptions" ("user_id", "plan_id")
  WHERE "status" = 'ACTIVE';

-- The outbox publisher only ever reads unpublished rows. A partial index keeps
-- that scan proportional to the backlog rather than to the table, which grows
-- without bound.
CREATE INDEX "idx_outbox_unpublished"
  ON "outbox_events" ("occurred_at")
  WHERE "published_at" IS NULL;
