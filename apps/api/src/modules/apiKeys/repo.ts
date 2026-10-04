import type { ApiKey } from "@prisma/client";
import type { Db } from "../../db/prisma";

export function listApiKeys(db: Db, merchantId: string): Promise<ApiKey[]> {
  return db.apiKey.findMany({ where: { merchantId }, orderBy: { createdAt: "desc" } });
}

export function countActiveApiKeys(db: Db, merchantId: string): Promise<number> {
  return db.apiKey.count({ where: { merchantId, revokedAt: null } });
}

export function createApiKey(
  db: Db,
  merchantId: string,
  data: { name: string; prefix: string; keyHash: string },
): Promise<ApiKey> {
  return db.apiKey.create({ data: { merchantId, ...data } });
}

/** Returns false when the key does not exist for this merchant. Revoking twice is a no-op. */
export async function revokeApiKey(db: Db, merchantId: string, id: string): Promise<boolean> {
  const key = await db.apiKey.findFirst({ where: { id, merchantId } });
  if (!key) return false;
  if (!key.revokedAt) {
    await db.apiKey.updateMany({ where: { id, merchantId }, data: { revokedAt: new Date() } });
  }
  return true;
}
