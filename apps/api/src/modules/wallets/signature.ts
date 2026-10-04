import { Keypair } from "@stellar/stellar-sdk";

/**
 * Wallet-ownership signatures follow SEP-53 ("Sign and Verify Messages"), which is what
 * Freighter's signMessage produces:
 *
 *   signature = ed25519_sign(key, SHA-256("Stellar Signed Message:\n" + message))
 *
 * Verification uses the SDK's Keypair.verifyMessage, which implements exactly that.
 * The signature is accepted as base64 (what Freighter returns) or hex.
 *
 * Test vector (generated with @stellar/stellar-sdk 17.2.1 and asserted in
 * test/unit/signature.test.ts; re-confirm against the installed Freighter build once):
 *   seed      = 32 bytes of 0x01
 *   address   = GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR
 *   message   = "PayLink wallet verification"
 *   signature = see SEP53_VECTOR in the test file
 */
export function decodeSignature(signature: string): Uint8Array | null {
  const s = signature.trim();
  if (/^[0-9a-fA-F]{128}$/.test(s)) return Buffer.from(s, "hex");
  if (/^[A-Za-z0-9+/_-]{86}(==)?$/.test(s)) {
    const bytes = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return bytes.length === 64 ? bytes : null;
  }
  return null;
}

export function verifyWalletSignature(address: string, message: string, signature: string): boolean {
  const bytes = decodeSignature(signature);
  if (!bytes) return false;
  try {
    return Keypair.fromPublicKey(address).verifyMessage(message, bytes);
  } catch {
    return false;
  }
}
