// Sign-up -> spinner on the button -> code by email -> verify-email page -> dashboard.
// Run the API in development with EMAIL_VERIFICATION=on and no SMTP_URL: the code is printed in its log.
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const WEB = process.env.WEB_URL ?? "http://localhost:3000", API = process.env.API_URL ?? "http://localhost:4100";
const API_LOG = process.env.API_LOG ?? "api.log";
const shots = new URL("./shots/", import.meta.url).pathname;
const results = [];
const check = (ok, what) => { results.push([ok, what]); console.log(ok ? "  ok  " : "  FAIL", what); };
const codeFor = (email) => { const log = readFileSync(API_LOG, "utf8"); const at = log.lastIndexOf(`"to":"${email}"`); return /code is: (\d{6})/.exec(log.slice(at))?.[1]; };

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const email = `verify-${Date.now()}@example.com`;
  await page.goto(WEB + "/signup");
  await page.getByLabel("Business name").fill("Lagoon Coffee"); await page.getByLabel("Work email").fill(email); await page.locator("#pw").fill("e2e password 12345"); await page.getByRole("checkbox").check();
  // Hold the request for two seconds so the working state can be seen.
  await page.route("**/auth/signup", async (route) => { await new Promise((r) => setTimeout(r, 2000)); await route.continue(); });
  const button = page.getByRole("button", { name: /create account|creating account/i });
  await button.click();
  await page.waitForTimeout(600);
  const state = await button.evaluate((el) => { const b = getComputedStyle(el, "::before"); return { busy: el.getAttribute("aria-busy"), disabled: el.disabled, text: el.textContent.trim(), spinner: b.content !== "none" && b.animationName === "spin", size: b.width }; });
  check(state.busy === "true" && state.disabled && state.spinner, `while the account is being created the button is disabled and shows a spinning circle (${JSON.stringify(state)})`);
  await page.screenshot({ path: `${shots}verify-1-spinner.png`, clip: { x: 860, y: 600, width: 440, height: 120 } });

  await page.waitForURL(/\/verify-email/, { timeout: 15000 });
  await page.getByRole("heading", { name: "Check your email" }).waitFor();
  check(await page.getByText(email).isVisible(), "after sign-up the verify-email page opens and names the address");
  await page.screenshot({ path: `${shots}verify-2-page.png` });

  await page.goto(WEB + "/dashboard"); await page.waitForURL(/\/verify-email/, { timeout: 10000 });
  check(true, "opening the dashboard before confirming sends you back to the code page");
  const blocked = await page.evaluate(async (API) => (await fetch(API + "/v1/wallets", { credentials: "include" })).status, API);
  check(blocked === 403, `the API refuses dashboard data until the email is confirmed (${blocked})`);

  const code = codeFor(email);
  check(/^\d{6}$/.test(code ?? ""), "a 6-digit code was emailed (read from the development mail log)");
  const wrong = code === "000000" ? "111111" : "000000";
  await page.getByLabel("Confirmation code").fill(wrong);
  await page.getByText(/That code isn't right\. 4 tries left\./).waitFor({ timeout: 10000 });
  check(true, "a wrong code is refused with the number of tries left");
  await page.screenshot({ path: `${shots}verify-3-wrong.png` });

  // Signing in again while unconfirmed lands on the same page.
  const other = await (await browser.newContext()).newPage();
  await other.goto(WEB + "/login"); await other.getByLabel("Email").fill(email); await other.locator("#pw").fill("e2e password 12345"); await other.getByRole("button", { name: "Sign in" }).click();
  await other.waitForURL(/\/verify-email/, { timeout: 15000 }); check(true, "signing in with an unconfirmed account also opens the code page");

  await page.getByLabel("Confirmation code").fill(code); // six digits submit by themselves
  await page.waitForURL(/\/get-started/, { timeout: 15000 });
  await page.getByRole("heading", { name: /let's get you paid/i }).waitFor({ timeout: 10000 });
  check(true, "the right code confirms the email and opens Get started");
  const after = await page.evaluate(async (API) => (await fetch(API + "/v1/wallets", { credentials: "include" })).status, API);
  check(after === 200, `the dashboard data now loads (${after})`);
  await page.goto(WEB + "/verify-email"); await page.waitForURL(/\/get-started/, { timeout: 10000 }); check(true, "a confirmed account is never sent back to the code page");
} catch (e) { check(false, "FATAL: " + String(e.stack || e).slice(0, 500)); }
await browser.close();
const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
