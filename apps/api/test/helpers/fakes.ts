import type { Trustline } from "@paylink/shared";
import type { Alerter } from "../../src/engine/alerter";
import type {
  BackfillSource,
  ChainTip,
  FetchParams,
  FetchResult,
  StellarSource,
} from "../../src/engine/sources/StellarSource";
import type { NormalizedPayment } from "../../src/engine/types";
import { AppError } from "../../src/lib/errors";
import type { AccountLoader, AccountState } from "../../src/modules/wallets/horizonAccounts";

export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const FAKE_ISSUER = "GAGVZMODPYFTULIVSY3RGFADIC5LF4LLSN37N4MFWGNZ57TYBXL2LQQX";
export const PAYER = "GAE6HVGQRXFG5BVAAVZBKP44U6JMFHYVDRAVGADJFHBSVS6RX7PETWFV";

export function usdcTrustline(over: Partial<Trustline> = {}): Trustline {
  return {
    code: "USDC",
    issuer: USDC_ISSUER,
    limit: "922337203685.4775807",
    balance: "0.0000000",
    buyingLiabilities: "0.0000000",
    authorized: true,
    ...over,
  };
}

/** Stands in for Horizon account lookups. Unknown addresses exist with a USDC trustline. */
export class FakeAccounts implements AccountLoader {
  readonly states = new Map<string, AccountState>();
  down = false;
  calls = 0;

  async load(address: string): Promise<AccountState> {
    this.calls++;
    if (this.down) throw new AppError("HORIZON_UNAVAILABLE", "Horizon is down");
    return this.states.get(address) ?? { exists: true, trustlines: [usdcTrustline()] };
  }
}

export class CapturingAlerter implements Alerter {
  readonly messages: string[] = [];
  async alert(message: string): Promise<void> {
    this.messages.push(message);
  }
}

const pad = (n: bigint, width: number) => n.toString().padStart(width, "0");

export type PaymentInput = Partial<NormalizedPayment> & { to: string; amountStroops: bigint };

/** In-memory chain: ledgers close on demand and events page exactly like RPC getEvents. */
export class FakeStellarSource implements StellarSource {
  ledger = 1000;
  oldestLedger = 1;
  failing = false;
  fetchCalls = 0;
  private events: NormalizedPayment[] = [];
  // The chain starts an hour in the past so tests can close ledgers at earlier times.
  private readonly closeTimes = new Map<number, Date>([[1000, new Date(Date.now() - 3_600_000)]]);
  private seq = 0;

  /** Closes a new ledger at `closedAt` containing `payments`. */
  closeLedger(closedAt: Date = new Date(), payments: PaymentInput[] = []): NormalizedPayment[] {
    this.ledger++;
    this.closeTimes.set(this.ledger, closedAt);
    const made = payments.map((p, i) => {
      const toid = (BigInt(this.ledger) << 32n) | (BigInt(i + 1) << 12n);
      const full: NormalizedPayment = {
        eventId: `${pad(toid, 19)}-${pad(0n, 10)}`,
        txHash: `tx${(++this.seq).toString().padStart(62, "0")}`,
        innerTxHash: null,
        ledger: this.ledger,
        ledgerClosedAt: closedAt,
        from: PAYER,
        toMuxedId: null,
        memoRaw: null,
        memoType: "none",
        assetCode: "USDC",
        assetIssuer: USDC_ISSUER,
        eventType: "transfer",
        source: "rpc",
        ...p,
      };
      if (p.memoRaw != null && p.memoType === undefined) full.memoType = "text";
      return full;
    });
    this.events.push(...made);
    return made;
  }

  /** Simulates a testnet wipe: history gone, ledger numbers restart. */
  reset(toLedger: number): void {
    this.ledger = toLedger;
    this.oldestLedger = 1;
    this.events = [];
    this.closeTimes.clear();
    this.closeTimes.set(toLedger, new Date());
  }

  async getTip(): Promise<ChainTip> {
    if (this.failing) throw new Error("rpc unavailable");
    return {
      ledger: this.ledger,
      closedAt: this.closeTimes.get(this.ledger) ?? new Date(),
      oldestLedger: this.oldestLedger,
    };
  }

  async fetch(params: FetchParams): Promise<FetchResult> {
    this.fetchCalls++;
    if (this.failing) throw new Error("rpc unavailable");
    if (!params.cursor && params.startLedger < this.oldestLedger) {
      throw new Error("startLedger must be within the ledger range");
    }
    const sorted = [...this.events].sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
    const after = params.cursor
      ? sorted.filter((e) => e.eventId > (params.cursor as string))
      : sorted.filter((e) => e.ledger >= params.startLedger);
    const page = after.slice(0, params.limit);
    const full = page.length >= params.limit;
    const last = page[page.length - 1];
    const endOfTip = `${pad((BigInt(this.ledger + 1) << 32n) - 1n, 19)}-4294967295`;
    const throughLedger = full && last ? last.ledger - 1 : this.ledger;
    return {
      payments: page.filter((e) => params.isWatched(e.to)),
      cursor: full && last ? last.eventId : endOfTip,
      full,
      processedThrough: { ledger: throughLedger, closedAt: this.closeTimes.get(throughLedger) ?? null },
      latestLedger: this.ledger,
    };
  }
}

export class FakeBackfill implements BackfillSource {
  readonly byAddress = new Map<string, NormalizedPayment[]>();
  calls: { address: string; from: number; to: number }[] = [];

  async *payments(address: string, from: number, to: number): AsyncIterable<NormalizedPayment[]> {
    this.calls.push({ address, from, to });
    const list = (this.byAddress.get(address) ?? []).filter((p) => p.ledger >= from && p.ledger <= to);
    if (list.length > 0) yield list;
  }
}
