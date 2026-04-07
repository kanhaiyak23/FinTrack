-- CreateTable
CREATE TABLE "portfolio_holdings" (
    "account_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "quantity" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "total_cost" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "realized_pnl" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "portfolio_holdings_pkey" PRIMARY KEY ("account_id","symbol")
);

-- CreateTable
CREATE TABLE "daily_user_aggregates" (
    "user_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "deposits" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "withdrawals" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "buy_value" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "sell_value" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "realized_pnl" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "transaction_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "daily_user_aggregates_pkey" PRIMARY KEY ("user_id","day")
);

-- AddForeignKey
ALTER TABLE "portfolio_holdings" ADD CONSTRAINT "portfolio_holdings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_user_aggregates" ADD CONSTRAINT "daily_user_aggregates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
