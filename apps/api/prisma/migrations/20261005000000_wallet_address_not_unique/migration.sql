-- An address can now have one row per merchant that ever registered it (history stays with
-- each merchant). "One active wallet per address" is enforced in the wallet service under a
-- per-address advisory lock.
DROP INDEX "Wallet_address_key";
CREATE INDEX "Wallet_address_idx" ON "Wallet"("address");
