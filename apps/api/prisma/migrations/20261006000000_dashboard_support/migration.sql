-- AlterTable
ALTER TABLE "ChainPayment" ADD COLUMN     "refundTxHash" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "defaultExpiryMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "defaultWalletId" TEXT,
ADD COLUMN     "supportContact" TEXT;

-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "refundTxHash" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PasswordReset" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PasswordReset_merchantId_createdAt_idx" ON "PasswordReset"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "ChainPayment_walletId_ledgerClosedAt_idx" ON "ChainPayment"("walletId", "ledgerClosedAt");

-- AddForeignKey
ALTER TABLE "PasswordReset" ADD CONSTRAINT "PasswordReset_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

