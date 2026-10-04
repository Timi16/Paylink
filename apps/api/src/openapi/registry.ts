import { extendZodWithOpenApi, OpenApiGeneratorV3, OpenAPIRegistry, type RouteConfig } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import * as s from "@paylink/shared";

extendZodWithOpenApi(z);

type Auth = "public" | "session" | "any";

interface RouteSpec {
  method: RouteConfig["method"];
  path: string;
  summary: string;
  tag: string;
  auth: Auth;
  params?: z.AnyZodObject;
  query?: z.AnyZodObject;
  body?: z.ZodTypeAny;
  headers?: z.AnyZodObject;
  /** status -> schema (null = no body) */
  success: Record<number, z.ZodTypeAny | null>;
  errors?: number[];
  description?: string;
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Validation or business-rule failure",
  401: "No or bad session / API key",
  403: "CSRF check failed",
  404: "Missing, or belongs to another merchant",
  409: "Conflict with the current state",
  429: "Rate limited (see Retry-After)",
  503: "Dependency unavailable",
};

export function buildOpenApiDocument(serverUrl?: string) {
  const registry = new OpenAPIRegistry();
  registry.registerComponent("securitySchemes", "apiKey", {
    type: "http",
    scheme: "bearer",
    description: "API key: `Authorization: Bearer pl_test_…`",
  });
  registry.registerComponent("securitySchemes", "session", {
    type: "apiKey",
    in: "cookie",
    name: "pl_session",
    description: "Dashboard session cookie. State-changing requests must send Origin = the web origin.",
  });

  const ErrorResponse = registry.register("Error", s.ErrorResponseSchema);
  const schemas = {
    Merchant: registry.register("Merchant", s.MerchantSchema),
    ApiKey: registry.register("ApiKey", s.ApiKeySchema),
    Wallet: registry.register("Wallet", s.WalletSchema),
    PaymentRequest: registry.register("PaymentRequest", s.RequestSchema),
    ChainPayment: registry.register("ChainPayment", s.PaymentSchema),
    RequestEvent: registry.register("RequestEvent", s.RequestEventSchema),
    Checkout: registry.register("Checkout", s.CheckoutSchema),
    Health: registry.register("Health", s.HealthSchema),
  };

  const add = (spec: RouteSpec) => {
    const responses: RouteConfig["responses"] = {};
    for (const [status, schema] of Object.entries(spec.success)) {
      responses[status] = schema
        ? { description: "Success", content: { "application/json": { schema } } }
        : { description: "Success, no content" };
    }
    const errors = new Set([...(spec.errors ?? []), 429, ...(spec.auth === "public" ? [] : [401])]);
    for (const status of [...errors].sort()) {
      responses[String(status)] = {
        description: ERROR_DESCRIPTIONS[status] ?? "Error",
        content: { "application/json": { schema: ErrorResponse } },
      };
    }
    registry.registerPath({
      method: spec.method,
      path: spec.path,
      summary: spec.summary,
      description: spec.description,
      tags: [spec.tag],
      security:
        spec.auth === "public" ? [] : spec.auth === "session" ? [{ session: [] }] : [{ apiKey: [] }, { session: [] }],
      request: {
        ...(spec.params ? { params: spec.params } : {}),
        ...(spec.query ? { query: spec.query } : {}),
        ...(spec.headers ? { headers: spec.headers } : {}),
        ...(spec.body ? { body: { content: { "application/json": { schema: spec.body } } } } : {}),
      },
      responses,
    });
  };

  const noStrict = <T extends z.AnyZodObject>(schema: T) => schema;
  const sse = z.string().openapi({ description: "text/event-stream" });

  // Auth
  add({ method: "post", path: "/auth/signup", summary: "Create a merchant account", tag: "Auth", auth: "public", body: s.SignupBody, success: { 201: s.MerchantResponse }, errors: [400, 403, 409] });
  add({ method: "post", path: "/auth/login", summary: "Log in", tag: "Auth", auth: "public", body: s.LoginBody, success: { 200: s.MerchantResponse }, errors: [400, 401, 403] });
  add({ method: "post", path: "/auth/logout", summary: "Log out", tag: "Auth", auth: "session", success: { 204: null }, errors: [403] });
  add({ method: "get", path: "/auth/me", summary: "Current merchant", tag: "Auth", auth: "session", success: { 200: s.MerchantResponse } });
  add({ method: "post", path: "/auth/password", summary: "Change password (other sessions are signed out)", tag: "Auth", auth: "session", body: s.ChangePasswordBody, success: { 204: null }, errors: [400, 403] });

  // API keys
  add({ method: "get", path: "/v1/api-keys", summary: "List API keys", tag: "API keys", auth: "session", success: { 200: s.ApiKeyListResponse } });
  add({ method: "post", path: "/v1/api-keys", summary: "Create an API key (full key shown once)", tag: "API keys", auth: "session", body: s.CreateApiKeyBody, success: { 201: s.ApiKeyCreatedResponse }, errors: [400, 403, 409] });
  add({ method: "delete", path: "/v1/api-keys/{id}", summary: "Revoke an API key", tag: "API keys", auth: "session", params: noStrict(s.IdParamsSchema), success: { 204: null }, errors: [403, 404] });

  // Wallets
  add({ method: "get", path: "/v1/wallets", summary: "List wallets", tag: "Wallets", auth: "session", success: { 200: s.WalletListResponse } });
  add({ method: "post", path: "/v1/wallets", summary: "Add a wallet (unverified)", tag: "Wallets", auth: "session", body: s.AddWalletBody, success: { 201: s.WalletResponse }, errors: [400, 403, 409] });
  add({ method: "post", path: "/v1/wallets/{id}/refresh", summary: "Re-check the account and trustlines on Horizon", tag: "Wallets", auth: "session", params: s.IdParamsSchema, success: { 200: s.WalletResponse }, errors: [403, 404, 503] });
  add({ method: "post", path: "/v1/wallets/{id}/challenge", summary: "Issue an ownership challenge to sign (SEP-53)", tag: "Wallets", auth: "session", params: s.IdParamsSchema, success: { 200: s.ChallengeResponse }, errors: [403, 404] });
  add({ method: "post", path: "/v1/wallets/{id}/verify", summary: "Verify the signed challenge", tag: "Wallets", auth: "session", params: s.IdParamsSchema, body: s.VerifyWalletBody, success: { 200: s.WalletResponse }, errors: [400, 403, 404] });
  add({ method: "delete", path: "/v1/wallets/{id}", summary: "Remove a wallet (soft; watched until its open requests close)", tag: "Wallets", auth: "session", params: s.IdParamsSchema, success: { 204: null }, errors: [403, 404] });

  // Payment requests
  add({
    method: "post", path: "/v1/payment-requests", summary: "Create a payment request", tag: "Payment requests", auth: "any",
    body: s.CreateRequestBody,
    headers: z.object({ "Idempotency-Key": s.IdempotencyKeySchema.optional() }),
    success: { 201: s.RequestCreatedResponse, 200: s.RequestCreatedResponse },
    errors: [400, 403, 404, 409, 503],
    description: "Returns 201 for a new request. With an Idempotency-Key that was already used, returns the original request with 200, or 409 IDEMPOTENCY_MISMATCH if the body differs.",
  });
  add({ method: "get", path: "/v1/payment-requests", summary: "List payment requests", tag: "Payment requests", auth: "any", query: s.ListRequestsQuery, success: { 200: s.RequestListResponse }, errors: [400] });
  add({ method: "get", path: "/v1/payment-requests/{id}", summary: "Request with every linked payment and its audit trail", tag: "Payment requests", auth: "any", params: s.IdParamsSchema, success: { 200: s.RequestDetailResponse }, errors: [404] });
  add({ method: "post", path: "/v1/payment-requests/{id}/cancel", summary: "Cancel a PENDING request", tag: "Payment requests", auth: "any", params: s.IdParamsSchema, success: { 200: s.RequestResponse }, errors: [403, 404, 409] });
  add({ method: "post", path: "/v1/payment-requests/{id}/accept", summary: "Accept an UNDERPAID request, or an EXPIRED one with a late payment, as PAID", tag: "Payment requests", auth: "any", params: s.IdParamsSchema, success: { 200: s.RequestResponse }, errors: [403, 404, 409] });

  // Payments
  add({ method: "get", path: "/v1/payments", summary: "List detected payments (use unmatched=true for the Unmatched list)", tag: "Payments", auth: "any", query: s.ListPaymentsQuery, success: { 200: s.PaymentListResponse }, errors: [400] });
  add({ method: "post", path: "/v1/payments/{eventId}/assign", summary: "Assign an unmatched payment to a request", tag: "Payments", auth: "any", params: s.EventIdParamsSchema, body: s.AssignPaymentBody, success: { 200: s.AssignResponse }, errors: [400, 403, 404, 409] });

  // Live + public
  add({ method: "get", path: "/v1/stream", summary: "Merchant live stream (SSE): request.updated, payment.detected, wallet.updated", tag: "Live", auth: "session", success: { 200: sse } });
  add({ method: "get", path: "/public/pay/{publicId}", summary: "Checkout data for a payment link", tag: "Public checkout", auth: "public", params: s.PublicIdParamsSchema, success: { 200: schemas.Checkout }, errors: [404] });
  add({ method: "get", path: "/public/pay/{publicId}/events", summary: "Checkout status stream (SSE `status` events)", tag: "Public checkout", auth: "public", params: s.PublicIdParamsSchema, success: { 200: sse }, errors: [404] });
  add({ method: "get", path: "/health", summary: "Health: DB, last processed ledger, lag, open requests", tag: "System", auth: "public", success: { 200: schemas.Health }, errors: [503] });

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.3",
    info: {
      title: "PayLink API",
      version: "1.0.0",
      description:
        "Payment requests on Stellar Testnet. No real money. Amounts are decimal strings (7 decimals) with stroops alongside. Errors share one shape: `{ error: { code, message, details, requestId } }`.",
    },
    servers: serverUrl ? [{ url: serverUrl }] : [],
  });
}
