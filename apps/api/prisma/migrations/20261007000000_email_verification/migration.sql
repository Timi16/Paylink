-- Email confirmation at sign-up.
ALTER TABLE "Merchant" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
-- Accounts that already exist were created before confirmation existed: treat them as confirmed.
UPDATE "Merchant" SET "emailVerifiedAt" = "createdAt";

CREATE TABLE "EmailVerification" (
    "merchantId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerification_pkey" PRIMARY KEY ("merchantId")
);

ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
