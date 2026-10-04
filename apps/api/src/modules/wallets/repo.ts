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

/**
 * Not merchant-scoped on purpose: used to enforce one ACTIVE wallet per address. An address
 * has one row per merchant that ever registered it.
 */
export function findWalletsByAddress(db: Db, address: string): Promise<Wallet[]> {
  return db.wallet.findMany({ where: { address }, orderBy: { createdAt: "asc" } });
}

/** Not merchant-scoped: open requests keep a removed wallet reserved for its owner. */
export function countOpenRequests(db: Db, walletIds: string[]): Promise<number> {
  return db.paymentRequest.count({
    where: { walletId: { in: walletIds }, status: { in: ["PENDING", "UNDERPAID"] } },
  });
}

/** Not merchant-scoped: retires another merchant's unverified claim on an address. */
export async function retireUnverified(db: Db, walletId: string): Promise<void> {
  await db.wallet.updateMany({ where: { id: walletId, verifiedAt: null }, data: { deletedAt: new Date() } });
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

