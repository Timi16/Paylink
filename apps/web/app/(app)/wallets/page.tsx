"use client";

import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icon";
import { Pill } from "@/components/StatusPill";
import { useToast } from "@/components/Toast";
import { api, errorMessage } from "@/lib/api";
import { shortAddress, timeAgo } from "@/lib/format";
import { useNow, usePollWhenOffline } from "@/lib/live";
import { useMe } from "@/lib/session";
import { OPEN_STATUSES } from "@/lib/status";
import type { RequestStats, Wallet } from "@/lib/types";
import { AddWalletForm } from "./_components/AddWalletForm";
import { USDC_ISSUER, useVerifyWallet, VerifyProgress, walletName, type VerifyState } from "./_components/useVerifyWallet";

const FACT_OK: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: "var(--teal-deep)" };
const FACT_WARN: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: "var(--attention-fg)" };
const FACT_GREY: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: "var(--slate)" };
const SMALL_BTN: React.CSSProperties = { height: 40, padding: "0 14px" };

interface Fact {
  k: string;
  v: string;
  style: React.CSSProperties;
}

type Check = Wallet["canReceive"][string];

/** One asset's "can it receive" answer, in the merchant's words. */
function receiveFact(code: string, check: Check, checking: boolean, checked: boolean): Fact {
  const k = `Can receive ${code}`;
  if (checking) return { k, v: "…", style: FACT_GREY };
  if (!checked) return { k, v: "Not checked yet", style: FACT_GREY };
  if (check.canReceive) return { k, v: code === "XLM" ? "Ready" : "Trustline ready", style: FACT_OK };
  const v = check.reason === "NO_TRUSTLINE" ? "No trustline" : check.reason === "TRUSTLINE_LIMIT_TOO_LOW" ? "Trustline limit reached" : "Account not funded";
  return { k, v, style: FACT_WARN };
}

function openCount(stats: RequestStats | undefined): number | null {
  if (!stats) return null;
  return OPEN_STATUSES.reduce((sum, status) => sum + (stats.byStatus[status] ?? 0), 0);
}

const openText = (n: number) => `${n} open request${n === 1 ? "" : "s"}`;

interface CardProps {
  wallet: Wallet;
  isDefault: boolean;
  now: number;
  verifyState: VerifyState;
  verifyBusy: boolean;
  onVerify: (w: Wallet) => void;
  onRemove: (w: Wallet, open: number | null) => void;
}

function WalletCard({ wallet: w, isDefault, now, verifyState, verifyBusy, onVerify, onRemove }: CardProps) {
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const { mutate: mutateMe } = useMe();
  const { data: stats } = useSWR<RequestStats>(`/v1/payment-requests/stats?walletId=${encodeURIComponent(w.id)}`, {
    refreshInterval: usePollWhenOffline(),
  });
  const [checking, setChecking] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = walletName(w);
  const open = openCount(stats);
  const checked = w.checkedAt !== null;
  const usdc = w.canReceive["USDC"];
  const verifying = verifyState.walletId === w.id ? verifyState.phase : null;
  const verifyError = verifyState.walletId === w.id ? verifyState.error : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(w.address);
      toast("Address copied");
    } catch {
      toast("Couldn't copy. Select the address and copy it by hand.");
    }
  };

  const refresh = async () => {
    if (checking) return;
    setChecking(true);
    setError(null);
    try {
      const res = await api.post<{ wallet: Wallet }>(`/v1/wallets/${w.id}/refresh`);
      await mutate("/v1/wallets");
      toast(res.wallet.canReceive["USDC"]?.canReceive ? `${name} is ready to receive USDC` : `${name} checked. It can't receive USDC yet.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  const makeDefault = async () => {
    if (settingDefault) return;
    setSettingDefault(true);
    setError(null);
    try {
      await api.post("/auth/settings", { defaultWalletId: w.id });
      await mutateMe();
      toast(`${name} is now your default`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSettingDefault(false);
    }
  };

  const facts: Fact[] = [
    {
      k: "Account on Testnet",
      v: checking ? "…" : !checked ? "Not checked yet" : w.accountExists ? "Found" : "Not found",
      style: checking || !checked ? FACT_GREY : w.accountExists ? FACT_OK : FACT_WARN,
    },
    ...Object.entries(w.canReceive).map(([code, check]) => receiveFact(code, check, checking, checked)),
    { k: "Ownership", v: w.verified ? "Signed" : "Waiting for signature", style: w.verified ? FACT_OK : FACT_WARN },
    { k: "Open requests", v: open === null ? "…" : `${open} open`, style: FACT_GREY },
  ];

  return (
    <section className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }} aria-label={name}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h2 style={{ fontSize: 18, fontWeight: 800, overflowWrap: "anywhere" }}>{name}</h2>
            {w.verified ? (
              <Pill tone="good" icon="check">
                Verified
              </Pill>
            ) : (
              <Pill tone="muted" icon="clock">
                Not verified
              </Pill>
            )}
            {isDefault ? (
              <span style={{ background: "var(--ink)", color: "#FFFFFF", padding: "3px 9px", borderRadius: 6, fontSize: 12, fontWeight: 700 }}>Default</span>
            ) : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mono" title={w.address} style={{ fontSize: 14, color: "var(--slate-strong)", wordBreak: "break-all" }}>
              {shortAddress(w.address, 6, 7)}
            </span>
            <button
              type="button"
              aria-label={`Copy address of ${name}`}
              onClick={copy}
              style={{
                width: 36,
                height: 36,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                borderRadius: 8,
                color: "var(--slate-strong)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Icon name="copy" size={16} />
            </button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {!w.verified ? (
            <button type="button" className="btn btn-primary btn-sm" style={SMALL_BTN} onClick={() => onVerify(w)} disabled={verifyBusy} aria-busy={verifyBusy}>
              Verify with Freighter
            </button>
          ) : null}
          {w.verified && !isDefault ? (
            <button type="button" className="btn btn-secondary btn-sm" style={SMALL_BTN} onClick={makeDefault} disabled={settingDefault} aria-busy={settingDefault}>
              {settingDefault ? "Saving…" : "Make default"}
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary btn-sm" style={SMALL_BTN} onClick={refresh} disabled={checking} aria-busy={checking}>
            {checking ? "Checking…" : "Refresh"}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ ...SMALL_BTN, color: "var(--error)" }}
            onClick={() => onRemove(w, open)}
            disabled={verifying !== null}
          >
            Remove
          </button>
        </div>
      </div>

      {verifying ? <VerifyProgress phase={verifying} /> : null}
      {verifyError ? (
        <div role="alert" className="notice">
          {verifyError}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        {facts.map((f) => (
          <div key={f.k} style={{ background: "var(--row)", borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--slate)", fontWeight: 600 }}>{f.k}</span>
            <span style={f.style}>{f.v}</span>
          </div>
        ))}
      </div>

      {checked && !checking && usdc && !usdc.canReceive ? (
        <div style={{ background: "var(--attention-bg)", border: "1px solid var(--attention-border)", borderRadius: 12, padding: "12px 14px", fontSize: 14, color: "#713F12" }}>
          {usdc.reason === "ACCOUNT_NOT_FOUND" ? (
            <>
              This wallet can&apos;t receive USDC yet. The account doesn&apos;t exist on Testnet until it holds some XLM. Fund it with free test XLM from{" "}
              <a href="https://lab.stellar.org/account/fund" target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
                Friendbot
              </a>
              , add a trustline for USDC (issuer{" "}
              <span className="mono" title={USDC_ISSUER}>
                {shortAddress(USDC_ISSUER)}
              </span>
              ), then tap Refresh.
            </>
          ) : usdc.reason === "TRUSTLINE_LIMIT_TOO_LOW" ? (
            <>
              This wallet can&apos;t receive more USDC. Its trustline limit is reached. In your wallet app, raise the limit on the USDC trustline (issuer{" "}
              <span className="mono" title={USDC_ISSUER}>
                {shortAddress(USDC_ISSUER)}
              </span>
              ), then tap Refresh.
            </>
          ) : (
            <>
              This wallet can&apos;t receive USDC yet. In your wallet app, add a trustline for USDC (issuer{" "}
              <span className="mono" title={USDC_ISSUER}>
                {shortAddress(USDC_ISSUER)}
              </span>
              ), then tap Refresh.
            </>
          )}
        </div>
      ) : null}

      <span style={{ fontSize: 12, color: "var(--slate)" }}>
        {checking ? "Checking Horizon…" : w.checkedAt ? `Checked ${timeAgo(w.checkedAt, now)}` : "Not checked on Testnet yet. Tap Refresh."}
      </span>
    </section>
  );
}

export default function WalletsPage() {
  const toast = useToast();
  const now = useNow();
  const { mutate } = useSWRConfig();
  const { merchant, mutate: mutateMe } = useMe();
  const { data, error, isLoading, mutate: reload } = useSWR<{ data: Wallet[] }>("/v1/wallets", { refreshInterval: usePollWhenOffline() });
  const { state: verifyState, verify, busy: verifyBusy } = useVerifyWallet();
  const [removing, setRemoving] = useState<{ wallet: Wallet; open: number | null } | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const wallets = data?.data ?? [];

  const onVerify = async (w: Wallet) => {
    const verified = await verify(w);
    if (verified) toast(`${walletName(verified)} verified`);
  };

  const closeRemove = () => {
    setRemoving(null);
    setRemoveError(null);
  };

  const doRemove = async () => {
    if (!removing || removeBusy) return;
    const name = walletName(removing.wallet);
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await api.delete(`/v1/wallets/${removing.wallet.id}`);
      await Promise.all([mutate("/v1/wallets"), mutateMe()]);
      setRemoving(null);
      toast(`${name} removed`);
    } catch (err) {
      setRemoveError(errorMessage(err));
    } finally {
      setRemoveBusy(false);
    }
  };

  const removingDefault = removing !== null && merchant?.defaultWalletId === removing.wallet.id;

  return (
    <>
      <div className="page-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h1 className="h1">Wallets</h1>
          <span className="sub">Where your customers&apos; payments land. PayLink never holds your funds or your keys.</span>
        </div>
        <a href="#add" className="btn btn-primary" style={{ fontSize: 15 }}>
          Add wallet
        </a>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {isLoading && !data ? (
          [0, 1].map((i) => (
            <div key={i} className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }} aria-hidden="true">
              <div className="skeleton" style={{ width: 220, maxWidth: "100%", height: 24 }} />
              <div className="skeleton" style={{ width: 160, height: 18 }} />
              <div className="skeleton" style={{ height: 62, borderRadius: 10 }} />
            </div>
          ))
        ) : error && !data ? (
          <div className="card empty" role="alert">
            <strong>We couldn&apos;t load your wallets</strong>
            <span>{errorMessage(error)}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => reload()} style={{ marginTop: 8 }}>
              Try again
            </button>
          </div>
        ) : wallets.length === 0 ? (
          <div className="card empty">
            <strong>No wallets yet</strong>
            <span>Add the public address of the wallet you want to be paid into. It takes a minute.</span>
          </div>
        ) : (
          wallets.map((w) => (
            <WalletCard
              key={w.id}
              wallet={w}
              isDefault={merchant?.defaultWalletId === w.id}
              now={now}
              verifyState={verifyState}
              verifyBusy={verifyBusy}
              onVerify={onVerify}
              onRemove={(wallet, open) => {
                setRemoveError(null);
                setRemoving({ wallet, open });
              }}
            />
          ))
        )}
      </div>

      <section id="add" className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 16, maxWidth: 720, scrollMarginTop: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 style={{ fontSize: 18, fontWeight: 800 }}>Add a wallet</h2>
          <span className="sub">Paste a public address from Freighter, Lobstr or any Stellar wallet.</span>
        </div>
        <AddWalletForm existing={wallets} onAdded={(w) => toast(`${walletName(w)} added`)} />
      </section>

      <Dialog
        open={removing !== null}
        onClose={closeRemove}
        title={removing ? `Remove ${walletName(removing.wallet)}?` : ""}
        width={480}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={closeRemove} disabled={removeBusy} aria-busy={removeBusy} style={{ fontSize: 15 }}>
              Keep wallet
            </button>
            <button
              type="button"
              className="btn"
              onClick={doRemove}
              disabled={removeBusy} aria-busy={removeBusy}
              style={{ background: "var(--error)", color: "#FFFFFF", fontSize: 15 }}
            >
              {removeBusy ? "Removing…" : "Remove wallet"}
            </button>
          </>
        }
      >
        <span style={{ fontSize: 15, color: "var(--slate)" }}>
          New requests can&apos;t use it any more. Money already in the wallet stays there, and past payments keep their history.
        </span>
        <span style={{ fontSize: 15, color: "var(--slate)" }}>
          {removing?.open ? `It has ${openText(removing.open)}. ` : ""}
          Open requests on it keep working until they close: customers can still pay them, and PayLink keeps watching the wallet until then.
        </span>
        {removingDefault ? (
          <span style={{ fontSize: 15, color: "var(--slate)" }}>This is your default wallet. Pick another default afterwards.</span>
        ) : null}
        {removeError ? (
          <div role="alert" className="alert">
            {removeError}
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
