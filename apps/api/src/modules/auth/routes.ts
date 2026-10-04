import type { CookieOptions, Request, RequestHandler } from "express";
import { Router } from "express";
import { ChangePasswordBody, LoginBody, SignupBody, UpdateSettingsBody } from "@paylink/shared";
import { isProduction } from "../../config/env";
import { authOf, SESSION_COOKIE } from "../../middleware/auth";
import { parse } from "../../middleware/validate";
import { DEVICE_TTL_MS, serializeMerchant, SESSION_TTL_MS, type AuthService } from "./service";

const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "lax",
  path: "/",
};

/** Marks a browser that has logged in before; only ever read by /auth/login. */
export const DEVICE_COOKIE = "pl_device";
const deviceCookieOptions: CookieOptions = { ...cookieOptions, path: "/auth", maxAge: DEVICE_TTL_MS };

function cookieOf(req: Request, name: string): string | null {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

function clientOf(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null };
}

export interface AuthRouteGuards {
  /** Strict limiter for credential endpoints. */
  credentialLimiter: RequestHandler;
  readLimiter: RequestHandler;
  requireSession: RequestHandler;
}

export function authRoutes(service: AuthService, guards: AuthRouteGuards): Router {
  const router = Router();

  router.post("/signup", guards.credentialLimiter, async (req, res) => {
    const body = parse(SignupBody, req.body);
    const { merchant, token, deviceToken } = await service.signup(body, clientOf(req));
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
    res.cookie(DEVICE_COOKIE, deviceToken, deviceCookieOptions);
    res.status(201).json({ merchant: serializeMerchant(merchant) });
  });

  router.post("/login", guards.credentialLimiter, async (req, res) => {
    const body = parse(LoginBody, req.body);
    const { merchant, token, deviceToken } = await service.login(
      body,
      clientOf(req),
      cookieOf(req, SESSION_COOKIE),
      cookieOf(req, DEVICE_COOKIE),
    );
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
    res.cookie(DEVICE_COOKIE, deviceToken, deviceCookieOptions);
    res.json({ merchant: serializeMerchant(merchant) });
  });

  router.post("/logout", guards.readLimiter, guards.requireSession, async (req, res) => {
    const auth = authOf(req);
    if (auth.sessionId) await service.logout(auth.sessionId);
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.status(204).end();
  });

  router.get("/me", guards.readLimiter, guards.requireSession, async (req, res) => {
    const merchant = await service.me(authOf(req).merchantId);
    res.json({ merchant: serializeMerchant(merchant) });
  });

  router.post("/settings", guards.readLimiter, guards.requireSession, async (req, res) => {
    const body = parse(UpdateSettingsBody, req.body);
    const merchant = await service.updateSettings(authOf(req).merchantId, body);
    res.json({ merchant: serializeMerchant(merchant) });
  });

  router.post("/password", guards.credentialLimiter, guards.requireSession, async (req, res) => {
    const auth = authOf(req);
    const body = parse(ChangePasswordBody, req.body);
    await service.changePassword(auth.merchantId, auth.sessionId ?? "", body);
    res.status(204).end();
  });

  return router;
}
