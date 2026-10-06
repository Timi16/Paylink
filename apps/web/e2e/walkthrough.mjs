import { chromium } from "playwright-core";
import { Keypair, Horizon, TransactionBuilder, Operation, Asset, Memo, Networks, BASE_FEE } from "@stellar/stellar-sdk";

const WEB = process.env.WEB_URL ?? "http://localhost:3000", API = process.env.API_URL ?? "http://localhost:4100";
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
const shots = new URL("./shots/", import.meta.url).pathname;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const problems = [];

async function friendbot(addr) {
  for (let i = 0; i < 5; i++) {
    try { const r = await fetch(`https://friendbot.stellar.org?addr=${addr}`, { signal: AbortSignal.timeout(60000) }); if (r.ok || r.status === 400) return; } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("friendbot failed");
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const watch = (p, name) => {
  p.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource: the server responded with a status of 401/.test(m.text())) problems.push(`[${name}] console: ${m.text().slice(0, 300)}`); });
  p.on("pageerror", (e) => problems.push(`[${name}] pageerror: ${String(e).slice(0, 300)}`));
  p.on("response", (r) => { if (r.status() >= 500) problems.push(`[${name}] ${r.status()} ${r.url()}`); });
};
watch(page, "app");
const shot = (p, name) => p.screenshot({ path: `${shots}${name}.png`, fullPage: true });

try {
  const walletKey = Keypair.random(), payer = Keypair.random();
  log("funding wallet + payer"); await friendbot(walletKey.publicKey()); await friendbot(payer.publicKey());

  log("landing"); await page.goto(WEB + "/", { waitUntil: "networkidle" }); await shot(page, "01-landing");
  if (!(await page.getByRole("link", { name: /get started|create|sign up/i }).first().isVisible())) problems.push("landing: no sign-up CTA");

  log("guard: /dashboard signed out -> /login"); await page.goto(WEB + "/dashboard"); await page.waitForURL(/\/login/); await shot(page, "02-login");

  log("signup"); await page.goto(WEB + "/signup");
  await page.getByRole("button", { name: "Create account" }).click();
  if (!(await page.getByText("Enter the name customers know you by.").isVisible())) problems.push("signup: validation message missing");
  const email = `e2e-${Date.now()}@example.com`;
  await page.getByLabel("Business name").fill("Ada's Kitchen");
  await page.getByLabel("Work email").fill(email);
  await page.locator("#pw").fill("e2e password 12345");
  await page.getByRole("checkbox").check();
  await shot(page, "03-signup");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/get-started/, { timeout: 15000 });
  await page.waitForLoadState("networkidle"); await shot(page, "04-get-started");

  log("add wallet via UI");
  await page.getByLabel(/public address/i).fill(walletKey.secret());
  await page.waitForTimeout(300);
  if (!(await page.getByText(/secret key/i).first().isVisible())) problems.push("wallet form: no secret-key warning");
  await shot(page, "05-secret-warning");
  await page.getByLabel(/public address/i).fill(walletKey.publicKey());
  await page.getByLabel(/label/i).fill("Main wallet");
  await page.getByRole("button", { name: /add wallet/i }).click();
  await page.getByText(/prove the wallet is yours/i).waitFor({ timeout: 15000 });
  await page.waitForLoadState("networkidle"); await shot(page, "06-wallet-added");

  log("verify wallet (signing in Node; Freighter is not available headless)");
  const call = (method, path, body) => page.evaluate(async ([API, method, path, body]) => {
    const r = await fetch(API + path, { method, credentials: "include", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: r.status === 204 ? null : await r.json() };
  }, [API, method, path, body]);
  let wallets = await call("GET", "/v1/wallets");
  for (let i = 0; i < 20 && wallets.body.data.length === 0; i++) { await page.waitForTimeout(500); wallets = await call("GET", "/v1/wallets"); }
  const wid = wallets.body.data[0].id;
  const ch = await call("POST", `/v1/wallets/${wid}/challenge`);
  const signature = Buffer.from(walletKey.signMessage(ch.body.message)).toString("base64");
  const ver = await call("POST", `/v1/wallets/${wid}/verify`, { challengeId: ch.body.challengeId, signature });
  if (ver.status !== 200) throw new Error("verify failed " + JSON.stringify(ver.body));
  await page.reload({ waitUntil: "networkidle" }); await shot(page, "07-verified");

  log("wallets page"); await page.goto(WEB + "/wallets", { waitUntil: "networkidle" }); await page.getByText("Main wallet").first().waitFor(); await shot(page, "08-wallets");

  log("new request via UI"); await page.goto(WEB + "/requests/new", { waitUntil: "networkidle" });
  await page.getByText("XLM", { exact: true }).first().click();
  await page.getByLabel(/^amount/i).fill("12.5");
  await page.getByLabel(/description/i).fill("Order #1042 · Jollof rice for four");
  await shot(page, "09-new-request");
  await page.getByRole("button", { name: /create/i }).last().click();
  await page.getByText("Request created").waitFor({ timeout: 15000 });
  await shot(page, "10-request-created");
  const list = await call("GET", "/v1/payment-requests?limit=1");
  const req = list.body.data[0];
  log("request", req.memo, req.checkoutUrl);

  log("checkout page (phone)");
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const pay = await phoneCtx.newPage(); watch(pay, "checkout");
  await pay.goto(`${WEB}/pay/${req.publicId}`, { waitUntil: "domcontentloaded" });
  await pay.getByRole("heading", { name: /Ada.s Kitchen/ }).waitFor({ timeout: 15000 });
  await pay.waitForTimeout(1500); await shot(pay, "11-checkout-open");
  for (const tab of [/scan qr/i, /pay manually/i]) { const t = pay.getByRole("tab", { name: tab }).or(pay.getByRole("button", { name: tab })); if (await t.first().isVisible().catch(() => false)) { await t.first().click(); await pay.waitForTimeout(600); await shot(pay, `12-checkout-${String(tab).replace(/\W/g, "").slice(0, 6)}`); } else problems.push(`checkout: tab ${tab} not found`); }
  const nf = await phoneCtx.newPage(); await nf.goto(`${WEB}/pay/aaaaaaaaaaaa`); await nf.getByText(/can't find this payment link/i).waitFor({ timeout: 10000 }); await shot(nf, "13-checkout-notfound"); await nf.close();

  log("paying 5 of 12.5 XLM on testnet (partial)");
  const send = async (amount) => {
    const acct = await horizon.loadAccount(payer.publicKey());
    const tx = new TransactionBuilder(acct, { fee: String(Number.parseInt(BASE_FEE, 10) * 100), networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: walletKey.publicKey(), asset: Asset.native(), amount })).addMemo(Memo.text(req.memo)).setTimeout(120).build();
    tx.sign(payer); return (await horizon.submitTransaction(tx)).hash;
  };
  await send("5");
  await pay.getByText(/5\.00 of 12\.50 received/i).waitFor({ timeout: 60000 }); log("checkout shows part-paid, no reload"); await shot(pay, "14-checkout-underpaid");
  log("paying the remaining 7.5");
  const hash = await send("7.5");
  await pay.getByText("PAID", { exact: true }).waitFor({ timeout: 60000 }); log("checkout flipped to PAID, no reload"); await pay.waitForTimeout(800); await shot(pay, "15-checkout-paid");
  if (!(await pay.getByRole("link", { name: new RegExp(hash.slice(0, 4), "i") }).first().isVisible().catch(() => false))) problems.push("checkout: paid tx link not shown");

  log("dashboard reflects it");
  await page.goto(WEB + "/dashboard", { waitUntil: "networkidle" }); await page.getByText("Latest requests").waitFor();
  await page.getByText("Paid", { exact: true }).first().waitFor({ timeout: 15000 }); await shot(page, "16-dashboard");
  if (!(await page.getByText("12.50").first().isVisible())) problems.push("dashboard: collected amount not shown");

  log("unmatched: pay with no memo, expect it to appear live");
  await page.goto(WEB + "/unmatched", { waitUntil: "networkidle" }); await page.getByText(/all caught up/i).waitFor({ timeout: 10000 }); await shot(page, "17-unmatched-empty");
  const acct = await horizon.loadAccount(payer.publicKey());
  const tx = new TransactionBuilder(acct, { fee: "10000", networkPassphrase: Networks.TESTNET }).addOperation(Operation.payment({ destination: walletKey.publicKey(), asset: Asset.native(), amount: "3" })).setTimeout(120).build();
  tx.sign(payer); await horizon.submitTransaction(tx);
  await page.getByRole("button", { name: /^assign/i }).first().waitFor({ timeout: 60000 }); log("unmatched payment appeared live"); await shot(page, "18-unmatched-row");
  await page.getByRole("button", { name: /mark refunded/i }).first().click(); await page.waitForTimeout(500); await shot(page, "19-refund-dialog");
  await page.getByRole("button", { name: /yes, mark refunded/i }).click();
  await page.getByText(/all caught up/i).waitFor({ timeout: 15000 });

  for (const [path, text, name] of [["/requests", "Payment requests", "20-requests"], [`/requests/${req.id}`, "Payments to this request", "21-request-detail"], ["/payments", "Payments", "22-payments"], ["/api-keys", "API keys", "23-api-keys"], ["/settings", "Settings", "24-settings"]]) {
    log("visit", path); await page.goto(WEB + path, { waitUntil: "networkidle" }); await page.getByRole("heading", { name: text }).first().waitFor({ timeout: 15000 }); await page.waitForTimeout(500); await shot(page, name);
  }
  log("api key create"); await page.goto(WEB + "/api-keys", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /create key/i }).first().click(); await page.getByLabel("Name").fill("Storefront"); await page.getByRole("button", { name: /create key/i }).last().click();
  await page.getByText(/pl_test_[A-Za-z0-9]{20,}/).first().waitFor({ timeout: 10000 }); await shot(page, "25-key-reveal");

  log("settings save"); await page.goto(WEB + "/settings", { waitUntil: "networkidle" });
  await page.getByLabel(/support contact/i).fill("+234 801 234 5678"); await page.getByRole("button", { name: /save changes/i }).click(); await page.waitForTimeout(1200);
  const me = await call("GET", "/auth/me"); if (me.body.merchant.supportContact !== "+234 801 234 5678") problems.push("settings: support contact not saved");
  const sess = await call("GET", "/auth/sessions"); if (sess.status !== 200 || sess.body.data.length < 1) problems.push("settings: sessions not listed");

  log("mobile dashboard"); const m = await phoneCtx.newPage(); watch(m, "mobile"); await m.context().addCookies(await ctx.cookies()); await m.goto(WEB + "/dashboard", { waitUntil: "networkidle" }); await m.waitForTimeout(800); await shot(m, "26-dashboard-mobile");
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (overflow > 2) problems.push(`mobile dashboard scrolls sideways by ${overflow}px`);
  const ov2 = await pay.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (ov2 > 2) problems.push(`checkout scrolls sideways by ${ov2}px`);

  log("forgot password page"); await page.goto(WEB + "/forgot-password"); await page.getByLabel("Email").fill(email); await page.getByRole("button", { name: /send reset link/i }).click(); await page.getByText("Check your email").waitFor({ timeout: 10000 }); await shot(page, "27-forgot-sent");

  log("logout"); await page.goto(WEB + "/dashboard", { waitUntil: "networkidle" }); await page.getByRole("button", { name: "Log out" }).click(); await page.waitForURL(/\/login/, { timeout: 10000 });
  log("login again"); await page.getByLabel("Email").fill(email); await page.locator("#pw").fill("wrong password!!"); await page.getByRole("button", { name: "Sign in" }).click(); await page.getByText(/don't match/i).waitFor({ timeout: 10000 });
  await page.locator("#pw").fill("e2e password 12345"); await page.getByRole("button", { name: "Sign in" }).click(); await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  log("DONE");
} catch (e) {
  problems.push("FATAL: " + (e.stack || e).toString().slice(0, 900));
  await shot(page, "99-failure").catch(() => {});
} finally {
  await browser.close();
  console.log("\nPROBLEMS (" + problems.length + "):\n" + (problems.join("\n") || "none"));
  process.exit(problems.length ? 1 : 0);
}
