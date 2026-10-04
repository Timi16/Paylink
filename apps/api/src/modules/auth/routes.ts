import type { CookieOptions, Request, RequestHandler } from "express";
import { Router } from "express";
import { ChangePasswordBody, LoginBody, SignupBody } from "@paylink/shared";
import { isProduction } from "../../config/env";
import { authOf, SESSION_COOKIE } from "../../middleware/auth";
import { parse } from "../../middleware/validate";
import { serializeMerchant, SESSION_TTL_MS, type AuthService } from "./service";

const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "lax",
  path: "/",
};

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
    const { merchant, token } = await service.signup(body, clientOf(req));
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
    res.status(201).json({ merchant: serializeMerchant(merchant) });
  });

  router.post("/login", guards.credentialLimiter, async (req, res) => {
    const body = parse(LoginBody, req.body);
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const old = cookies?.[SESSION_COOKIE];
    const { merchant, token } = await service.login(
      body,
      clientOf(req),
      typeof old === "string" && old.length <= 128 ? old : null,
    );
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
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

  router.post("/password", guards.credentialLimiter, guards.requireSession, async (req, res) => {
    const auth = authOf(req);
    const body = parse(ChangePasswordBody, req.body);
    await service.changePassword(auth.merchantId, auth.sessionId ?? "", body);
    res.status(204).end();
  });

  return router;
}
