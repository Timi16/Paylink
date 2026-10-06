import { apiReference } from "@scalar/express-api-reference";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env";
import { DEFAULT_LIMITS, type AppDeps, type Limits } from "./deps";
import type { Mailer } from "./lib/mailer";
import { requireAny, requireSession, sessionOnly, authOf } from "./middleware/auth";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { PgRateLimitStore } from "./middleware/pgRateLimitStore";
import { limiter } from "./middleware/rateLimit";
import { requestId } from "./middleware/requestId";
import { rejectNulBytes } from "./middleware/validate";
import { requireOrigin } from "./middleware/requireOrigin";
import { apiKeyRoutes } from "./modules/apiKeys/routes";
import { createApiKeyService } from "./modules/apiKeys/service";
import { authRoutes } from "./modules/auth/routes";
import { createAuthService } from "./modules/auth/service";
import { healthRoutes } from "./modules/health/routes";
import { paymentRoutes } from "./modules/payments/routes";
import { createPaymentService } from "./modules/payments/service";
import { publicRoutes } from "./modules/public/routes";
import { createPublicService } from "./modules/public/service";
import { requestRoutes, summaryRoutes } from "./modules/requests/routes";
import { createRequestService } from "./modules/requests/service";
import { merchantStreamRoutes } from "./modules/stream/routes";
import { SseRegistry } from "./modules/stream/sse";
import { walletRoutes } from "./modules/wallets/routes";
import { createWalletService } from "./modules/wallets/service";
import { buildOpenApiDocument } from "./openapi/registry";

export interface BuiltApp {
  app: Express;
  sse: SseRegistry;
}

export type BuildAppDeps = Omit<AppDeps, "limits" | "mailer"> & { limits?: Partial<Limits>; mailer?: Mailer | null };

/** Wires everything in a fixed order. Tests import this same function. */
export function buildApp(input: BuildAppDeps): BuiltApp {
  const deps: AppDeps = { ...input, mailer: input.mailer ?? null, limits: { ...DEFAULT_LIMITS, ...input.limits } };
  const { limits, prisma } = deps;
  const sse = new SseRegistry();
  const app = express();

  // 1. Behind Caddy: trust exactly one proxy hop so req.ip is the real client.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.set("query parser", "simple");

  // 2-3. Request id, then logging (secrets are redacted by the logger).
  app.use(requestId);
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: { ignore: (req) => req.url === "/health" },
      // Query strings are dropped from logs: they can carry cursors and search terms.
      serializers: {
        req: (req: { method: string; url: string; id: unknown }) => ({
          id: req.id,
          method: req.method,
          url: req.url.split("?")[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  // 4. Security headers. The API serves JSON only, so nothing may frame or load from it.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  // 5. CORS: credentials only for the web origin on /auth and /v1; public routes are open.
  const credentialedCors = cors({
    origin: env.WEB_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id", "Retry-After"],
    maxAge: 600,
  });
  const openCors = cors({ origin: "*", methods: ["GET"], exposedHeaders: ["X-Request-Id", "Retry-After"] });
  app.use("/auth", credentialedCors);
  app.use("/v1", credentialedCors);
  app.use(["/public", "/health", "/openapi.json"], openCors);

  // 6. Body parsing.
  app.use(express.json({ limit: "50kb" }));
  app.use(cookieParser());
  app.use(rejectNulBytes);

  // 7. Routes.
  const walletService = createWalletService(deps);
  const requestService = createRequestService(deps, walletService);

  app.use("/health", healthRoutes(deps));

  let openApiDocument: ReturnType<typeof buildOpenApiDocument> | null = null;
  app.get("/openapi.json", (req, res) => {
    // The server URL is this API as the caller reached it, so "try it" and the samples point here.
    openApiDocument ??= buildOpenApiDocument(`${req.protocol}://${req.get("host") ?? "localhost"}`);
    res.json(openApiDocument);
  });
  app.use(
    "/docs",
    (_req, res, next) => {
      // The reference UI loads its bundle from a CDN; relax the JSON-only CSP for this page.
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net https://fonts.scalar.com; img-src 'self' data: https:; connect-src 'self' https:; frame-ancestors 'none'",
      );
      next();
    },
    apiReference({
      url: "/openapi.json",
      pageTitle: "PayLink API reference",
      // A plain reference: no editor toolbar, AI assistant, MCP generator or usage telemetry.
      showDeveloperTools: "never",
      agent: { disabled: true },
      mcp: { disabled: true },
      telemetry: false,
      hideClientButton: true,
      defaultOpenAllTags: true,
      authentication: { preferredSecurityScheme: "apiKey" },
    }),
  );

  app.use(
    "/public",
    limiter({ limit: limits.publicPerMin }),
    publicRoutes(deps, createPublicService(deps, walletService), sse),
  );

  app.use(
    "/auth",
    requireOrigin,
    authRoutes(createAuthService(deps), {
      // Shared across instances: this is the brute-force limit.
      credentialLimiter: limiter({ limit: limits.authPerMin, store: new PgRateLimitStore(prisma, "auth:") }),
      readLimiter: limiter({ limit: limits.authReadPerMin }),
      requireSession: requireSession(prisma),
    }),
  );

  const v1 = express.Router();
  v1.use(limiter({ limit: limits.v1PerIpPerMin }));
  v1.use(requireAny(prisma));
  v1.use(requireOrigin);
  v1.use(limiter({ limit: limits.v1PerMin, key: (req) => `merchant:${authOf(req).merchantId}` }));
  v1.use("/api-keys", sessionOnly, apiKeyRoutes(createApiKeyService(deps)));
  v1.use("/wallets", sessionOnly, walletRoutes(walletService));
  v1.use("/stream", sessionOnly, merchantStreamRoutes(deps, sse));
  v1.use("/payment-requests", requestRoutes(requestService, prisma));
  v1.use("/summary", summaryRoutes(requestService));
  v1.use("/payments", paymentRoutes(createPaymentService(deps), prisma));
  app.use("/v1", v1);

  // 8. 404, then the error handler.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, sse };
}
