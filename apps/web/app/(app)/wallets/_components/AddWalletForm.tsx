"use client";

import { useId, useState } from "react";
import { useSWRConfig } from "swr";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { Wallet } from "@/lib/types";

interface Props {
  /** Wallets already on the account, to catch a duplicate before asking the API. */
  existing: Wallet[];
  onAdded?: (wallet: Wallet) => void;
  labelPlaceholder?: string;
}

/** A 56-character value starting with S is a Stellar secret key. It must never leave this page. */
const looksLikeSecret = (value: string) => value.length === 56 && value.startsWith("S");

function addressProblem(a: string, existing: Wallet[]): string {
  if (!a) return "Paste a public address.";
  if (a[0] !== "G") return "A Stellar public address starts with G.";
  if (a.length !== 56) return `That has ${a.length} characters. A public address has exactly 56.`;
  if (!/^G[A-Z2-7]{55}$/.test(a)) return "Only capital letters A–Z and digits 2–7 are allowed.";
  if (existing.some((w) => w.address === a)) return "You've already added this wallet.";
  return "";
}

/** Address + label fields and the "Add wallet" button. The secret-key block replaces sending. */
export function AddWalletForm({ existing, onAdded, labelPlaceholder = "e.g. Lekki branch" }: Props) {
  const { mutate } = useSWRConfig();
  const addrId = useId();
  const labelId = useId();
  const [addr, setAddr] = useState("");
  const [label, setLabel] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  /** What the API said about the address, shown under the field until it is edited. */
  const [apiAddrError, setApiAddrError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const a = addr.trim();
  const isSecret = looksLikeSecret(a);
  const addrErr = isSecret ? "" : addressProblem(a, existing);
  const shownAddrErr = isSecret ? "" : tried && addrErr ? addrErr : (apiAddrError ?? "");
  const labelBad = tried && !label.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // A secret key is never sent anywhere.
    if (isSecret || busy) return;
    setTried(true);
    if (addrErr || !label.trim()) return;
    setBusy(true);
    setError(null);
    setApiAddrError(null);
    try {
      const res = await api.post<{ wallet: Wallet }>("/v1/wallets", { address: a, label: label.trim() });
      setAddr("");
      setLabel("");
      setTried(false);
      await mutate("/v1/wallets");
      onAdded?.(res.wallet);
    } catch (err) {
      if (err instanceof ApiError && err.code === "SECRET_KEY_REJECTED") {
        setAddr("");
        setApiAddrError("That was a secret key, so we cleared it. Paste the public address (starts with G) instead.");
      } else if (err instanceof ApiError && err.code === "WALLET_TAKEN") {
        setApiAddrError("This wallet is already registered with PayLink. Use a different address.");
      } else if (err instanceof ApiError && err.code === "VALIDATION_FAILED") {
        const labelMsg = err.field("label");
        if (labelMsg && !err.field("address")) setError(`Label: ${labelMsg}`);
        else setApiAddrError("That isn't a valid Stellar public address. Check it and paste it again.");
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="field">
        <label htmlFor={addrId} className="label">
          Public address
        </label>
        <input
          id={addrId}
          className={`input mono${isSecret || shownAddrErr ? " invalid" : ""}`}
          style={{ fontSize: 14 }}
          value={addr}
          onChange={(e) => {
            setAddr(e.target.value);
            setApiAddrError(null);
          }}
          placeholder="G…"
          aria-invalid={isSecret || !!shownAddrErr}
          aria-describedby={`${addrId}-hint`}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
        />
        {isSecret ? (
          <div
            role="alert"
            style={{ background: "var(--alert-bg)", border: "1.5px solid var(--error-border)", borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}
          >
            <span style={{ fontWeight: 800, color: "var(--alert-fg)" }}>Stop. That&apos;s a secret key.</span>
            <span style={{ fontSize: 14, color: "var(--alert-fg)" }}>
              Secret keys start with S and give full control of a wallet. PayLink never asks for one. Clear it now, and if you&apos;ve shared it
              anywhere, move your funds to a new wallet.
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => setAddr("")}
              style={{ alignSelf: "flex-start", height: 42, background: "var(--error)", color: "#FFFFFF", fontSize: 15 }}
            >
              Clear it
            </button>
          </div>
        ) : null}
        {shownAddrErr ? (
          <span role="alert" className="field-error" style={{ fontWeight: 600 }}>
            {shownAddrErr}
          </span>
        ) : null}
        <span id={`${addrId}-hint`} style={{ fontSize: 13, color: "var(--slate)" }}>
          Starts with G and has 56 characters. {a && !isSecret ? <span style={{ fontWeight: 700 }}>{a.length} / 56</span> : null}
        </span>
      </div>
      <div className="field">
        <label htmlFor={labelId} className="label">
          Label
        </label>
        <input
          id={labelId}
          className={`input${labelBad ? " invalid" : ""}`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={labelPlaceholder}
          maxLength={64}
          aria-invalid={labelBad}
        />
        {labelBad ? (
          <span role="alert" className="field-error" style={{ fontWeight: 600 }}>
            Give it a name you&apos;ll recognise.
          </span>
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}
      <button type="submit" className="btn btn-primary" disabled={busy || isSecret} aria-busy={busy} style={{ alignSelf: "flex-start", fontSize: 15 }}>
        {busy ? "Adding…" : "Add wallet"}
      </button>
    </form>
  );
}
