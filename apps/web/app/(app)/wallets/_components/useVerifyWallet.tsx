"use client";

import { useCallback, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { api, ApiError, errorMessage } from "@/lib/api";
import { shortAddress } from "@/lib/format";
import { connectFreighter, FreighterError, signMessageWithFreighter } from "@/lib/freighter";
import type { ChallengeResponse, Wallet } from "@/lib/types";

/** The real USDC issuer on Stellar Testnet (Circle). */
export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export const walletName = (w: Pick<Wallet, "label" | "address">) => w.label || shortAddress(w.address, 6, 7);

export type VerifyPhase = "freighter" | "checking";

export interface VerifyState {
  /** The wallet being verified, or the one the last error belongs to. */
  walletId: string | null;
  /** Null when idle. */
  phase: VerifyPhase | null;
  error: string | null;
}

export const VERIFY_PHASE_TEXT: Record<VerifyPhase, string> = {
  freighter: "Waiting for Freighter…",
  checking: "Checking the signature…",
};

function verifyErrorMessage(err: unknown): string {
  if (err instanceof FreighterError) return err.message;
  if (err instanceof ApiError) {
    if (err.code === "INVALID_SIGNATURE") {
      return "That signature doesn't match this wallet. Select this account in Freighter, then try again.";
    }
    if (err.code === "CHALLENGE_EXPIRED") return "That took too long and the message expired. Try again.";
  }
  return errorMessage(err);
}

/**
 * Proves a wallet is the merchant's: asks the API for a one-time message, has Freighter sign
 * it with that wallet's account, and sends the signature back. Signing moves no money.
 * Resolves to the verified wallet, or null when it failed (the reason is in `state.error`).
 */
export function useVerifyWallet() {
  const { mutate } = useSWRConfig();
  const [state, setState] = useState<VerifyState>({ walletId: null, phase: null, error: null });
  const running = useRef(false);

  const verify = useCallback(
    async (wallet: Wallet): Promise<Wallet | null> => {
      if (running.current) return null;
      running.current = true;
      setState({ walletId: wallet.id, phase: "freighter", error: null });
      try {
        const challenge = await api.post<ChallengeResponse>(`/v1/wallets/${wallet.id}/challenge`);
        const active = await connectFreighter();
        if (active !== wallet.address) {
          throw new FreighterError(
            "WRONG_ACCOUNT",
            `Freighter is on a different account (${shortAddress(active)}). Select ${shortAddress(wallet.address)} in Freighter, then try again.`,
          );
        }
        const signature = await signMessageWithFreighter(challenge.message, wallet.address);
        setState({ walletId: wallet.id, phase: "checking", error: null });
        const res = await api.post<{ wallet: Wallet }>(`/v1/wallets/${wallet.id}/verify`, {
          challengeId: challenge.challengeId,
          signature,
        });
        setState({ walletId: null, phase: null, error: null });
        void mutate("/v1/wallets");
        void mutate("/auth/me");
        return res.wallet;
      } catch (err) {
        setState({ walletId: wallet.id, phase: null, error: verifyErrorMessage(err) });
        return null;
      } finally {
        running.current = false;
      }
    },
    [mutate],
  );

  const clearError = useCallback(() => setState((s) => (s.phase ? s : { walletId: null, phase: null, error: null })), []);

  return { state, verify, clearError, busy: state.phase !== null };
}

/** The line shown while verification is in flight. */
export function VerifyProgress({ phase }: { phase: VerifyPhase }) {
  return (
    <div role="status" style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--teal-deep)", fontWeight: 700, fontSize: 14 }}>
      <style>{"@keyframes wallet-verify-spin{to{transform:rotate(360deg)}}"}</style>
      <span
        aria-hidden="true"
        style={{
          width: 16,
          height: 16,
          flexShrink: 0,
          borderRadius: "50%",
          border: "2.5px solid currentColor",
          borderRightColor: "transparent",
          display: "inline-block",
          animation: "wallet-verify-spin .8s linear infinite",
        }}
      />
      {VERIFY_PHASE_TEXT[phase]}
    </div>
  );
}
