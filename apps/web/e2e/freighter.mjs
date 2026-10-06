// Drives the real "Verify with Freighter" and "Pay with Freighter" buttons. The app's own
// code and the real @stellar/freighter-api library run unchanged; only the browser extension
// is replaced by a stand-in that answers the library's messages and signs with a real key.
import { chromium } from "playwright-core";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";

const WEB = process.env.WEB_URL ?? "http://localhost:3000", API = process.env.API_URL ?? "http://localhost:4100";
const shots = new URL("./shots/", import.meta.url).pathname;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const problems = [];
const check = (ok, what) => { log(ok ? "  ok  " : "  FAIL", what); if (!ok) problems.push(what); };

async function friendbot(addr) {
  for (let i = 0; i < 5; i++) {
    try { const r = await fetch(`https://friendbot.stellar.org?addr=${addr}`, { signal: AbortSignal.timeout(60000) }); if (r.ok || r.status === 400) return; } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("friendbot failed");
}

/** The stand-in extension. `state.mode` and `state.key` are changed between steps. */
async function installFreighter(context, state) {
  const REJECT = { apiError: { code: -4, message: "The user rejected this request." } };
  await context.exposeBinding("__freighter", (_src, msg) => {
    state.calls.push(msg.type);
    if (state.mode === "absent") return null; // no extension: never answers
    switch (msg.type) {
      case "REQUEST_CONNECTION_STATUS": return { isConnected: true };
      case "REQUEST_ACCESS": return state.mode === "rejectAccess" ? REJECT : { publicKey: state.key.publicKey() };
      case "REQUEST_NETWORK_DETAILS": return { networkDetails: state.mode === "mainnet"
        ? { network: "PUBLIC", networkName: "Main Net", networkUrl: "https://horizon.stellar.org", networkPassphrase: Networks.PUBLIC }
        : { network: "TESTNET", networkName: "Test Net", networkUrl: "https://horizon-testnet.stellar.org", networkPassphrase: Networks.TESTNET } };
      case "SUBMIT_BLOB":
        if (state.mode === "rejectSign") return REJECT;
        state.signedMessages.push(msg.blob);
        return { signedBlob: Buffer.from(state.key.signMessage(msg.blob)).toString("base64"), signerAddress: state.key.publicKey() };
      case "SUBMIT_TRANSACTION": {
        if (state.mode === "rejectSign") return REJECT;
        const tx = TransactionBuilder.fromXDR(msg.transactionXdr, msg.networkPassphrase);
        state.signedTxs.push(tx);
        tx.sign(state.key);
        return { signedTransaction: tx.toXDR(), signerAddress: state.key.publicKey() };
      }
      default: return {};
    }
  });
  await context.addInitScript(() => {
    window.addEventListener("message", async (ev) => {
      const d = ev.data;
      if (ev.source !== window || !d || d.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") return;
      const res = await window.__freighter(d);
      if (res) window.postMessage({ source: "FREIGHTER_EXTERNAL_MSG_RESPONSE", messagedId: d.messageId, ...res }, window.location.origin);
    });
  });
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const walletKey = Keypair.random(), payer = Keypair.random(), poor = Keypair.random(), stranger = Keypair.random();
  log("funding wallet + payer"); await friendbot(walletKey.publicKey()); await friendbot(payer.publicKey());

  // ---------- merchant: verify the wallet through the UI
  const fx = { mode: "absent", key: walletKey, calls: [], signedMessages: [], signedTxs: [] };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installFreighter(ctx, fx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push("pageerror: " + String(e).slice(0, 200)));
  const email = `fx-${Date.now()}@example.com`;
  await page.goto(WEB + "/signup");
  await page.getByLabel("Business name").fill("Ada's Kitchen"); await page.getByLabel("Work email").fill(email); await page.locator("#pw").fill("e2e password 12345"); await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click(); await page.waitForURL(/\/get-started/);
  await page.goto(WEB + "/wallets", { waitUntil: "networkidle" });
  await page.getByLabel(/public address/i).fill(walletKey.publicKey()); await page.getByLabel(/label/i).fill("Main wallet");
  await page.getByRole("button", { name: /add wallet/i }).last().click();
  const verifyBtn = page.getByRole("button", { name: /verify with freighter/i }).first();
  await verifyBtn.waitFor({ timeout: 15000 });
  const tryVerify = async (mode, key, expectText) => {
    fx.mode = mode; fx.key = key;
    await verifyBtn.click();
    const seen = await page.getByText(expectText).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    check(seen, `verify, Freighter ${mode}: shows ${expectText}`);
    await page.screenshot({ path: `${shots}fx-verify-${mode}.png` });
  };
  log("wallet verification");
  await tryVerify("absent", walletKey, /isn't installed/i);
  await tryVerify("rejectAccess", walletKey, /rejected the request/i);
  await tryVerify("mainnet", walletKey, /switch it to testnet/i);
  await tryVerify("ok", stranger, /different account/i); // Freighter has another account selected
  await tryVerify("rejectSign", walletKey, /rejected the request/i);
  const unverified = await page.evaluate(async (API) => (await (await fetch(API + "/v1/wallets", { credentials: "include" })).json()).data[0].verified, API);
  check(unverified === false, "wallet is still unverified after five failed attempts");
  fx.mode = "ok"; fx.key = walletKey; fx.signedMessages.length = 0;
  await verifyBtn.click();
  await page.getByText("Verified", { exact: true }).first().waitFor({ timeout: 20000 });
  const wallets = await page.evaluate(async (API) => (await (await fetch(API + "/v1/wallets", { credentials: "include" })).json()).data, API);
  check(wallets[0].verified === true, "verify, Freighter ok: the API now reports the wallet verified");
  check(fx.signedMessages.length === 1 && fx.signedMessages[0].startsWith("PayLink wallet verification") && fx.signedMessages[0].includes(walletKey.publicKey()), "the message Freighter was asked to sign is the PayLink challenge naming this wallet");
  await page.screenshot({ path: `${shots}fx-verify-done.png` });

  // ---------- create a request (API, as the signed-in merchant)
  const made = await page.evaluate(async ([API, walletId]) => (await (await fetch(API + "/v1/payment-requests", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ walletId, amount: "12.5", asset: "XLM", description: "Order #1050 · Zobo, 6 bottles" }) })).json()).request, [API, wallets[0].id]);

  // ---------- customer: pay with Freighter on the checkout
  const pfx = { mode: "absent", key: payer, calls: [], signedMessages: [], signedTxs: [] };
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  await installFreighter(phone, pfx);
  const pay = await phone.newPage();
  pay.on("pageerror", (e) => problems.push("checkout pageerror: " + String(e).slice(0, 200)));
  await pay.goto(`${WEB}/pay/${made.publicId}`); await pay.getByRole("heading", { name: /Ada.s Kitchen/ }).waitFor({ timeout: 15000 });
  check(await pay.getByRole("img", { name: /wallet ownership verified/i }).isVisible(), "checkout shows the verified-wallet badge");
  const payBtn = pay.getByRole("button", { name: /pay 12\.50 xlm with freighter/i });
  const tryPay = async (mode, key, expectText) => {
    pfx.mode = mode; pfx.key = key;
    await payBtn.click();
    const seen = await pay.getByText(expectText).first().waitFor({ timeout: 25000 }).then(() => true).catch(() => false);
    check(seen, `pay, Freighter ${mode}${key === poor ? " (unfunded account)" : ""}: shows ${expectText}`);
    await pay.screenshot({ path: `${shots}fx-pay-${mode}${key === poor ? "-unfunded" : ""}.png` });
    await payBtn.waitFor({ timeout: 10000 });
  };
  log("pay with Freighter");
  await tryPay("absent", payer, /isn't installed/i);
  await tryPay("mainnet", payer, /switch it to testnet/i);
  await tryPay("ok", poor, /isn't funded on testnet/i);
  await tryPay("rejectSign", payer, /rejected the request/i);
  const before = await (await fetch(`${API}/public/pay/${made.publicId}`)).json();
  check(before.status === "PENDING" && before.amountReceived === "0.0000000", "nothing was sent by any failed attempt");

  pfx.mode = "ok"; pfx.key = payer; pfx.signedTxs.length = 0;
  await payBtn.click();
  await pay.getByText(/confirming on stellar/i).waitFor({ timeout: 30000 }).then(() => check(true, "after Freighter approves: 'Confirming on Stellar…'")).catch(() => check(false, "confirming state shown"));
  await pay.screenshot({ path: `${shots}fx-pay-confirming.png` });
  const tx = pfx.signedTxs[0];
  const op = tx?.operations[0];
  check(tx && tx.operations.length === 1 && op.type === "payment" && op.destination === walletKey.publicKey() && op.amount === "12.5000000" && op.asset.isNative(), "the transaction Freighter was asked to sign pays exactly 12.5 XLM to the business wallet");
  check(tx && tx.memo.type === "text" && Buffer.from(tx.memo.value).toString("utf8") === made.memo, "…and carries the request's text memo");
  check(tx && tx.networkPassphrase === Networks.TESTNET, "…on Testnet");
  await pay.getByText("PAID", { exact: true }).waitFor({ timeout: 60000 }).then(() => check(true, "checkout flipped to PAID by itself")).catch(() => check(false, "checkout flipped to PAID"));
  await pay.getByText("Network fee").waitFor({ timeout: 15000 }).then(async () => check(/0\.000\d+ XLM/.test(await pay.getByText(/0\.000\d+ XLM/).first().innerText()), "receipt shows the real network fee from Stellar")).catch(() => check(false, "network fee row shown"));
  await pay.screenshot({ path: `${shots}fx-pay-paid.png` });
  const after = await (await fetch(`${API}/public/pay/${made.publicId}`)).json();
  check(after.status === "PAID" && after.amountReceived === "12.5000000" && Boolean(after.paidAt), "API: request is PAID for 12.5 XLM with a paid time");

  // ---------- settings shows the session's last-active time for another device
  const other = await browser.newContext();
  const op2 = await other.newPage(); await op2.goto(WEB + "/login"); await op2.getByLabel("Email").fill(email); await op2.locator("#pw").fill("e2e password 12345"); await op2.getByRole("button", { name: "Sign in" }).click(); await op2.waitForURL(/\/dashboard/);
  await page.goto(WEB + "/settings", { waitUntil: "networkidle" });
  check(await page.getByText(/active (just now|\d+ min ago)/i).first().isVisible().catch(() => false), "settings lists the other device with when it was last active");
  await page.screenshot({ path: `${shots}fx-settings-sessions.png`, fullPage: true });
} catch (e) {
  problems.push("FATAL: " + (e.stack || e).toString().slice(0, 700));
} finally {
  await browser.close();
  console.log("\nPROBLEMS (" + problems.length + "):\n" + (problems.join("\n") || "none"));
  process.exit(problems.length ? 1 : 0);
}
