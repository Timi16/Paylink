import type { Merchant } from "@prisma/client";
import type { Db } from "../../db/prisma";

export function findMerchantByEmail(db: Db, email: string): Promise<Merchant | null> {
  return db.merchant.findUnique({ where: { email } });
}

export function findMerchant(db: Db, merchantId: string): Promise<Merchant | null> {
  return db.merchant.findUnique({ where: { id: merchantId } });
}

export function createMerchant(
  db: Db,
  data: { email: string; passwordHash: string; businessName: string },
): Promise<Merchant> {
  return db.merchant.create({ data });
}

export async function createSession(
  db: Db,
  merchantId: string,
  data: { id: string; expiresAt: Date; ip: string | null; userAgent: string | null },
): Promise<void> {
  await db.session.create({ data: { merchantId, ...data } });
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.session.deleteMany({ where: { id: sessionId } });
}

export async function deleteOtherSessions(db: Db, merchantId: string, keepId: string): Promise<void> {
  await db.session.deleteMany({ where: { merchantId, id: { not: keepId } } });
}

export async function deleteExpiredSessions(db: Db, merchantId: string): Promise<void> {
  await db.session.deleteMany({ where: { merchantId, expiresAt: { lt: new Date() } } });
}
