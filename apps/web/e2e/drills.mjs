// Failure drills against the pm2 stack: what happens to a real payment when things break.
import { execSync } from "node:child_process";
import { Keypair, Horizon, TransactionBuilder, Operation, Asset, Memo, Networks } from "@stellar/stellar-sdk";

const WEB = process.env.WEB_URL ?? "http://localhost:3000", API = process.env.API_URL ?? "http://localhost:4100";
const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
const sh = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const results = [];
const check = (ok, what) => { results.push([ok, what]); log(ok ? "  ok  " : "  FAIL", what); };

let cookie = "";
async function api(method, path, body) {
  const res = await fetch(API + path, { method, headers: { "content-type": "application/json", origin: WEB, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.getSetCookie?.().find((c) => c.startsWith("pl_session="));
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
async function friendbot(addr) { for (let i = 0; i < 5; i++) { try { const r = await fetch(`https://friendbot.stellar.org?addr=${addr}`, { signal: AbortSignal.timeout(60000) }); if (r.ok || r.status === 400) return; } catch {} await sleep(3000); } throw new Error("friendbot"); }
const pm2 = () => Object.fromEntries(JSON.parse(sh("npx pm2 jlist").split("\n").filter((l) => l.startsWith("[")).pop()).map((p) => [p.name, { pid: p.pid, status: p.pm2_env.status, restarts: p.pm2_env.restart_time, mem: Math.round(p.monit.memory / 1e6) }]));
const health = async () => { try { const r = await fetch(API + "/health", { signal: AbortSignal.timeout(2000) }); return r.status; } catch { return 0; } };
async function until(what, fn, ms = 120000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error("timed out: " + what); await sleep(1500); } }

const walletKey = Keypair.random(), payer = Keypair.random();
log("setup: accounts, merchant, verified wallet"); await friendbot(walletKey.publicKey()); await friendbot(payer.publicKey());
await api("POST", "/auth/signup", { email: `drill-${Date.now()}@example.com`, password: "drill password 123", businessName: "Drill Co" });
const w = (await api("POST", "/v1/wallets", { address: walletKey.publicKey(), label: "Main" })).body.wallet;
const ch = (await api("POST", `/v1/wallets/${w.id}/challenge`)).body;
await api("POST", `/v1/wallets/${w.id}/verify`, { challengeId: ch.challengeId, signature: Buffer.from(walletKey.signMessage(ch.message)).toString("base64") });
const newRequest = async (amount) => (await api("POST", "/v1/payment-requests", { walletId: w.id, amount, asset: "XLM", description: "drill" })).body.request;
const send = async (amount, memo) => { const acct = await horizon.loadAccount(payer.publicKey()); const tx = new TransactionBuilder(acct, { fee: "10000", networkPassphrase: Networks.TESTNET }).addOperation(Operation.payment({ destination: walletKey.publicKey(), asset: Asset.native(), amount })).addMemo(Memo.text(memo)).setTimeout(120).build(); tx.sign(payer); return (await horizon.submitTransaction(tx)).hash; };
const detail = async (id) => (await api("GET", `/v1/payment-requests/${id}`)).body;
const paidOnce = async (r, hash, label) => {
  const d = await until(label + " becomes PAID", async () => { const x = await detail(r.id); return x?.request?.status === "PAID" ? x : null; });
  check(d.request.amountReceived === r.amount && d.payments.filter((p) => p.txHash === hash).length === 1 && d.payments.length === 1, `${label}: PAID, and the payment is recorded exactly once (not missed, not doubled)`);
};
const run = (id) => !only || only.has(id);

if (run("worker")) {
  log("DRILL 1: kill -9 the worker, pay while it is dead");
  const r = await newRequest("3"); const before = pm2()["paylink-worker"];
  process.kill(before.pid, "SIGKILL");
  const hash = await send("3", r.memo);
  const t0 = Date.now();
  await until("pm2 restarts the worker", async () => { const p = pm2()["paylink-worker"]; return p.status === "online" && p.pid !== before.pid ? p : null; }, 60000);
  check(true, `pm2 restarted the worker by itself in ${((Date.now() - t0) / 1000).toFixed(0)} s (restart count ${before.restarts} -> ${pm2()["paylink-worker"].restarts})`);
  await paidOnce(r, hash, "payment sent while the worker was dead");
}

if (run("api")) {
  log("DRILL 2: kill -9 the API");
  const before = pm2()["paylink-api"]; process.kill(before.pid, "SIGKILL"); const t0 = Date.now();
  await until("API answers again", async () => (await health()) === 200, 60000);
  check(true, `API back after a crash in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check((await api("GET", "/auth/me")).status === 200, "the session survived the API restart (it lives in Postgres)");
}

if (run("reload")) {
  log("DRILL 3: deploy-style `pm2 reload` of everything, with a payment in flight");
  const r = await newRequest("4");
  let down = 0, polls = 0, stop = false;
  const poller = (async () => { while (!stop) { polls++; if ((await health()) !== 200) down++; await sleep(250); } })();
  const hashP = send("4", r.memo);
  sh("npx pm2 reload ecosystem.config.cjs --update-env");
  await until("API healthy after reload", async () => (await health()) === 200, 60000);
  await sleep(1500); stop = true; await poller;
  check(true, `reload done; API unreachable for about ${(down * 0.25).toFixed(1)} s of the reload (${down}/${polls} health polls failed)`);
  const all = pm2(); check(Object.values(all).every((p) => p.status === "online"), "all three processes are online after the reload: " + Object.entries(all).map(([n, p]) => `${n} ${p.mem}MB`).join(", "));
  await paidOnce(r, await hashP, "payment sent during the reload");
  const web = await fetch(WEB + "/login").then((x) => x.status).catch(() => 0); check(web === 200, "web app serves pages after the reload");
}

if (run("db")) {
  log("DRILL 4: Postgres down for 25 s, with a payment sent during the outage");
  const r = await newRequest("5"); const before = pm2();
  sh("docker stop paylink-postgres-1");
  await sleep(4000);
  const h = await fetch(API + "/health").then(async (x) => [x.status, (await x.json()).db]).catch(() => [0]);
  check(h[0] === 503 && h[1] === "down", `API /health says 503, db down (got ${h})`);
  const v1 = await api("GET", "/v1/payment-requests").catch(() => ({ status: 0 }));
  check(v1.status === 503, `API calls answer 503 instead of hanging or crashing (got ${v1.status})`);
  const hash = await send("5", r.memo);
  await sleep(21000);
  const mid = pm2();
  check(mid["paylink-api"].status === "online" && mid["paylink-worker"].status === "online", `API and worker stayed up through the outage (worker restarts ${before["paylink-worker"].restarts} -> ${mid["paylink-worker"].restarts})`);
  sh("docker start paylink-postgres-1"); const t0 = Date.now();
  await until("API healthy after Postgres returns", async () => (await health()) === 200, 90000);
  check(true, `API healthy ${((Date.now() - t0) / 1000).toFixed(0)} s after Postgres came back, with no manual restart`);
  await paidOnce(r, hash, "payment sent while Postgres was down");
}

const failed = results.filter(([ok]) => !ok);
console.log(`\nDRILLS: ${results.length - failed.length}/${results.length} passed` + (failed.length ? "\nFAILED:\n" + failed.map(([, w]) => " - " + w).join("\n") : ""));
process.exit(failed.length ? 1 : 0);
