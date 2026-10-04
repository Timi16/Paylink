import type { Prisma, Wallet } from "@prisma/client";
import type { Db } from "../../db/prisma";

// Every function takes merchantId first and includes it in the where.

export function listWallets(db: Db, merchantId: string): Promise<Wallet[]> {
  return db.wallet.findMany({
    where: { merchantId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
}

export function findWallet(db: Db, merchantId: string, id: string): Promise<Wallet | null> {
  return db.wallet.findFirst({ where: { id, merchantId, deletedAt: null } });
}

/** Not merchant-scoped on purpose: used to enforce one-wallet-one-merchant. */
export function findWalletByAddress(db: Db, address: string): Promise<Wallet | null> {
  return db.wallet.findUnique({ where: { address } });
}

export function createWallet(
  db: Db,
  merchantId: string,
  data: { address: string; label: string | null },
): Promise<Wallet> {
  return db.wallet.create({ data: { merchantId, ...data } });
}

export async function updateWallet(
  db: Db,
  merchantId: string,
  id: string,
  data: Prisma.WalletUpdateManyMutationInput,
): Promise<Wallet | null> {
  await db.wallet.updateMany({ where: { id, merchantId }, data });
  return db.wallet.findFirst({ where: { id, merchantId } });
}
