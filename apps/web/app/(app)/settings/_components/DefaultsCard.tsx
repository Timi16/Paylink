"use client";

import Link from "next/link";
import { useState } from "react";
import { useSWRConfig } from "swr";
import { useToast } from "@/components/Toast";
import { api, errorMessage } from "@/lib/api";
import { shortAddress } from "@/lib/format";
import { useWallets } from "@/lib/session";
import type { Merchant } from "@/lib/types";
import { GRID, Section } from "./Section";

const EXPIRY_OPTIONS = [15, 30, 60, 1440];

function expiryLabel(minutes: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (minutes % 1440 === 0 && minutes > 1440) return plural(minutes / 1440, "day");
  if (minutes % 60 === 0) return plural(minutes / 60, "hour");
  return plural(minutes, "minute");
}

interface Draft {
  /** "" = no default. */
  walletId: string;
  expiry: number;
  autoMatch: boolean;
}

export function DefaultsCard({ merchant }: { merchant: Merchant }) {
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const { data: walletData, error: walletError, mutate: reloadWallets } = useWallets();
  const wallets = walletData?.data;

  // A default that points at a wallet since removed shows as "No default".
  const savedWalletId = merchant.defaultWalletId && wallets?.some((w) => w.id === merchant.defaultWalletId) ? merchant.defaultWalletId : "";
  const saved: Draft = { walletId: savedWalletId, expiry: merchant.defaultExpiryMinutes, autoMatch: merchant.autoMatchByAmount };
  const [draft, setDraft] = useState<Partial<Draft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value: Draft = { ...saved, ...draft };
  const edit = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
  };

  const expiryOptions = EXPIRY_OPTIONS.includes(value.expiry) ? EXPIRY_OPTIONS : [...EXPIRY_OPTIONS, value.expiry].sort((a, b) => a - b);
  const noneVerified = wallets !== undefined && !wallets.some((w) => w.verified);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ merchant: Merchant }>("/auth/settings", {
        // Without the wallet list we cannot tell what the picker means, so leave the default wallet untouched.
        ...(wallets ? { defaultWalletId: value.walletId || null } : {}),
        defaultExpiryMinutes: value.expiry,
        autoMatchByAmount: value.autoMatch,
      });
      await mutate("/auth/me", res, { revalidate: false });
      setDraft({});
      toast("Defaults saved");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Request defaults" sub="Pre-filled on every new request. You can still change them each time.">
      <form onSubmit={save} noValidate style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {error ? (
          <div role="alert" className="alert">
            {error}
          </div>
        ) : null}
        <div style={GRID}>
          <div className="field">
            <label htmlFor="dw" className="label">
              Default wallet
            </label>
            <select id="dw" className="select" value={wallets ? value.walletId : ""} onChange={(e) => edit({ walletId: e.target.value })} disabled={!wallets} aria-busy={!wallets && !walletError} aria-describedby="dw-hint">
              {wallets ? (
                <>
                  <option value="">No default</option>
                  {wallets.map((w) => (
                    <option key={w.id} value={w.id} disabled={!w.verified}>
                      {w.label ?? "Wallet"} · {w.verified ? shortAddress(w.address) : "not verified"}
                    </option>
                  ))}
                </>
              ) : (
                <option value="">{walletError ? "Wallets unavailable" : "Loading wallets…"}</option>
              )}
            </select>
            <span id="dw-hint">
              {walletError && !wallets ? (
                <span className="field-error" role="alert">
                  {errorMessage(walletError)}{" "}
                  <button type="button" className="btn-link" onClick={() => reloadWallets()} style={{ fontSize: 13 }}>
                    Try again
                  </button>
                </span>
              ) : noneVerified ? (
                <span className="hint">
                  Only verified wallets can be a default. <Link href="/wallets">{wallets?.length ? "Verify a wallet" : "Add a wallet"}</Link>
                </span>
              ) : null}
            </span>
          </div>
          <div className="field">
            <label htmlFor="de" className="label">
              Default expiry
            </label>
            <select id="de" className="select" value={String(value.expiry)} onChange={(e) => edit({ expiry: Number.parseInt(e.target.value, 10) })}>
              {expiryOptions.map((m) => (
                <option key={m} value={String(m)}>
                  {expiryLabel(m)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", minHeight: 44, borderTop: "1px solid var(--border-soft)", paddingTop: 10 }}>
          <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>Match payments with no memo by exact amount</span>
            <span style={{ fontSize: 13, color: "var(--slate)" }}>
              When on, a payment with no memo that exactly settles the only open request it could belong to is applied automatically. It saves you matching by hand, but it trusts the amount alone, so an unrelated payment of the same amount would be applied too.
            </span>
          </span>
          <input type="checkbox" role="switch" checked={value.autoMatch} onChange={(e) => edit({ autoMatch: e.target.checked })} style={{ width: 22, height: 22, accentColor: "var(--teal)", margin: 0, flexShrink: 0 }} />
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy} style={{ fontSize: 15 }}>
            {busy ? "Saving…" : "Save defaults"}
          </button>
        </div>
      </form>
    </Section>
  );
}
