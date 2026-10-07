import type { PrismaClient } from "@prisma/client";
import type { Request, RequestHandler } from "express";
import { AppError } from "../lib/errors";
import { API_KEY_PREFIX, hashApiKey, hashSessionToken } from "../lib/ids";

export const SESSION_COOKIE = "pl_session";

export interface AuthContext {
  merchantId: string;
  via: "session" | "apiKey";
  /** Session row id (hash) when via === "session". */
  sessionId?: string;
  /** False while a session's merchant has not confirmed their email. */
  emailVerified: boolean;
}

const unauthenticated = () => new AppError("UNAUTHENTICATED", "Authentication required");

async function fromApiKey(prisma: PrismaClient, key: string): Promise<AuthContext | null> {
  if (!key.startsWith(API_KEY_PREFIX) || key.length > 128) return null;
  const row = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(key) } });
  if (!row || row.revokedAt) return null;
  // Throttled so a busy key costs one write a minute, not one per request.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await prisma.apiKey
      .updateMany({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }
  // A key can only be created from a confirmed account.
  return { merchantId: row.merchantId, via: "apiKey", emailVerified: true };
}

async function fromSession(prisma: PrismaClient, token: string): Promise<AuthContext | null> {
  if (token.length > 128) return null;
  const id = hashSessionToken(token);
  const row = await prisma.session.findUnique({ where: { id }, include: { merchant: { select: { emailVerifiedAt: true } } } });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await prisma.session.deleteMany({ where: { id } }).catch(() => undefined);
    return null;
  }
  // Throttled, like API keys: one write per session every five minutes at most.
  if (Date.now() - row.lastSeenAt.getTime() > 5 * 60_000) {
    await prisma.session.updateMany({ where: { id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  return { merchantId: row.merchantId, via: "session", sessionId: id, emailVerified: row.merchant.emailVerifiedAt !== null };
}

function sessionToken(req: Request): string | null {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const token = cookies?.[SESSION_COOKIE];
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** Bearer pl_test_… API key, otherwise the pl_session cookie; neither -> 401. */
export function requireAny(prisma: PrismaClient): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get("authorization");
    let auth: AuthContext | null;
    if (header) {
      // A presented Authorization header must be valid; never fall back to the cookie.
      const match = /^Bearer ([^\s]+)$/i.exec(header);
      auth = match?.[1] ? await fromApiKey(prisma, match[1]) : null;
    } else {
      const token = sessionToken(req);
      auth = token ? await fromSession(prisma, token) : null;
    }
    if (!auth) throw unauthenticated();
    req.auth = auth;
    next();
  };
}

/** Dashboard-only routes: wallet and API-key management, the merchant stream, /auth/me. */
export function requireSession(prisma: PrismaClient): RequestHandler {
  return async (req, _res, next) => {
    const token = sessionToken(req);
    const auth = token && !req.get("authorization") ? await fromSession(prisma, token) : null;
    if (!auth) throw unauthenticated();
    req.auth = auth;
    next();
  };
}

/** The dashboard and API stay locked until the email is confirmed. /auth routes are not behind this. */
export const requireVerifiedEmail: RequestHandler = (req, _res, next) => {
  if (req.auth && !req.auth.emailVerified) {
    return next(new AppError("EMAIL_NOT_VERIFIED", "Confirm your email to continue"));
  }
  next();
};

/** For routes mounted under requireAny that must not be reachable with an API key. */
export const sessionOnly: RequestHandler = (req, _res, next) => {
  if (req.auth?.via !== "session") {
    return next(new AppError("UNAUTHENTICATED", "This endpoint requires a dashboard session"));
  }
  next();
};

export function authOf(req: Request): AuthContext {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}
