import type { Trustline } from "@paylink/shared";
import { AppError } from "../../lib/errors";

export type AccountState = { exists: false } | { exists: true; trustlines: Trustline[] };

/** Looks an account up on the network. Throws HORIZON_UNAVAILABLE when it cannot tell. */
export interface AccountLoader {
  load(address: string): Promise<AccountState>;
}

interface HorizonBalance {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  balance?: string;
  limit?: string;
  buying_liabilities?: string;
  is_authorized?: boolean;
}

export class HorizonAccountLoader implements AccountLoader {
  constructor(
    private readonly horizonUrl: string,
    private readonly timeoutMs = 8000,
  ) {}

  async load(address: string): Promise<AccountState> {
    let res: Response;
    try {
      res = await fetch(`${this.horizonUrl.replace(/\/$/, "")}/accounts/${address}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AppError("HORIZON_UNAVAILABLE", "Could not reach Stellar to check this wallet", {
        retryAfter: 10,
      });
    }
    if (res.status === 404) return { exists: false };
    if (!res.ok) {
      throw new AppError("HORIZON_UNAVAILABLE", "Could not reach Stellar to check this wallet", {
        retryAfter: 10,
      });
    }
    let body: { balances?: HorizonBalance[] };
    try {
      body = (await res.json()) as { balances?: HorizonBalance[] };
    } catch {
      throw new AppError("HORIZON_UNAVAILABLE", "Could not reach Stellar to check this wallet", {
        retryAfter: 10,
      });
    }
    const trustlines: Trustline[] = [];
    for (const b of body.balances ?? []) {
      if (!b.asset_code || !b.asset_issuer) continue; // native and pool shares
      trustlines.push({
        code: b.asset_code,
        issuer: b.asset_issuer,
        limit: b.limit ?? "0",
        balance: b.balance ?? "0",
        buyingLiabilities: b.buying_liabilities ?? "0",
        authorized: b.is_authorized !== false,
      });
    }
    return { exists: true, trustlines };
  }
}
