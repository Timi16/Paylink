"use client";

import { HORIZON_URL, NETWORK_PASSPHRASE } from "./config";
import { toStroops } from "./format";
import { connectFreighter, signTransactionWithFreighter } from "./freighter";
import type { AssetRef } from "./types";

export type PayErrorCode = "NO_ACCOUNT" | "NO_TRUSTLINE" | "INSUFFICIENT" | "SUBMIT_FAILED" | "NETWORK";

export class PayError extends Error {
  constructor(
    readonly code: PayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PayError";
  }
}

export interface PayParams {
  destination: string;
  asset: AssetRef;
  /** Decimal string, e.g. "35.0000000". */
  amount: string;
  /** The request's text memo. */
  memo: string;
}

/**
 * "Pay with Freighter": checks the payer's account can make the payment, builds a payment
 * with the request's text memo, has Freighter sign it and submits it to Stellar Testnet.
 * The Stellar SDK is loaded only when this runs, so the checkout page itself stays light.
 * Throws FreighterError (wallet problems) or PayError (account or network problems).
 */
export async function payWithFreighter(params: PayParams): Promise<{ hash: string; payer: string }> {
  const payer = await connectFreighter();
  const sdk = await import("@stellar/stellar-sdk");
  const server = new sdk.Horizon.Server(HORIZON_URL);

  let account;
  try {
    account = await server.loadAccount(payer);
  } catch (err) {
    if ((err as { response?: { status?: number } }).response?.status === 404) {
      throw new PayError("NO_ACCOUNT", "This Freighter account isn't funded on Testnet yet. Fund it with Friendbot first.");
    }
    throw new PayError("NETWORK", "Couldn't reach Stellar. Check your connection and try again.");
  }

  const needed = toStroops(params.amount);
  const native = params.asset.issuer === null;
  const line = account.balances.find((b) =>
    native ? b.asset_type === "native" : "asset_code" in b && b.asset_code === params.asset.code && b.asset_issuer === params.asset.issuer,
  );
  if (!line) {
    throw new PayError("NO_TRUSTLINE", `This Freighter account doesn't hold ${params.asset.code}. Add a ${params.asset.code} trustline and some funds first.`);
  }
  if (toStroops(line.balance) < needed) {
    throw new PayError("INSUFFICIENT", `This Freighter account has ${line.balance} ${params.asset.code}, which isn't enough.`);
  }

  const asset = native ? sdk.Asset.native() : new sdk.Asset(params.asset.code, params.asset.issuer as string);
  const fee = await server.fetchBaseFee().catch(() => 100);
  const tx = new sdk.TransactionBuilder(account, { fee: String(fee * 10), networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(sdk.Operation.payment({ destination: params.destination, asset, amount: params.amount }))
    .addMemo(sdk.Memo.text(params.memo))
    .setTimeout(180)
    .build();

  const signedXdr = await signTransactionWithFreighter(tx.toXDR(), payer);
  try {
    const signed = sdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    const res = await server.submitTransaction(signed);
    return { hash: res.hash, payer };
  } catch (err) {
    const codes = (err as { response?: { data?: { extras?: { result_codes?: { operations?: string[]; transaction?: string } } } } }).response?.data?.extras?.result_codes;
    const op = codes?.operations?.[0];
    if (op === "op_no_trust" || op === "op_line_full" || op === "op_no_destination") {
      throw new PayError("SUBMIT_FAILED", "The business's wallet can't receive this payment right now. Nothing was sent. Let them know.");
    }
    if (op === "op_underfunded") throw new PayError("INSUFFICIENT", `Not enough ${params.asset.code} to cover this payment.`);
    throw new PayError("SUBMIT_FAILED", "Stellar didn't accept the payment. Nothing was sent. Try again.");
  }
}
