import { Keypair } from "@stellar/stellar-sdk";

/**
 * Wallet-ownership signatures follow SEP-53 ("Sign and Verify Messages"), which is what
 * Freighter's signMessage produces:
 *
 *   signature = ed25519_sign(key, SHA-256("Stellar Signed Message:\n" + message))
 *
 * Verification uses the SDK's Keypair.verifyMessage, which implements exactly that.
 * Checked against Freighter's source on 2026-10-04 (extension/src/helpers/stellar.ts,
 * encodeSep53Message: utf8 prefix + utf8 message, SHA-256, then Keypair.sign).
 *
 * Accepted encodings: base64 (Freighter API v4+), hex, or raw bytes / a JSON-serialised
 * Buffer (Freighter API v3). Wallets from before SEP-53 signed the bare message bytes; that
 * form is accepted too. It proves control of the key just the same, and the challenge text
 * (fixed header, merchant, wallet, nonce, expiry) can never be mistaken for a transaction.
 *
 * Test vector (generated with @stellar/stellar-sdk 17.2.1 and asserted in
 * test/unit/signature.test.ts; re-confirm against the installed Freighter build once):
 *   seed      = 32 bytes of 0x01
 *   address   = GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR
 *   message   = "PayLink wallet verification"
 *   signature = see SEP53_VECTOR in the test file
 */
export type SignatureInput = string | number[] | { type: "Buffer"; data: number[] };

export function decodeSignature(signature: SignatureInput): Uint8Array | null {
  if (typeof signature !== "string") {
    const data = Array.isArray(signature) ? signature : signature.data;
    return data.length === 64 ? Uint8Array.from(data) : null;
  }
  const s = signature.trim();
  if (/^[0-9a-fA-F]{128}$/.test(s)) return Buffer.from(s, "hex");
  if (/^[A-Za-z0-9+/_-]{86}(==)?$/.test(s)) {
    const bytes = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return bytes.length === 64 ? bytes : null;
  }
  return null;
}

export function verifyWalletSignature(address: string, message: string, signature: SignatureInput): boolean {
  const bytes = decodeSignature(signature);
  if (!bytes) return false;
  try {
    const key = Keypair.fromPublicKey(address);
    return key.verifyMessage(message, bytes) || key.verify(Buffer.from(message, "utf8"), Buffer.from(bytes));
  } catch {
    return false;
  }
}
