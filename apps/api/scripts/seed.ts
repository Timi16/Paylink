/**
 * Demo data for local UI work: one merchant, one verified wallet, and requests in every
 * status with their payments and audit rows. Run: pnpm seed
 *
 *   login: demo@paylink.test / demo-password-123
 */
import { PrismaClient, type PaymentOutcome, type RequestStatus } from "@prisma/client";
import { Keypair } from "@stellar/stellar-sdk";
import argon2 from "argon2";
import { randomBytes, randomInt } from "node:crypto";

const prisma = new PrismaClient();
const USDC_ISSUER = process.env.USDC_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const pick = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join("");
const hash = () => randomBytes(32).toString("hex");
const usdc = (units: number) => BigInt(units) * 10_000_000n;
const minutes = (n: number) => new Date(Date.now() + n * 60_000);

interface Spec {
  status: RequestStatus;
  amount: number;
  description: string;
  expiresInMin: number;
  payments: { amount: number; outcome: PaymentOutcome; issuer?: string; code?: string }[];
}

const SPECS: Spec[] = [
  { status: "PENDING", amount: 50, description: "Order #1042", expiresInMin: 25, payments: [] },
  { status: "UNDERPAID", amount: 80, description: "Order #1043", expiresInMin: 20, payments: [{ amount: 30, outcome: "COUNTED" }] },
  { status: "PAID", amount: 25, description: "Order #1039", expiresInMin: -60, payments: [{ amount: 25, outcome: "COUNTED" }, { amount: 25, outcome: "DUPLICATE" }] },
  { status: "OVERPAID", amount: 10, description: "Order #1038", expiresInMin: -90, payments: [{ amount: 12, outcome: "COUNTED" }] },
  { status: "EXPIRED", amount: 40, description: "Order #1030", expiresInMin: -120, payments: [{ amount: 40, outcome: "LATE" }] },
  { status: "EXPIRED", amount: 15, description: "Order #1029", expiresInMin: -200, payments: [] },
  { status: "CANCELLED", amount: 99, description: "Order #1028", expiresInMin: -30, payments: [{ amount: 99, outcome: "AFTER_CANCEL" }] },
  { status: "NETWORK_RESET", amount: 5, description: "Order #1001", expiresInMin: -1000, payments: [] },
  { status: "PENDING", amount: 60, description: "Order #1044", expiresInMin: 28, payments: [{ amount: 60, outcome: "WRONG_ISSUER", issuer: Keypair.random().publicKey() }, { amount: 60, outcome: "WRONG_ASSET", code: "XLM" }] },
];

async function main(): Promise<void> {
  const email = "demo@paylink.test";
  await prisma.merchant.deleteMany({ where: { email, wallets: { none: {} } } });
  if (await prisma.merchant.findUnique({ where: { email } })) {
    console.log("Demo merchant already exists; nothing to do.");
    return;
  }
  const merchant = await prisma.merchant.create({
    data: { email, businessName: "Demo Coffee Co", passwordHash: await argon2.hash("demo-password-123", { type: argon2.argon2id }) },
  });
  const address = Keypair.random().publicKey();
  const wallet = await prisma.wallet.create({
    data: {
      merchantId: merchant.id,
      address,
      label: "Main till",
      verifiedAt: new Date(),
      accountExists: true,
      checkedAt: new Date(),
      trustlines: [{ code: "USDC", issuer: USDC_ISSUER, limit: "922337203685.4775807", balance: "0.0000000", buyingLiabilities: "0.0000000", authorized: true }],
    },
  });

  let ledger = 5_000_000;
  for (const spec of SPECS) {
    const counted = spec.payments.filter((p) => p.outcome === "COUNTED").reduce((sum, p) => sum + usdc(p.amount), 0n);
    const paid = spec.status === "PAID" || spec.status === "OVERPAID";
    const paidTx = paid ? hash() : null;
    const request = await prisma.paymentRequest.create({
      data: {
        publicId: pick(BASE62, 12),
        merchantId: merchant.id,
        walletId: wallet.id,
        walletAddress: address,
        assetCode: "USDC",
        assetIssuer: USDC_ISSUER,
        amountStroops: usdc(spec.amount),
        receivedStroops: counted,
        memo: `PL${pick(CROCKFORD, 8)}`,
        status: spec.status,
        description: spec.description,
        customerRef: spec.description.replace("Order #", "ord_"),
        expiresAt: minutes(spec.expiresInMin),
        paidAt: paid ? minutes(spec.expiresInMin - 10) : null,
        paidTxHash: paidTx,
        cancelledAt: spec.status === "CANCELLED" ? minutes(-45) : null,
        createdVia: "dashboard",
      },
    });
    let first = true;
    for (const p of spec.payments) {
      ledger += 3;
      const eventId = `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-0000000000`;
      await prisma.chainPayment.create({
        data: {
          eventId,
          txHash: p.outcome === "COUNTED" && first && paidTx ? paidTx : hash(),
          ledger,
          ledgerClosedAt: minutes(-30),
          walletId: wallet.id,
          fromAddress: Keypair.random().publicKey(),
          toAddress: address,
          memoRaw: request.memo,
          memoNormalized: request.memo,
          memoType: "text",
          assetCode: p.code ?? "USDC",
          assetIssuer: p.code === "XLM" ? null : (p.issuer ?? USDC_ISSUER),
          amountStroops: usdc(p.amount),
          eventType: "transfer",
          source: "rpc",
          requestId: request.id,
          outcome: p.outcome,
        },
      });
      if (p.outcome === "COUNTED") first = false;
    }
    if (spec.status !== "PENDING") {
      await prisma.requestEvent.create({
        data: {
          requestId: request.id,
          fromStatus: "PENDING",
          toStatus: spec.status,
          reason: paid || spec.status === "UNDERPAID" ? "payment_counted" : spec.status === "CANCELLED" ? "cancelled" : spec.status === "EXPIRED" ? "expired" : "network_reset",
          actor: spec.status === "CANCELLED" ? "merchant" : "system",
        },
      });
    }
  }
  // Two unmatched payments for the Unmatched list.
  for (const [memoType, memoRaw, outcome] of [["none", null, "NO_MEMO"], ["text", "thanks!", "UNKNOWN_MEMO"]] as const) {
    ledger += 3;
    await prisma.chainPayment.create({
      data: {
        eventId: `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-0000000000`,
        txHash: hash(),
        ledger,
        ledgerClosedAt: minutes(-5),
        walletId: wallet.id,
        fromAddress: Keypair.random().publicKey(),
        toAddress: address,
        memoRaw,
        memoType,
        assetCode: "USDC",
        assetIssuer: USDC_ISSUER,
        amountStroops: usdc(20),
        eventType: "transfer",
        source: "rpc",
        outcome,
      },
    });
  }
  console.log(`Seeded. Login: ${email} / demo-password-123`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
