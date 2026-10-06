"use client";

import { getNetworkDetails, isConnected, requestAccess, signMessage, signTransaction } from "@stellar/freighter-api";
import { NETWORK_PASSPHRASE } from "./config";

export type FreighterErrorCode = "NOT_INSTALLED" | "REJECTED" | "WRONG_NETWORK" | "WRONG_ACCOUNT" | "FAILED";

export class FreighterError extends Error {
  constructor(
    readonly code: FreighterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FreighterError";
  }
}

export const FREIGHTER_MESSAGES: Record<FreighterErrorCode, string> = {
  NOT_INSTALLED: "Freighter isn't installed in this browser. Install it from freighter.app, then try again.",
  REJECTED: "You rejected the request in Freighter. Try again when you're ready.",
  WRONG_NETWORK: "Freighter is on a different network. Switch it to Testnet, then try again.",
  WRONG_ACCOUNT: "Freighter signed with a different account. Select the right account in Freighter, then try again.",
  FAILED: "Freighter couldn't complete that. Try again.",
};

function toError(error: unknown): FreighterError {
  const text = typeof error === "string" ? error : ((error as { message?: string } | null)?.message ?? "");
  const code: FreighterErrorCode = /declin|reject|denied|cancel/i.test(text) ? "REJECTED" : "FAILED";
  return new FreighterError(code, FREIGHTER_MESSAGES[code]);
}

const fail = (code: FreighterErrorCode) => new FreighterError(code, FREIGHTER_MESSAGES[code]);

/** Asks Freighter for the active account, and makes sure it is on Testnet. Returns the G address. */
export async function connectFreighter(): Promise<string> {
  const connected = await isConnected().catch(() => ({ isConnected: false }));
  if (!connected.isConnected) throw fail("NOT_INSTALLED");
  const access = await requestAccess();
  if (access.error || !access.address) throw toError(access.error);
  const network = await getNetworkDetails();
  if (network.error) throw toError(network.error);
  if (network.networkPassphrase !== NETWORK_PASSPHRASE) throw fail("WRONG_NETWORK");
  return access.address;
}

/**
 * Signs a plain message (SEP-53) with `address`. Returns the signature as base64, which is
 * what the API's wallet verification expects. Signing a message moves no money and costs no fee.
 */
export async function signMessageWithFreighter(message: string, address: string): Promise<string> {
  const res = await signMessage(message, { address, networkPassphrase: NETWORK_PASSPHRASE });
  if (res.error || !res.signedMessage) throw toError(res.error);
  if (res.signerAddress && res.signerAddress !== address) throw fail("WRONG_ACCOUNT");
  if (typeof res.signedMessage === "string") return res.signedMessage;
  // Older Freighter versions return the raw bytes.
  let binary = "";
  for (const byte of new Uint8Array(res.signedMessage)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Signs a transaction envelope with `address` and returns the signed XDR. */
export async function signTransactionWithFreighter(xdr: string, address: string): Promise<string> {
  const res = await signTransaction(xdr, { address, networkPassphrase: NETWORK_PASSPHRASE });
  if (res.error || !res.signedTxXdr) throw toError(res.error);
  if (res.signerAddress && res.signerAddress !== address) throw fail("WRONG_ACCOUNT");
  return res.signedTxXdr;
}
