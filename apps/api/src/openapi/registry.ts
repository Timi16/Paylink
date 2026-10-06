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

/**
 * The public API reference: what a developer can do with an API key, plus the open checkout
 * and health routes. Dashboard-only routes (sign-in, sessions, API-key and wallet management,
 * the dashboard's live stream) work only with the dashboard's session cookie, so they are
 * left out of the published document.
 */
export function buildOpenApiDocument(serverUrl?: string) {
  const registry = new OpenAPIRegistry();
  registry.registerComponent("securitySchemes", "apiKey", {
    type: "http",
    scheme: "bearer",
    description: "API key: `Authorization: Bearer pl_test_…`",
  });

  const ErrorResponse = registry.register("Error", s.ErrorResponseSchema);
  const schemas = {
    PaymentRequest: registry.register("PaymentRequest", s.RequestSchema),
    ChainPayment: registry.register("ChainPayment", s.PaymentSchema),
    RequestEvent: registry.register("RequestEvent", s.RequestEventSchema),
    Checkout: registry.register("Checkout", s.CheckoutSchema),
    Health: registry.register("Health", s.HealthSchema),
  };

  const add = (spec: RouteSpec) => {
    // Dashboard-only: not usable with an API key, so not part of the published reference.
    if (spec.auth === "session" || spec.tag === "Auth") return;
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
        spec.auth === "public" ? [] : [{ apiKey: [] }],
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
  add({ method: "post", path: "/auth/password/forgot", summary: "Email a one-hour password reset link (same answer whether or not the account exists)", tag: "Auth", auth: "public", body: s.ForgotPasswordBody, success: { 204: null }, errors: [400, 403, 503] });
  add({ method: "post", path: "/auth/password/reset", summary: "Set a new password from an emailed link; signs out everywhere", tag: "Auth", auth: "public", body: s.ResetPasswordBody, success: { 204: null }, errors: [400, 403] });
  add({ method: "get", path: "/auth/sessions", summary: "Where the merchant is signed in", tag: "Auth", auth: "session", success: { 200: s.SessionListResponse } });
  add({ method: "delete", path: "/auth/sessions/{id}", summary: "Sign one session out", tag: "Auth", auth: "session", params: s.SessionIdParamsSchema, success: { 204: null }, errors: [403, 404] });
  add({ method: "post", path: "/auth/sessions/logout-others", summary: "Sign out every other session", tag: "Auth", auth: "session", success: { 204: null }, errors: [403] });
  add({ method: "post", path: "/auth/settings", summary: "Update merchant settings (business name, support contact, request defaults, matching by exact amount)", tag: "Auth", auth: "session", body: s.UpdateSettingsBody, success: { 200: s.MerchantResponse }, errors: [400, 403] });
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
  add({ method: "get", path: "/v1/payment-requests/{id}", summary: "Get a payment request", description: "The request with every payment linked to it (whatever the outcome) and its history.", tag: "Payment requests", auth: "any", params: s.IdParamsSchema, success: { 200: s.RequestDetailResponse }, errors: [404] });
  add({ method: "post", path: "/v1/payment-requests/{id}/cancel", summary: "Cancel a payment request", description: "Only a PENDING request can be cancelled.", tag: "Payment requests", auth: "any", params: s.IdParamsSchema, success: { 200: s.RequestResponse }, errors: [403, 404, 409] });
  add({ method: "post", path: "/v1/payment-requests/{id}/accept", summary: "Accept as paid", description: "Marks the request PAID for what was received: an UNDERPAID request, an EXPIRED one with a late payment, or a CANCELLED one with a payment that arrived after the cancel.", tag: "Payment requests", auth: "any", params: s.IdParamsSchema, success: { 200: s.RequestResponse }, errors: [403, 404, 409] });

  add({ method: "get", path: "/v1/payment-requests/stats", summary: "Count requests by status", description: "Counts per status under the same filters as the list.", tag: "Payment requests", auth: "any", query: s.RequestStatsQuery, success: { 200: s.RequestStatsResponse }, errors: [400] });
  add({ method: "post", path: "/v1/payment-requests/{id}/refunded", summary: "Mark a request refunded", description: "Records that you sent back what the request itself owed: the excess over the amount asked, or money counted before it closed. PayLink never moves funds; this only records it.", tag: "Payment requests", auth: "any", params: s.IdParamsSchema, body: s.MarkRefundedBody, success: { 200: s.RequestResponse }, errors: [400, 403, 404, 409] });
  add({ method: "get", path: "/v1/summary", summary: "Get an overview", description: "Collected per asset, requests created and settled, open requests, and what needs attention, since `from`.", tag: "Payment requests", auth: "any", query: s.SummaryQuery, success: { 200: s.SummaryResponse }, errors: [400] });

  // Payments
  add({ method: "post", path: "/v1/payments/{eventId}/refunded", summary: "Mark a payment refunded", description: "Records that you sent a payment back to its payer. Not for payments that were applied to a request. PayLink never moves funds.", tag: "Payments", auth: "any", params: s.EventIdParamsSchema, body: s.MarkRefundedBody, success: { 200: s.PaymentResponse }, errors: [400, 403, 404, 409] });
  add({ method: "get", path: "/v1/payments", summary: "List payments", description: "Every payment that reached your wallets. Use `unmatched=true` for the ones that could not be tied to a request.", tag: "Payments", auth: "any", query: s.ListPaymentsQuery, success: { 200: s.PaymentListResponse }, errors: [400] });
  add({ method: "post", path: "/v1/payments/{eventId}/assign", summary: "Assign a payment", description: "Ties an unmatched payment to one of your requests on the same wallet and asset.", tag: "Payments", auth: "any", params: s.EventIdParamsSchema, body: s.AssignPaymentBody, success: { 200: s.AssignResponse }, errors: [400, 403, 404, 409] });

  // Live + public
  add({ method: "get", path: "/v1/stream", summary: "Merchant live stream (SSE): request.updated, payment.detected, wallet.updated", tag: "Live", auth: "session", success: { 200: sse } });
  add({ method: "get", path: "/public/pay/{publicId}", summary: "Get checkout data", tag: "Public checkout", auth: "public", params: s.PublicIdParamsSchema, success: { 200: schemas.Checkout }, errors: [404] });
  add({ method: "get", path: "/public/pay/{publicId}/events", summary: "Stream checkout status", description: "Server-Sent Events: a `status` event on connect and on every change.", tag: "Public checkout", auth: "public", params: s.PublicIdParamsSchema, success: { 200: sse }, errors: [404] });
  add({ method: "get", path: "/health", summary: "Health", description: "Database status, last processed ledger, lag in seconds and open request count.", tag: "System", auth: "public", success: { 200: schemas.Health }, errors: [503] });

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.3",
    info: {
      title: "PayLink API",
      version: "1.0.0",
      description: [
        "Create payment requests on **Stellar Testnet** and find out the moment they are paid. No real money moves.",
        "",
        "## Getting started",
        "1. In the PayLink dashboard, add and verify the wallet you want to be paid into, and copy its id.",
        "2. Create an API key under **API keys**. It is shown once; keep it on your server.",
        "3. Send it on every request: `Authorization: Bearer pl_test_…`.",
        "4. `POST /v1/payment-requests` and send your customer to the `checkoutUrl` in the response.",
        "",
        "## Conventions",
        "- **Amounts** are decimal strings with up to 7 decimals (`\"50\"`, `\"0.5\"`); responses also carry the exact value in stroops.",
        "- **Idempotency**: send an `Idempotency-Key` header when creating a request so a retry never creates a second one.",
        "- **Errors** share one shape: `{ error: { code, message, details, requestId } }`.",
        "- **Pagination**: lists take `limit` and `cursor` and return `{ data, nextCursor }`.",
        "- **Rate limit**: 300 requests a minute per account; a 429 carries `Retry-After`.",
      ].join("\n"),
    },
    tags: [
      { name: "Payment requests", description: "Create a request, follow it, cancel it, or accept what was paid." },
      { name: "Payments", description: "Everything that reached your wallets, including payments that could not be matched." },
      { name: "Public checkout", description: "What the hosted checkout page reads. No API key needed." },
      { name: "System" },
    ],
    servers: serverUrl ? [{ url: serverUrl }] : [],
  });
}
