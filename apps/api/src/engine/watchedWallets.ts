import type { PrismaClient } from "@prisma/client";
import { OPEN_STATUSES } from "../modules/transitions";

export interface WatchedWallet {
  id: string;
  merchantId: string;
  address: string;
  /** The owning merchant's opt-in for matching memo-less payments by exact amount. */
  autoMatchByAmount: boolean;
}

/**
 * The set of wallets whose incoming payments we record: every live wallet, plus soft-deleted
 * ones that still have open requests. Refreshed on NOTIFY wallets_changed and every 30 s.
 */
export class WatchedWallets {
  private byAddress = new Map<string, WatchedWallet>();
  private loadedAt = 0;
  private dirty = true;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly maxAgeMs = 30_000,
  ) {}

  markDirty(): void {
    this.dirty = true;
  }

  async refresh(): Promise<void> {
    const rows = await this.prisma.wallet.findMany({
      where: {
        OR: [{ deletedAt: null }, { requests: { some: { status: { in: OPEN_STATUSES } } } }],
      },
      select: { id: true, merchantId: true, address: true, merchant: { select: { autoMatchByAmount: true } } },
    });
    this.byAddress = new Map(
      rows.map((w) => [
        w.address,
        { id: w.id, merchantId: w.merchantId, address: w.address, autoMatchByAmount: w.merchant.autoMatchByAmount },
      ]),
    );
    this.loadedAt = Date.now();
    this.dirty = false;
  }

  async ensureFresh(): Promise<void> {
    if (this.dirty || Date.now() - this.loadedAt > this.maxAgeMs) await this.refresh();
  }

  has = (address: string): boolean => this.byAddress.has(address);

  get(address: string): WatchedWallet | undefined {
    return this.byAddress.get(address);
  }

  all(): WatchedWallet[] {
    return [...this.byAddress.values()];
  }
}
