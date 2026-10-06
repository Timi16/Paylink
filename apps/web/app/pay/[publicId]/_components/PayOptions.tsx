"use client";

import { useEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { formatAmount, shortAddress } from "@/lib/format";
import { FreighterError } from "@/lib/freighter";
import { PayError, payWithFreighter } from "@/lib/stellar-pay";
import type { Checkout } from "@/lib/types";
import styles from "./checkout.module.css";

type Tab = "freighter" | "qr" | "manual";
const TABS: { key: Tab; label: string }[] = [
  { key: "freighter", label: "Freighter" },
  { key: "qr", label: "Scan QR" },
  { key: "manual", label: "Pay manually" },
];

const MONO: React.CSSProperties = { fontFamily: "var(--font-mono)" };
const COPY: React.CSSProperties = { height: 40, minWidth: 64, borderColor: "var(--border)", flexShrink: 0 };
const SMALL_LABEL: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "var(--slate)" };
const WHITE_CARD: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14 };

interface Props {
  checkout: Checkout;
  /** The customer paid with Freighter (hash known) or says they sent it from another wallet. */
  onSent: (via: "freighter" | "manual", hash?: string) => void;
}

/** The three ways to pay an open request: Freighter, a SEP-7 QR code, or by hand. */
export function PayOptions({ checkout, onSent }: Props) {
  const [tab, setTab] = useState<Tab>("freighter");
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const at = TABS.findIndex((t) => t.key === tab);
    const next = TABS[(at + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    if (!next) return;
    setTab(next.key);
    tabRefs.current[next.key]?.focus();
  };

  return (
    <>
      <div
        role="tablist"
        aria-label="How to pay"
        onKeyDown={onKey}
        style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 4, background: "var(--border)", padding: 4, borderRadius: 12 }}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            ref={(el) => {
              tabRefs.current[t.key] = el;
            }}
            type="button"
            role="tab"
            id={`pay-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls="pay-panel"
            tabIndex={tab === t.key ? 0 : -1}
            onClick={() => setTab(t.key)}
            className={styles.tab}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div key={tab} className={styles.panel} role="tabpanel" id="pay-panel" aria-labelledby={`pay-tab-${tab}`}>
        {tab === "freighter" && <FreighterPanel checkout={checkout} onSent={onSent} />}
        {tab === "qr" && <QrPanel uri={checkout.sep7Uri} />}
        {tab === "manual" && <ManualPanel checkout={checkout} onSent={onSent} />}
      </div>
    </>
  );
}

function FreighterPanel({ checkout, onSent }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const code = checkout.asset.code;

  const pay = async () => {
    if (busy || !checkout.canReceive) return;
    setBusy(true);
    setError(null);
    try {
      const { hash } = await payWithFreighter({
        destination: checkout.wallet,
        asset: checkout.asset,
        amount: checkout.amountRemaining,
        memo: checkout.memo,
      });
      onSent("freighter", hash);
    } catch (err) {
      setError(err instanceof FreighterError || err instanceof PayError ? err.message : "That didn't go through. Nothing was sent. Try again.");
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ background: "var(--attention-bg)", border: "1px solid var(--attention-border)", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--attention-fg)" }}>Memo required</span>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span style={{ ...MONO, fontSize: 23, fontWeight: 600, letterSpacing: "0.05em", wordBreak: "break-all" }}>{checkout.memo}</span>
          <CopyButton value={checkout.memo} style={COPY} ariaLabel="Copy memo" />
        </div>
        <span style={{ fontSize: 13, color: "var(--slate)" }}>Freighter fills it in for you.</span>
      </div>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      <button
        type="button"
        onClick={pay}
        disabled={busy || !checkout.canReceive}
        aria-busy={busy}
        className="btn btn-primary btn-block"
        style={{ height: 52, fontSize: 16, whiteSpace: "normal", lineHeight: 1.2 }}
      >
        {busy ? (
          <>
            <span className={styles.spinner} aria-hidden="true" />
            Waiting for Freighter…
          </>
        ) : (
          `Pay ${formatAmount(checkout.amountRemaining)} ${code} with Freighter`
        )}
      </button>
      {busy && (
        <span role="status" style={{ fontSize: 13, color: "var(--slate)", textAlign: "center" }}>
          Approve the payment in the Freighter window. Keep this page open.
        </span>
      )}
      {!busy && <span style={{ fontSize: 13, color: "var(--slate)", textAlign: "center" }}>No Freighter? Use Scan QR or Pay manually.</span>}
    </div>
  );
}

function QrPanel({ uri }: { uri: string }) {
  const [qr, setQr] = useState<{ uri: string; src: string | null } | null>(null);

  useEffect(() => {
    let live = true;
    import("qrcode")
      .then((mod) => {
        // CommonJS package: depending on the bundler the functions sit on the namespace or on `default`.
        const lib = mod.default ?? mod;
        return lib.toString(uri, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#0F172A", light: "#FFFFFF" } });
      })
      .then((svg) => {
        if (live) setQr({ uri, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
      })
      .catch(() => {
        if (live) setQr({ uri, src: null });
      });
    return () => {
      live = false;
    };
  }, [uri]);

  const ready = qr && qr.uri === uri ? qr : null;

  return (
    <div style={{ ...WHITE_CARD, padding: 18, display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
      {ready?.src ? (
        <img src={ready.src} width={200} height={200} alt="QR code with the amount and memo" style={{ imageRendering: "pixelated" }} />
      ) : ready ? (
        <div className="alert" role="alert" style={{ width: "100%" }}>
          Couldn&apos;t draw the QR code. Copy the payment link below, or use Pay manually.
        </div>
      ) : (
        <div className="skeleton" style={{ width: 200, height: 200 }} aria-label="Drawing the QR code" />
      )}
      <span style={{ fontSize: 14, color: "var(--slate-strong)" }}>Scan with a Stellar wallet like Lobstr. The amount and memo fill in for you.</span>
      <CopyButton value={uri} label="Copy payment link" copiedLabel="Payment link copied" className="btn btn-secondary btn-block" style={{ height: 44, borderColor: "var(--border)" }} />
    </div>
  );
}

function ManualPanel({ checkout, onSent }: Props) {
  const { asset } = checkout;
  // What a wallet's amount box accepts: no thousands separators.
  const plainAmount = formatAmount(checkout.amountRemaining).replace(/,/g, "");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ ...WHITE_CARD, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={SMALL_LABEL}>Send to</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ ...MONO, flex: 1, fontSize: 12, wordBreak: "break-all" }}>{checkout.wallet}</span>
            <CopyButton value={checkout.wallet} style={COPY} ariaLabel="Copy address" />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={SMALL_LABEL}>Amount</span>
            <span style={{ ...MONO, fontSize: 16, fontWeight: 600 }}>
              {formatAmount(checkout.amountRemaining)} {asset.code}
            </span>
          </div>
          <CopyButton value={plainAmount} style={COPY} ariaLabel="Copy amount" />
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={SMALL_LABEL}>Asset</span>
            {asset.issuer ? (
              <span style={{ fontSize: 14 }}>
                {asset.code} · issuer{" "}
                <span style={MONO} title={asset.issuer}>
                  {shortAddress(asset.issuer)}
                </span>
              </span>
            ) : (
              <span style={{ fontSize: 14 }}>{asset.code} · Stellar&apos;s own currency (no issuer)</span>
            )}
          </div>
          {asset.issuer && <CopyButton value={asset.issuer} style={COPY} ariaLabel="Copy asset issuer" />}
        </div>
      </div>

      <div style={{ background: "var(--attention-bg)", border: "1.5px solid #D97706", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: "var(--attention-fg)" }}>Memo (text) · required</span>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span style={{ ...MONO, fontSize: 22, fontWeight: 600, letterSpacing: "0.05em", wordBreak: "break-all" }}>{checkout.memo}</span>
          <CopyButton value={checkout.memo} style={COPY} ariaLabel="Copy memo" />
        </div>
        <span style={{ fontSize: 13, color: "#713F12" }}>Choose the Text memo type. Without it, your payment can&apos;t be matched.</span>
      </div>

      <details className={styles.disclosure} style={{ ...WHITE_CARD, padding: "12px 16px" }}>
        <summary>Your wallet can&apos;t send a text memo? Send to this address instead</summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ ...MONO, flex: 1, fontSize: 12, wordBreak: "break-all" }}>{checkout.muxedAddress}</span>
            <CopyButton value={checkout.muxedAddress} style={COPY} ariaLabel="Copy the address that needs no memo" />
          </div>
          <span style={{ fontSize: 13, color: "var(--slate)" }}>
            This address (it starts with M) already carries this payment&apos;s reference, so leave the memo empty. Send the same amount and asset.
          </span>
        </div>
      </details>

      <button type="button" onClick={() => onSent("manual")} className="btn btn-primary btn-block" style={{ height: 50, fontSize: 15 }}>
        I&apos;ve sent it
      </button>
    </div>
  );
}
