import { Prisma, PrismaClient } from "@prisma/client";
import { env } from "../config/env";

export const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });

export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;

const CONNECTION_CODES = new Set(["P1000", "P1001", "P1002", "P1003", "P1008", "P1017", "P2024"]);

/** True when the error means Postgres is unreachable (as opposed to a bad query). */
export function isDbUnavailable(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  if (err instanceof Prisma.PrismaClientRustPanicError) return true;
  if (err instanceof Prisma.PrismaClientKnownRequestError) return CONNECTION_CODES.has(err.code);
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return /connection|terminat|ECONNREFUSED|closed/i.test(err.message);
  }
  return false;
}

/** Returns the violated unique-constraint fields, or null if `err` is not a unique violation. */
export function uniqueViolation(err: unknown): string[] | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    const target = err.meta?.target;
    if (Array.isArray(target)) return target.map(String);
    return typeof target === "string" ? [target] : [];
  }
  return null;
}
