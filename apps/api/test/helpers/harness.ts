import type { PaymentRequest as RequestDto, Wallet as WalletDto } from "@paylink/shared";
import { Keypair } from "@stellar/stellar-sdk";
import pino from "pino";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { buildApp } from "../../src/app";
import { CHANNELS, PgListener } from "../../src/db/notify";
import { prisma } from "../../src/db/prisma";
import type { Limits } from "../../src/deps";
import { Ingestion, type IngestionDeps } from "../../src/engine/ingestion";
import type { Mail, Mailer } from "../../src/lib/mailer";
import type { NormalizedPayment } from "../../src/engine/types";
import { WatchedWallets } from "../../src/engine/watchedWallets";
import { LiveHub } from "../../src/modules/stream/hub";
import { CapturingAlerter, FakeAccounts, FakeBackfill, FakeStellarSource, type PaymentInput } from "./fakes";
import { TEST_WEB_ORIGIN } from "./setupEnv";

export { prisma };
export const ORIGIN = TEST_WEB_ORIGIN;
export const silentLogger = pino({ level: "silent" });

const NO_LIMITS: Partial<Limits> = {
  authPerMin: 10_000,
  authReadPerMin: 10_000,
  publicPerMin: 10_000,
  v1PerMin: 10_000,
  v1PerIpPerMin: 10_000,
};

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "RequestEvent", "ChainPayment", "PaymentRequest", "WalletChallenge", "Wallet", "ApiKey", "Session", "PasswordReset", "EmailVerification", "TrustedDevice", "LoginThrottle", "RateLimit", "Merchant", "Cursor" CASCADE',
  );
}

/** Captures outgoing email instead of sending it. */
export class CapturingMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
}

export function makeApp(limits: Partial<Limits> = {}, opts: { mailer?: Mailer | null; verifyEmail?: boolean } = {}) {
  const accounts = new FakeAccounts();
  const hub = new LiveHub(prisma, silentLogger);
  const mailer = opts.mailer === undefined ? new CapturingMailer() : opts.mailer;
  const built = buildApp({ prisma, accounts, hub, logger: silentLogger, mailer, verifyEmail: opts.verifyEmail ?? false, limits: { ...NO_LIMITS, ...limits } });
  return { ...built, accounts, hub, mailer: mailer as CapturingMailer };
}
export type TestApp = ReturnType<typeof makeApp>;

/** Connects the hub to real Postgres NOTIFY, as server.ts does. Remember to stop it. */
export async function startListener(hub: LiveHub): Promise<PgListener> {
  const listener = new PgListener({
    connectionString: process.env.DATABASE_URL as string,
    channels: [CHANNELS.requestUpdated, CHANNELS.paymentDetected, CHANNELS.walletsChanged],
    onNotification: hub.handleNotification,
    onConnect: hub.resync,
    logger: silentLogger,
  });
  await listener.start();
  return listener;
}

let counter = 0;

export interface TestMerchant {
  agent: TestAgent;
  id: string;
  email: string;
  password: string;
}

/** Signs a merchant up through the API and returns a cookie-carrying agent. */
export async function signup(t: TestApp, businessName = "Acme Shop"): Promise<TestMerchant> {
  const agent = request.agent(t.app);
  const email = `merchant${++counter}-${Date.now()}@example.com`;
  const password = "correct horse battery";
  const res = await agent.post("/auth/signup").set("Origin", ORIGIN).send({ email, password, businessName });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, id: (res.body as { merchant: { id: string } }).merchant.id, email, password };
}

export interface TestWallet {
  id: string;
  address: string;
  keypair: Keypair;
}

/** Adds a wallet and proves ownership with a real SEP-53 signature. */
export async function addVerifiedWallet(m: TestMerchant, keypair = Keypair.random()): Promise<TestWallet> {
  const added = await m.agent.post("/v1/wallets").set("Origin", ORIGIN).send({ address: keypair.publicKey() });
  if (added.status !== 201) throw new Error(`add wallet failed: ${JSON.stringify(added.body)}`);
  const wallet = (added.body as { wallet: WalletDto }).wallet;
  const challenge = await m.agent.post(`/v1/wallets/${wallet.id}/challenge`).set("Origin", ORIGIN).send();
  const { challengeId, message } = challenge.body as { challengeId: string; message: string };
  const signature = Buffer.from(keypair.signMessage(message)).toString("base64");
  const verified = await m.agent
    .post(`/v1/wallets/${wallet.id}/verify`)
    .set("Origin", ORIGIN)
    .send({ challengeId, signature });
  if (verified.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verified.body)}`);
  return { id: wallet.id, address: wallet.address, keypair };
}

export async function createRequest(
  m: TestMerchant,
  wallet: TestWallet,
  body: Record<string, unknown> = {},
): Promise<RequestDto> {
  const res = await m.agent
    .post("/v1/payment-requests")
    .set("Origin", ORIGIN)
    .send({ walletId: wallet.id, amount: "50", asset: "USDC", ...body });
  if (res.status !== 201) throw new Error(`create request failed: ${res.status} ${JSON.stringify(res.body)}`);
  return (res.body as { request: RequestDto }).request;
}

/** Merchant + verified wallet in one call. */
export async function setupMerchant(t: TestApp, name?: string) {
  const merchant = await signup(t, name);
  const wallet = await addVerifiedWallet(merchant);
  return { merchant, wallet };
}

export function makeEngine(over: Partial<IngestionDeps> = {}) {
  const source = new FakeStellarSource();
  const backfill = new FakeBackfill();
  const alerter = new CapturingAlerter();
  const watched = new WatchedWallets(prisma, 0); // always refresh: tests add wallets constantly
  const ingestion = new Ingestion({
    prisma,
    source,
    backfill,
    watched,
    alerter,
    logger: silentLogger,
    networkPassphrase: "Test SDF Network ; September 2015",
    ...over,
  });
  /** Closes one ledger with these payments and ingests it. */
  const pay = async (payments: PaymentInput | PaymentInput[], closedAt: Date = new Date()): Promise<NormalizedPayment[]> => {
    const made = source.closeLedger(closedAt, Array.isArray(payments) ? payments : [payments]);
    await ingestion.tick();
    return made;
  };
  return { source, backfill, alerter, watched, ingestion, pay };
}
export type TestEngine = ReturnType<typeof makeEngine>;

export const USDC = (units: string | number): bigint => BigInt(units) * 10_000_000n;

export async function getRequest(id: string) {
  return prisma.paymentRequest.findUniqueOrThrow({ where: { id } });
}
export async function getPayment(eventId: string) {
  return prisma.chainPayment.findUniqueOrThrow({ where: { eventId } });
}
