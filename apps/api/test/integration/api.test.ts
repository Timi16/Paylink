import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addVerifiedWallet,
  createRequest,
  makeApp,
  makeEngine,
  ORIGIN,
  prisma,
  resetDb,
  setupMerchant,
  signup,
  USDC,
  type TestApp,
} from "../helpers/harness";

let t: TestApp;

beforeAll(() => {
  t = makeApp();
});
beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const creds = { email: "owner@shop.example", password: "correct horse battery", businessName: "Shop" };
const anon = () => request(t.app);

describe("auth", () => {
  it("signs up, sets an httpOnly SameSite=Lax cookie, and never returns the password hash", async () => {
    const res = await anon().post("/auth/signup").set("Origin", ORIGIN).send({ ...creds, email: "  Owner@Shop.Example " });
    expect(res.status).toBe(201);
    expect(res.body.merchant).toMatchObject({ email: "owner@shop.example", businessName: "Shop" });
    expect(JSON.stringify(res.body)).not.toMatch(/password|argon/i);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/^pl_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    // Only a keyed hash of the token is stored, and the password is argon2id.
    const token = /pl_session=([^;]+)/.exec(cookie)?.[1] as string;
    const session = await prisma.session.findFirstOrThrow();
    expect(session.id).not.toContain(token);
    expect(session.id).toMatch(/^[0-9a-f]{64}$/);
    const days = (session.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect((await prisma.merchant.findFirstOrThrow()).passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("rejects weak passwords, bad emails, unknown fields and duplicate emails", async () => {
    const signupWith = (body: object) => anon().post("/auth/signup").set("Origin", ORIGIN).send(body);
    expect((await signupWith({ ...creds, password: "short" })).status).toBe(400);
    expect((await signupWith({ ...creds, email: "nope" })).status).toBe(400);
    expect((await signupWith({ ...creds, admin: true })).status).toBe(400);
    expect((await signupWith({ ...creds, businessName: "  " })).status).toBe(400);
    expect((await signupWith(creds)).status).toBe(201);
    const dup = await signupWith({ ...creds, email: "OWNER@shop.example" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("logs in with the same error for a wrong email or a wrong password, and rotates the session", async () => {
    await anon().post("/auth/signup").set("Origin", ORIGIN).send(creds);
    const wrongPw = await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: creds.email, password: "wrong password!" });
    const wrongEmail = await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: "nobody@shop.example", password: creds.password });
    expect(wrongPw.status).toBe(401);
    expect(wrongEmail.status).toBe(401);
    expect(wrongPw.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(wrongEmail.body.error.message).toBe(wrongPw.body.error.message);

    const agent = request.agent(t.app);
    const login = { email: creds.email, password: creds.password };
    const first = await agent.post("/auth/login").set("Origin", ORIGIN).send(login);
    expect(first.status).toBe(200);
    const before = await prisma.session.findMany();
    const second = await agent.post("/auth/login").set("Origin", ORIGIN).send(login);
    expect(second.status).toBe(200);
    const after = await prisma.session.findMany();
    // The presented session was replaced, not kept alongside the new one.
    expect(after).toHaveLength(before.length);
    expect(after.map((s) => s.id).sort()).not.toEqual(before.map((s) => s.id).sort());
    expect((await agent.get("/auth/me")).body.merchant.email).toBe(creds.email);
  });

  it("locks the account with a growing delay after repeated failures", async () => {
    await anon().post("/auth/signup").set("Origin", ORIGIN).send(creds);
    const attempt = (password: string) => anon().post("/auth/login").set("Origin", ORIGIN).send({ email: creds.email, password });
    for (let i = 0; i < 3; i++) expect((await attempt("wrong password!")).status).toBe(401);
    const locked = await attempt(creds.password); // even the right password waits
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("RATE_LIMITED");
    expect(Number.parseInt(locked.headers["retry-after"] as string, 10)).toBeGreaterThan(0);
  });

  it("an attacker who knows the email cannot lock the merchant out of a browser they have used before", async () => {
    const owner = request.agent(t.app); // signs up here, so this browser becomes a trusted device
    await owner.post("/auth/signup").set("Origin", ORIGIN).send(creds);
    const login = { email: creds.email, password: creds.password };
    // 25 wrong passwords from 25 different addresses: no single IP trips its own lock,
    // but together they trip the account-wide one.
    for (let i = 0; i < 25; i++) {
      const res = await anon().post("/auth/login").set("Origin", ORIGIN).set("X-Forwarded-For", `203.0.113.${i + 1}`).send({ ...login, password: "wrong password!" });
      expect([401, 429]).toContain(res.status);
    }
    // A browser that has never logged in to this account is held back, even with the right password…
    const stranger = await anon().post("/auth/login").set("Origin", ORIGIN).set("X-Forwarded-For", "198.51.100.7").send(login);
    expect(stranger.status).toBe(429);
    expect(stranger.body.error.code).toBe("RATE_LIMITED");
    // …but the merchant's own browser gets straight in.
    const mine = await owner.post("/auth/login").set("Origin", ORIGIN).send(login);
    expect(mine.status).toBe(200);
    // A successful login clears the account-wide lock for everyone.
    expect((await anon().post("/auth/login").set("Origin", ORIGIN).set("X-Forwarded-For", "198.51.100.7").send(login)).status).toBe(200);
    // The device cookie is httpOnly, scoped to /auth, and only its hash is stored.
    const cookies = (await request(t.app).post("/auth/login").set("Origin", ORIGIN).send(login)).headers["set-cookie"] as unknown as string[];
    const device = cookies.find((c) => c.startsWith("pl_device=")) as string;
    expect(device).toMatch(/HttpOnly/);
    expect(device).toMatch(/Path=\/auth/);
    const token = /pl_device=([^;]+)/.exec(device)?.[1] as string;
    expect(await prisma.trustedDevice.findUnique({ where: { id: token } })).toBeNull();
  });

  it("a device trusted for one account gives no exemption on another", async () => {
    const attacker = request.agent(t.app);
    await attacker.post("/auth/signup").set("Origin", ORIGIN).send({ ...creds, email: "attacker@evil.example" });
    await anon().post("/auth/signup").set("Origin", ORIGIN).send(creds);
    for (let i = 0; i < 25; i++) {
      await anon().post("/auth/login").set("Origin", ORIGIN).set("X-Forwarded-For", `203.0.113.${i + 1}`).send({ email: creds.email, password: "wrong password!" });
    }
    // The attacker's own trusted-device cookie is for a different merchant: still locked.
    const res = await attacker.post("/auth/login").set("Origin", ORIGIN).set("X-Forwarded-For", "198.51.100.9").send({ email: creds.email, password: creds.password });
    expect(res.status).toBe(429);
  });

  it("login throttling and the credential rate limit hold across API instances", async () => {
    await anon().post("/auth/signup").set("Origin", ORIGIN).send(creds);
    const a = makeApp();
    const b = makeApp();
    const wrong = { email: creds.email, password: "wrong password!" };
    // Failures spread over two instances add up to one lock.
    expect((await request(a.app).post("/auth/login").set("Origin", ORIGIN).send(wrong)).status).toBe(401);
    expect((await request(b.app).post("/auth/login").set("Origin", ORIGIN).send(wrong)).status).toBe(401);
    expect((await request(a.app).post("/auth/login").set("Origin", ORIGIN).send(wrong)).status).toBe(401);
    expect((await request(b.app).post("/auth/login").set("Origin", ORIGIN).send(wrong)).status).toBe(429);

    // The 5-per-minute limit on credential endpoints is one budget, not one per instance.
    await prisma.loginThrottle.deleteMany();
    await prisma.rateLimit.deleteMany();
    const c = makeApp({ authPerMin: 5 });
    const d = makeApp({ authPerMin: 5 });
    let n = 0;
    const attempt = (app: typeof c) => request(app.app).post("/auth/login").set("Origin", ORIGIN).send({ email: `nobody${n++}@x.example`, password: "whatever it is" });
    for (const app of [c, d, c, d, c]) expect((await attempt(app)).status).toBe(401);
    expect((await attempt(d)).status).toBe(429);
    expect((await attempt(c)).status).toBe(429);
  });

  it("merchant settings: automatic matching by amount is off by default and can be switched", async () => {
    const m = await signup(t);
    expect((await m.agent.get("/auth/me")).body.merchant.autoMatchByAmount).toBe(false);
    const on = await m.agent.post("/auth/settings").set("Origin", ORIGIN).send({ autoMatchByAmount: true });
    expect(on.status).toBe(200);
    expect(on.body.merchant.autoMatchByAmount).toBe(true);
    expect((await m.agent.post("/auth/settings").set("Origin", ORIGIN).send({ autoMatchByAmount: "yes" })).status).toBe(400);
    expect((await m.agent.post("/auth/settings").set("Origin", ORIGIN).send({})).status).toBe(400);
    expect((await m.agent.post("/auth/settings").set("Origin", ORIGIN).send({ email: "new@x.example" })).status).toBe(400);
    expect((await m.agent.post("/auth/settings").send({ autoMatchByAmount: false })).status).toBe(403);
    expect((await anon().post("/auth/settings").set("Origin", ORIGIN).send({ autoMatchByAmount: false })).status).toBe(401);
  });

  it("merchant settings: business name, support contact and request defaults", async () => {
    const { merchant, wallet } = await setupMerchant(t, "Old Name");
    const save = (body: object) => merchant.agent.post("/auth/settings").set("Origin", ORIGIN).send(body);
    const res = await save({ businessName: "  Ada's Kitchen ", supportContact: "+234 801 234 5678", defaultExpiryMinutes: 60, defaultWalletId: wallet.id });
    expect(res.status).toBe(200);
    expect(res.body.merchant).toMatchObject({ businessName: "Ada's Kitchen", supportContact: "+234 801 234 5678", defaultExpiryMinutes: 60, defaultWalletId: wallet.id, autoMatchByAmount: false });
    // The checkout shows the new name and how to reach the business.
    const req = await createRequest(merchant, wallet);
    const checkout = await anon().get(`/public/pay/${req.publicId}`);
    expect(checkout.body).toMatchObject({ businessName: "Ada's Kitchen", supportContact: "+234 801 234 5678" });
    expect((await save({ supportContact: null })).body.merchant.supportContact).toBeNull();

    for (const bad of [{ businessName: "" }, { defaultExpiryMinutes: 4 }, { defaultExpiryMinutes: 43_201 }, { supportContact: "x".repeat(101) }, { defaultWalletId: "../x" }]) {
      expect((await save(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    // The default wallet must be one of the merchant's own, live wallets.
    const other = await setupMerchant(t, "Other");
    expect((await save({ defaultWalletId: other.wallet.id })).status).toBe(404);
    // Removing the default wallet clears the default.
    await merchant.agent.delete(`/v1/wallets/${wallet.id}`).set("Origin", ORIGIN);
    expect((await merchant.agent.get("/auth/me")).body.merchant.defaultWalletId).toBeNull();
    expect((await save({ defaultWalletId: wallet.id })).status).toBe(404);
  });

  it("'keep me logged in' unticked gives a browser-session cookie and a one-day session", async () => {
    await anon().post("/auth/signup").set("Origin", ORIGIN).send(creds);
    await prisma.session.deleteMany();
    const short = await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: creds.email, password: creds.password, remember: false });
    expect(short.status).toBe(200);
    const cookie = (short.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("pl_session=")) as string;
    expect(cookie).not.toMatch(/Max-Age|Expires/i);
    const session = await prisma.session.findFirstOrThrow();
    const hours = (session.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(24);
    const long = await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: creds.email, password: creds.password, remember: true });
    expect(String(long.headers["set-cookie"])).toMatch(/pl_session=[^;]+; Max-Age=1209600/);
  });

  it("sessions: lists where you're signed in, signs one out, and signs out everywhere else", async () => {
    const m = await signup(t);
    const login = () => request.agent(t.app).post("/auth/login").set("Origin", ORIGIN).set("User-Agent", "Mozilla/5.0 (iPhone)").send({ email: m.email, password: m.password });
    const phoneAgent = request.agent(t.app);
    await phoneAgent.post("/auth/login").set("Origin", ORIGIN).set("User-Agent", "Mozilla/5.0 (iPhone)").send({ email: m.email, password: m.password });
    await login();
    const list = await m.agent.get("/auth/sessions");
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(3);
    expect(list.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(list.body.data.some((s: { userAgent: string }) => s.userAgent === "Mozilla/5.0 (iPhone)")).toBe(true);
    expect(JSON.stringify(list.body)).not.toMatch(/token/i);
    // Last-active time: set at sign-in, then refreshed when the session is used after a while.
    const mine = list.body.data.find((x: { current: boolean }) => x.current) as { id: string; lastSeenAt: string };
    await prisma.session.update({ where: { id: mine.id }, data: { lastSeenAt: new Date(Date.now() - 3_600_000) } });
    await m.agent.get("/auth/me");
    const seen = (await prisma.session.findUniqueOrThrow({ where: { id: mine.id } })).lastSeenAt;
    expect(Date.now() - seen.getTime()).toBeLessThan(10_000);

    const others = list.body.data.filter((s: { current: boolean }) => !s.current) as { id: string }[];
    expect((await m.agent.delete(`/auth/sessions/${others[0]!.id}`).set("Origin", ORIGIN)).status).toBe(204);
    expect((await m.agent.delete(`/auth/sessions/${others[0]!.id}`).set("Origin", ORIGIN)).status).toBe(404);
    expect((await m.agent.delete("/auth/sessions/not-a-session").set("Origin", ORIGIN)).status).toBe(400);
    expect((await m.agent.delete(`/auth/sessions/${others[1]!.id}`)).status).toBe(403); // CSRF guard

    // Another merchant cannot see or end these sessions.
    const stranger = await signup(t);
    expect((await stranger.agent.get("/auth/sessions")).body.data).toHaveLength(1);
    expect((await stranger.agent.delete(`/auth/sessions/${others[1]!.id}`).set("Origin", ORIGIN)).status).toBe(404);

    expect((await m.agent.post("/auth/sessions/logout-others").set("Origin", ORIGIN)).status).toBe(204);
    expect((await m.agent.get("/auth/sessions")).body.data).toMatchObject([{ current: true }]);
    expect((await phoneAgent.get("/auth/me")).status).toBe(401);
    expect((await m.agent.get("/auth/me")).status).toBe(200);
    expect((await anon().get("/auth/sessions")).status).toBe(401);
  });

  it("password reset: a one-hour, single-use emailed link that signs out everywhere", async () => {
    const m = await signup(t);
    t.mailer.sent.length = 0;
    const forgot = (email: string) => anon().post("/auth/password/forgot").set("Origin", ORIGIN).send({ email });
    // Unknown address: the same answer, and no email.
    expect((await forgot("nobody@nowhere.example")).status).toBe(204);
    expect(t.mailer.sent).toHaveLength(0);
    expect((await forgot(m.email.toUpperCase())).status).toBe(204);
    expect(t.mailer.sent).toHaveLength(1);
    expect(t.mailer.sent[0]).toMatchObject({ to: m.email, subject: "Reset your PayLink password" });
    const token = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(t.mailer.sent[0]!.text)?.[1] as string;
    expect(t.mailer.sent[0]!.text).toContain(`${ORIGIN}/reset-password?token=${token}`);
    // Only a hash of the token is stored.
    expect(await prisma.passwordReset.findUnique({ where: { id: token } })).toBeNull();
    // Asking again straight away does not send a second email.
    expect((await forgot(m.email)).status).toBe(204);
    expect(t.mailer.sent).toHaveLength(1);

    const reset = (body: object) => anon().post("/auth/password/reset").set("Origin", ORIGIN).send(body);
    expect((await reset({ token, newPassword: "short" })).status).toBe(400);
    expect((await reset({ token: "x".repeat(43), newPassword: "a whole new password" })).body.error.code).toBe("CHALLENGE_EXPIRED");
    expect((await reset({ token, newPassword: "a whole new password" })).status).toBe(204);
    // Used once: it cannot be replayed.
    expect((await reset({ token, newPassword: "another new password" })).status).toBe(400);
    // Every session is gone; the old password no longer works; the new one does.
    expect((await m.agent.get("/auth/me")).status).toBe(401);
    expect((await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: m.email, password: m.password })).status).toBe(401);
    expect((await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: m.email, password: "a whole new password" })).status).toBe(200);

    // An expired link is refused.
    await prisma.passwordReset.deleteMany();
    await forgot(m.email);
    const second = /token=([A-Za-z0-9_-]+)/.exec(t.mailer.sent.at(-1)!.text)?.[1] as string;
    await prisma.passwordReset.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await reset({ token: second, newPassword: "yet another password" })).body.error.code).toBe("CHALLENGE_EXPIRED");
    expect((await anon().post("/auth/password/forgot").send({ email: m.email })).status).toBe(403); // CSRF guard
  });

  it("password reset says so plainly when email is not set up", async () => {
    const noMail = makeApp({}, { mailer: null });
    const res = await request(noMail.app).post("/auth/password/forgot").set("Origin", ORIGIN).send({ email: "a@b.example" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("logout ends the session; me requires one; expired sessions are refused", async () => {
    const m = await signup(t);
    expect((await anon().get("/auth/me")).status).toBe(401);
    expect((await m.agent.get("/auth/me")).status).toBe(200);
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await m.agent.get("/auth/me")).status).toBe(401);
    expect(await prisma.session.count()).toBe(0); // swept on sight

    const again = await signup(t);
    expect((await again.agent.post("/auth/logout").set("Origin", ORIGIN)).status).toBe(204);
    expect((await again.agent.get("/auth/me")).status).toBe(401);
    expect((await again.agent.get("/v1/wallets")).status).toBe(401);
  });

  it("changing the password needs the current one and signs out every other session", async () => {
    const m = await signup(t);
    const elsewhere = request.agent(t.app);
    await elsewhere.post("/auth/login").set("Origin", ORIGIN).send({ email: m.email, password: m.password });
    const change = (body: object) => m.agent.post("/auth/password").set("Origin", ORIGIN).send(body);
    expect((await change({ currentPassword: "not my password", newPassword: "a brand new password" })).status).toBe(401);
    expect((await change({ currentPassword: m.password, newPassword: "short" })).status).toBe(400);
    expect((await change({ currentPassword: m.password, newPassword: "a brand new password" })).status).toBe(204);
    expect((await m.agent.get("/auth/me")).status).toBe(200);
    expect((await elsewhere.get("/auth/me")).status).toBe(401);
    expect((await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: m.email, password: m.password })).status).toBe(401);
    expect((await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: m.email, password: "a brand new password" })).status).toBe(200);
  });

  it("CSRF: cookie-authenticated writes need Origin (or Referer) equal to the web origin", async () => {
    const m = await signup(t);
    const noOrigin = await m.agent.post("/v1/api-keys").send({ name: "k" });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.error.code).toBe("FORBIDDEN_ORIGIN");
    expect((await m.agent.post("/v1/api-keys").set("Origin", "https://evil.example").send({ name: "k" })).status).toBe(403);
    expect((await m.agent.post("/v1/api-keys").set("Origin", `${ORIGIN}.evil.example`).send({ name: "k" })).status).toBe(403);
    expect((await m.agent.post("/v1/api-keys").set("Origin", "null").send({ name: "k" })).status).toBe(403);
    // A sandboxed frame sends Origin: null; a matching Referer must not rescue it.
    expect((await m.agent.post("/v1/api-keys").set("Origin", "null").set("Referer", `${ORIGIN}/x`).send({ name: "k" })).status).toBe(403);
    expect((await m.agent.post("/v1/api-keys").set("Referer", `${ORIGIN}/dashboard/keys`).send({ name: "k" })).status).toBe(201);
    expect((await m.agent.post("/auth/logout")).status).toBe(403);
    expect((await anon().post("/auth/login").send({ email: creds.email, password: creds.password })).status).toBe(403);
    expect((await m.agent.get("/v1/api-keys")).status).toBe(200); // reads are not affected
    expect(await prisma.apiKey.count()).toBe(1);
  });

  it("CORS allows credentials only for the web origin; public routes are open without credentials", async () => {
    const pre = await anon().options("/v1/payment-requests").set("Origin", ORIGIN).set("Access-Control-Request-Method", "POST");
    expect(pre.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(pre.headers["access-control-allow-credentials"]).toBe("true");
    const evil = await anon().options("/v1/payment-requests").set("Origin", "https://evil.example").set("Access-Control-Request-Method", "POST");
    expect(evil.headers["access-control-allow-origin"]).not.toBe("https://evil.example");
    const pub = await anon().get("/public/pay/aaaaaaaaaaaa").set("Origin", "https://anything.example");
    expect(pub.headers["access-control-allow-origin"]).toBe("*");
    expect(pub.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("API keys", () => {
  it("shows the full key once, stores only its hash, authenticates with Bearer, and can be revoked", async () => {
    const { merchant, wallet } = await setupMerchant(t);
    const created = await merchant.agent.post("/v1/api-keys").set("Origin", ORIGIN).send({ name: "Storefront" });
    expect(created.status).toBe(201);
    const key = created.body.key as string;
    expect(key).toMatch(/^pl_test_[A-Za-z0-9]{43}$/);
    expect(created.body.apiKey).toMatchObject({ name: "Storefront", prefix: key.slice(0, 12), revokedAt: null });
    const row = await prisma.apiKey.findFirstOrThrow();
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(key);
    const list = await merchant.agent.get("/v1/api-keys");
    expect(JSON.stringify(list.body)).not.toContain(key);

    // API-key requests need no Origin and are attributed to "api".
    const viaKey = await anon().post("/v1/payment-requests").set("Authorization", `Bearer ${key}`).send({ walletId: wallet.id, amount: "5", asset: "XLM" });
    expect(viaKey.status).toBe(201);
    expect(viaKey.body.request.createdVia).toBe("api");
    expect((await prisma.apiKey.findFirstOrThrow()).lastUsedAt).not.toBeNull();
    const cancel = await anon().post(`/v1/payment-requests/${viaKey.body.request.id}/cancel`).set("Authorization", `Bearer ${key}`);
    expect(cancel.status).toBe(200);
    expect((await prisma.requestEvent.findFirstOrThrow()).actor).toBe("api");

    // Wallet and key management and the dashboard stream are session-only.
    for (const path of ["/v1/wallets", "/v1/api-keys", "/v1/stream"]) {
      expect((await anon().get(path).set("Authorization", `Bearer ${key}`)).status, path).toBe(401);
    }
    expect((await anon().get("/auth/me").set("Authorization", `Bearer ${key}`)).status).toBe(401);

    const revoke = await merchant.agent.delete(`/v1/api-keys/${created.body.apiKey.id}`).set("Origin", ORIGIN);
    expect(revoke.status).toBe(204);
    expect((await anon().get("/v1/payment-requests").set("Authorization", `Bearer ${key}`)).status).toBe(401);
    expect((await merchant.agent.delete(`/v1/api-keys/${created.body.apiKey.id}`).set("Origin", ORIGIN)).status).toBe(204);
  });

  it("rejects missing, malformed and unknown credentials with 401 UNAUTHENTICATED", async () => {
    const m = await signup(t);
    for (const header of ["Bearer pl_test_doesnotexist", "Bearer ", "Basic abc", "pl_test_x", `Bearer ${"x".repeat(500)}`]) {
      const res = await anon().get("/v1/payment-requests").set("Authorization", header);
      expect(res.status, header).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    }
    expect((await anon().get("/v1/payment-requests")).status).toBe(401);
    expect((await anon().get("/v1/payment-requests").set("Cookie", "pl_session=forged")).status).toBe(401);
    // A bad Authorization header is never rescued by a valid cookie.
    expect((await m.agent.get("/v1/payment-requests").set("Authorization", "Bearer pl_test_bad")).status).toBe(401);
  });
});

describe("listing", () => {
  it("paginates requests with an opaque cursor and filters by status, wallet, date and q", async () => {
    const { merchant, wallet } = await setupMerchant(t);
    const second = await addVerifiedWallet(merchant);
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await createRequest(merchant, i === 4 ? second : wallet, { customerRef: `order-${i}` }));
    const e = makeEngine();
    await e.ingestion.tick();
    await e.pay({ to: wallet.address, amountStroops: USDC(50), memoRaw: made[0]!.memo });

    const page1 = await merchant.agent.get("/v1/payment-requests?limit=2");
    expect(page1.body.data.map((r: { id: string }) => r.id)).toEqual([made[4]!.id, made[3]!.id]);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    const page2 = await merchant.agent.get(`/v1/payment-requests?limit=2&cursor=${page1.body.nextCursor}`);
    const page3 = await merchant.agent.get(`/v1/payment-requests?limit=2&cursor=${page2.body.nextCursor}`);
    expect(page2.body.data.map((r: { id: string }) => r.id)).toEqual([made[2]!.id, made[1]!.id]);
    expect(page3.body.data.map((r: { id: string }) => r.id)).toEqual([made[0]!.id]);
    expect(page3.body.nextCursor).toBeNull();

    expect((await merchant.agent.get("/v1/payment-requests?status=PAID")).body.data).toMatchObject([{ id: made[0]!.id }]);
    expect((await merchant.agent.get(`/v1/payment-requests?walletId=${second.id}`)).body.data).toMatchObject([{ id: made[4]!.id }]);
    expect((await merchant.agent.get("/v1/payment-requests?q=ORDER-3")).body.data).toMatchObject([{ id: made[3]!.id }]);
    expect((await merchant.agent.get(`/v1/payment-requests?q=${made[2]!.memo.toLowerCase()}`)).body.data).toMatchObject([{ id: made[2]!.id }]);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await merchant.agent.get(`/v1/payment-requests?from=${encodeURIComponent(future)}`)).body.data).toEqual([]);
    expect((await merchant.agent.get(`/v1/payment-requests?to=${encodeURIComponent(future)}`)).body.data).toHaveLength(5);

    for (const bad of ["limit=0", "limit=101", "limit=abc", "status=DONE", "cursor=garbage", "from=yesterday", "sort=asc", "limit=1&limit=2"]) {
      const res = await merchant.agent.get(`/v1/payment-requests?${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("request stats count per status under the list's filters; search also matches the description", async () => {
    const { merchant, wallet } = await setupMerchant(t);
    const a = await createRequest(merchant, wallet, { description: "Party jollof tray", customerRef: "ord-1" });
    await createRequest(merchant, wallet, { description: "Zobo, 6 bottles", customerRef: "ord-2" });
    const c = await createRequest(merchant, wallet, { description: "Jollof rice for four" });
    await merchant.agent.post(`/v1/payment-requests/${c.id}/cancel`).set("Origin", ORIGIN);
    const e = makeEngine();
    await e.ingestion.tick();
    await e.pay({ to: wallet.address, amountStroops: USDC(50), memoRaw: a.memo });

    const all = await merchant.agent.get("/v1/payment-requests/stats");
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ total: 3, byStatus: { PENDING: 1, UNDERPAID: 0, PAID: 1, OVERPAID: 0, EXPIRED: 0, CANCELLED: 1, NETWORK_RESET: 0 } });
    const jollof = await merchant.agent.get("/v1/payment-requests/stats?q=jollof");
    expect(jollof.body).toMatchObject({ total: 2, byStatus: { PAID: 1, CANCELLED: 1, PENDING: 0 } });
    expect((await merchant.agent.get("/v1/payment-requests?q=JOLLOF")).body.data).toHaveLength(2);
    const future = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
    expect((await merchant.agent.get(`/v1/payment-requests/stats?from=${future}`)).body.total).toBe(0);
    expect((await merchant.agent.get("/v1/payment-requests/stats?status=PAID")).status).toBe(400);
    // Another merchant's requests are never counted.
    const other = await setupMerchant(t, "Other");
    expect((await other.merchant.agent.get("/v1/payment-requests/stats")).body.total).toBe(0);
  });

  it("summary: collected per asset, requests settled, open requests and what needs the merchant", async () => {
    const { merchant, wallet } = await setupMerchant(t);
    const e = makeEngine();
    await e.ingestion.tick();
    const from = encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString());
    const get = () => merchant.agent.get(`/v1/summary?from=${from}`);
    expect((await get()).body).toMatchObject({ collected: [], requests: { created: 0, settled: 0 }, open: { count: 0, underpaid: 0, nextExpiresAt: null }, needsYou: { unmatched: 0, refunds: 0, refundRequests: [] } });

    const paid = await createRequest(merchant, wallet);
    const part = await createRequest(merchant, wallet, { amount: "120", expiresInMinutes: 10 });
    await createRequest(merchant, wallet, { amount: "9" });
    const xlm = await createRequest(merchant, wallet, { asset: "XLM", amount: "5" });
    await e.pay([
      { to: wallet.address, amountStroops: USDC(50), memoRaw: paid.memo },
      { to: wallet.address, amountStroops: USDC(100), memoRaw: part.memo },
      { to: wallet.address, amountStroops: 50_000_000n, memoRaw: xlm.memo, assetCode: "XLM", assetIssuer: null },
      { to: wallet.address, amountStroops: USDC(15) }, // no memo
      { to: wallet.address, amountStroops: USDC(50), memoRaw: paid.memo }, // duplicate: refund owed
    ]);
    const res = await get();
    expect(res.status).toBe(200);
    const byCode = Object.fromEntries(res.body.collected.map((c: { asset: { code: string }; amount: string; payments: number }) => [c.asset.code, [c.amount, c.payments]]));
    expect(byCode).toEqual({ USDC: ["150.0000000", 2], XLM: ["5.0000000", 1] });
    expect(res.body.requests).toEqual({ created: 4, settled: 2 });
    expect(res.body.open).toMatchObject({ count: 2, underpaid: 1 });
    expect(new Date(res.body.open.nextExpiresAt).getTime()).toBeLessThan(Date.now() + 11 * 60_000);
    expect(res.body.needsYou).toMatchObject({ unmatched: 1, refunds: 1 });
    expect(res.body.needsYou.refundRequests).toMatchObject([{ id: paid.id, refundOwed: true }]);

    // Payments before `from` are not counted as collected.
    const later = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
    expect((await merchant.agent.get(`/v1/summary?from=${later}`)).body).toMatchObject({ collected: [], requests: { created: 0, settled: 0 } });
    expect((await merchant.agent.get("/v1/summary")).status).toBe(400);
    const other = await setupMerchant(t, "Other");
    expect((await other.merchant.agent.get(`/v1/summary?from=${from}`)).body).toMatchObject({ collected: [], needsYou: { unmatched: 0, refunds: 0 } });
  });

  it("payments can be listed for a day by ledger close time", async () => {
    const { merchant, wallet } = await setupMerchant(t);
    const e = makeEngine();
    await e.ingestion.tick();
    const day = 24 * 3_600_000;
    await e.pay({ to: wallet.address, amountStroops: USDC(1) }, new Date(Date.now() - day - 3_600_000)); // yesterday
    await e.pay({ to: wallet.address, amountStroops: USDC(2) }, new Date(Date.now() - 60_000)); // today
    const iso = (ms: number) => encodeURIComponent(new Date(ms).toISOString());
    const today = await merchant.agent.get(`/v1/payments?from=${iso(Date.now() - day / 2)}`);
    expect(today.body.data).toMatchObject([{ amount: "2.0000000" }]);
    const yesterday = await merchant.agent.get(`/v1/payments?from=${iso(Date.now() - 2 * day)}&to=${iso(Date.now() - day / 2)}`);
    expect(yesterday.body.data).toMatchObject([{ amount: "1.0000000" }]);
    expect((await merchant.agent.get("/v1/payments?from=today")).status).toBe(400);
  });

  it("lists payments with outcome, wallet and unmatched filters, newest first", async () => {
    const { merchant, wallet } = await setupMerchant(t);
    const req = await createRequest(merchant, wallet);
    const e = makeEngine();
    await e.ingestion.tick();
    await e.pay({ to: wallet.address, amountStroops: USDC(50), memoRaw: req.memo });
    await e.pay({ to: wallet.address, amountStroops: USDC(1) });
    await e.pay({ to: wallet.address, amountStroops: USDC(2), memoRaw: req.memo });
    const all = await merchant.agent.get("/v1/payments");
    expect(all.body.data.map((p: { outcome: string }) => p.outcome)).toEqual(["DUPLICATE", "NO_MEMO", "COUNTED"]);
    expect(all.body.data[0]).toMatchObject({ amount: "2.0000000", amountStroops: "20000000", requestId: req.id });
    expect((await merchant.agent.get("/v1/payments?outcome=COUNTED")).body.data).toHaveLength(1);
    expect((await merchant.agent.get("/v1/payments?unmatched=true")).body.data).toHaveLength(1);
    expect((await merchant.agent.get(`/v1/payments?walletId=${wallet.id}&limit=2`)).body.nextCursor).toEqual(expect.any(String));
    expect((await merchant.agent.get("/v1/payments?outcome=NOPE")).status).toBe(400);
  });
});

describe("tenant isolation", () => {
  // One check per /v1 route: merchant A gets 404 for merchant B's ids, and B's data is untouched.
  async function world() {
    const a = await setupMerchant(t, "A");
    const b = await setupMerchant(t, "B");
    const bRequest = await createRequest(b.merchant, b.wallet);
    const bKey = await b.merchant.agent.post("/v1/api-keys").set("Origin", ORIGIN).send({ name: "b" });
    const e = makeEngine();
    await e.ingestion.tick();
    const [bPayment] = await e.pay({ to: b.wallet.address, amountStroops: USDC(5) });
    const aRequest = await createRequest(a.merchant, a.wallet);
    const [aPayment] = await e.pay({ to: a.wallet.address, amountStroops: USDC(5) });
    return { a, b, bRequest, bKeyId: bKey.body.apiKey.id as string, bPayment: bPayment!, aRequest, aPayment: aPayment! };
  }
  const expect404 = (res: request.Response) => {
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  };

  it("GET /v1/payment-requests/:id", async () => {
    const w = await world();
    expect404(await w.a.merchant.agent.get(`/v1/payment-requests/${w.bRequest.id}`));
  });
  it("GET /v1/payment-requests lists only the caller's requests", async () => {
    const w = await world();
    const list = await w.a.merchant.agent.get("/v1/payment-requests");
    expect(list.body.data.map((r: { id: string }) => r.id)).toEqual([w.aRequest.id]);
    expect((await w.a.merchant.agent.get(`/v1/payment-requests?walletId=${w.b.wallet.id}`)).body.data).toEqual([]);
  });
  it("POST /v1/payment-requests on another merchant's wallet", async () => {
    const w = await world();
    expect404(await w.a.merchant.agent.post("/v1/payment-requests").set("Origin", ORIGIN).send({ walletId: w.b.wallet.id, amount: "1", asset: "XLM" }));
  });
  it("POST /v1/payment-requests/:id/cancel", async () => {
    const w = await world();
    expect404(await w.a.merchant.agent.post(`/v1/payment-requests/${w.bRequest.id}/cancel`).set("Origin", ORIGIN));
    expect((await prisma.paymentRequest.findUniqueOrThrow({ where: { id: w.bRequest.id } })).status).toBe("PENDING");
  });
  it("POST /v1/payment-requests/:id/accept", async () => {
    const w = await world();
    expect404(await w.a.merchant.agent.post(`/v1/payment-requests/${w.bRequest.id}/accept`).set("Origin", ORIGIN));
  });
  it("GET /v1/payments lists only payments to the caller's wallets", async () => {
    const w = await world();
    const list = await w.a.merchant.agent.get("/v1/payments");
    expect(list.body.data.map((p: { eventId: string }) => p.eventId)).toEqual([w.aPayment.eventId]);
    expect((await w.a.merchant.agent.get(`/v1/payments?walletId=${w.b.wallet.id}`)).body.data).toEqual([]);
  });
  it("POST /v1/payments/:eventId/assign with another merchant's payment or request", async () => {
    const w = await world();
    expect404(await w.a.merchant.agent.post(`/v1/payments/${w.bPayment.eventId}/assign`).set("Origin", ORIGIN).send({ requestId: w.aRequest.id }));
    expect404(await w.a.merchant.agent.post(`/v1/payments/${w.aPayment.eventId}/assign`).set("Origin", ORIGIN).send({ requestId: w.bRequest.id }));
    expect((await prisma.chainPayment.findUniqueOrThrow({ where: { eventId: w.bPayment.eventId } })).requestId).toBeNull();
  });
  it("POST /v1/payments/:eventId/refunded and POST /v1/payment-requests/:id/refunded", async () => {
    const w = await world();
    expect404(await w.a.merchant.agent.post(`/v1/payments/${w.bPayment.eventId}/refunded`).set("Origin", ORIGIN).send({}));
    expect404(await w.a.merchant.agent.post(`/v1/payment-requests/${w.bRequest.id}/refunded`).set("Origin", ORIGIN).send({}));
    expect((await prisma.chainPayment.findUniqueOrThrow({ where: { eventId: w.bPayment.eventId } })).refundedAt).toBeNull();
  });
  it("GET /v1/wallets lists only the caller's wallets", async () => {
    const w = await world();
    const list = await w.a.merchant.agent.get("/v1/wallets");
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([w.a.wallet.id]);
  });
  it("POST /v1/wallets/:id/refresh", async () => {
    const w = await world();
    expect404(await w.a.merchant.agent.post(`/v1/wallets/${w.b.wallet.id}/refresh`).set("Origin", ORIGIN));
  });
  it("POST /v1/wallets/:id/challenge", async () => {
    const w = await world();
    expect404(await w.a.merchant.agent.post(`/v1/wallets/${w.b.wallet.id}/challenge`).set("Origin", ORIGIN));
  });
  it("POST /v1/wallets/:id/verify (even with a signature from the real owner's key)", async () => {
    const w = await world();
    const challenge = await w.b.merchant.agent.post(`/v1/wallets/${w.b.wallet.id}/challenge`).set("Origin", ORIGIN);
    const signature = Buffer.from(w.b.wallet.keypair.signMessage(challenge.body.message)).toString("base64");
    expect404(await w.a.merchant.agent.post(`/v1/wallets/${w.b.wallet.id}/verify`).set("Origin", ORIGIN).send({ challengeId: challenge.body.challengeId, signature }));
  });
  it("DELETE /v1/wallets/:id", async () => {
    const w = await world();
    expect404(await w.a.merchant.agent.delete(`/v1/wallets/${w.b.wallet.id}`).set("Origin", ORIGIN));
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: w.b.wallet.id } })).deletedAt).toBeNull();
  });
  it("GET /v1/api-keys lists only the caller's keys; DELETE /v1/api-keys/:id", async () => {
    const w = await world();
    expect((await w.a.merchant.agent.get("/v1/api-keys")).body.data).toEqual([]);
    expect404(await w.a.merchant.agent.delete(`/v1/api-keys/${w.bKeyId}`).set("Origin", ORIGIN));
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: w.bKeyId } })).revokedAt).toBeNull();
  });
});

describe("platform", () => {
  it("health reports DB status, last processed ledger, lag and open requests", async () => {
    const empty = await anon().get("/health");
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ status: "ok", db: "up", network: "testnet", lastProcessedLedger: null, lagSeconds: null, openRequests: 0 });
    const { merchant, wallet } = await setupMerchant(t);
    await createRequest(merchant, wallet);
    const e = makeEngine();
    await e.ingestion.tick();
    e.source.closeLedger(new Date(Date.now() - 30_000));
    await e.ingestion.tick();
    const res = await anon().get("/health");
    expect(res.body).toMatchObject({ lastProcessedLedger: 1001, openRequests: 1 });
    expect(res.body.lagSeconds).toBeGreaterThanOrEqual(29);
    expect(res.body.lagSeconds).toBeLessThan(40);
  });

  it("every error uses the shared shape with a request id; unknown routes are NOT_FOUND", async () => {
    const res = await anon().get("/nope").set("X-Request-Id", "req-abc_123");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "NOT_FOUND", message: "Route not found", details: [], requestId: "req-abc_123" } });
    expect(res.headers["x-request-id"]).toBe("req-abc_123");
    const generated = await anon().get("/nope").set("X-Request-Id", "bad id\twith junk");
    expect(generated.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated.body.error.requestId).toBe(generated.headers["x-request-id"]);
  });

  it("sends hardening headers and hides the framework", async () => {
    const res = await anon().get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toMatch(/max-age=/);
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("serves the OpenAPI document and the Scalar reference", async () => {
    const spec = await anon().get("/openapi.json");
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe("3.0.3");
    const paths = Object.keys(spec.body.paths);
    for (const path of [
      "/v1/payment-requests", "/v1/payment-requests/stats", "/v1/payment-requests/{id}", "/v1/payment-requests/{id}/cancel", "/v1/payment-requests/{id}/accept", "/v1/payment-requests/{id}/refunded",
      "/v1/payments", "/v1/payments/{eventId}/assign", "/v1/payments/{eventId}/refunded", "/v1/summary",
      "/public/pay/{publicId}", "/public/pay/{publicId}/events", "/health",
    ]) {
      expect(paths, path).toContain(path);
    }
    // The published reference is for API-key users: nothing that needs the dashboard session.
    expect(paths.filter((p) => p.startsWith("/auth") || p.startsWith("/v1/api-keys") || p.startsWith("/v1/wallets") || p === "/v1/stream")).toEqual([]);
    expect(Object.keys(spec.body.components.securitySchemes)).toEqual(["apiKey"]);
    expect(JSON.stringify(spec.body)).not.toContain("pl_session");
    expect(spec.body.servers[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(spec.body.components.schemas.PaymentRequest.properties.amount).toEqual({ type: "string" });
    const docs = await anon().get("/docs");
    expect(docs.status).toBe(200);
    expect(docs.headers["content-type"]).toMatch(/html/);
    expect(docs.text).toContain("/openapi.json");
  });

  it("rate limits with 429 RATE_LIMITED and Retry-After: 5/min on credentials, per merchant on /v1, per IP on public", async () => {
    const limited = makeApp({ authPerMin: 5, v1PerMin: 3, publicPerMin: 2 });
    let n = 0; // a fresh email each time, so only the per-IP limit is in play
    const login = () => request(limited.app).post("/auth/login").set("Origin", ORIGIN).send({ email: `x${n++}@y.example`, password: "whatever it is" });
    for (let i = 0; i < 5; i++) expect((await login()).status).toBe(401);
    const blocked = await login();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(Number.parseInt(blocked.headers["retry-after"] as string, 10)).toBeGreaterThan(0);

    const a = await signup(t);
    const b = await signup(t);
    const cookieOf = async (email: string, password: string) => {
      const res = await request(t.app).post("/auth/login").set("Origin", ORIGIN).send({ email, password });
      return String(res.headers["set-cookie"]).split(";")[0] as string;
    };
    const cookieA = await cookieOf(a.email, a.password);
    const cookieB = await cookieOf(b.email, b.password);
    for (let i = 0; i < 3; i++) expect((await request(limited.app).get("/v1/payment-requests").set("Cookie", cookieA)).status).toBe(200);
    expect((await request(limited.app).get("/v1/payment-requests").set("Cookie", cookieA)).status).toBe(429);
    // The limit is per merchant: B is unaffected by A's burst.
    expect((await request(limited.app).get("/v1/payment-requests").set("Cookie", cookieB)).status).toBe(200);

    for (let i = 0; i < 2; i++) expect((await request(limited.app).get("/public/pay/aaaaaaaaaaaa")).status).toBe(404);
    expect((await request(limited.app).get("/public/pay/aaaaaaaaaaaa")).status).toBe(429);
  });
});
