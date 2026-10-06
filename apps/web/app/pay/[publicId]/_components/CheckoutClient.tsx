"use client";

import { useEffect, useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { Icon, type AnyIcon } from "@/components/Icon";
import { LogoMark } from "@/components/Logo";
import { explorerTx } from "@/lib/config";
import { countdown, formatAmount, formatDate, formatTime, initials, isPositive, shortAddress, shortHash, toStroops } from "@/lib/format";
import { isOpen } from "@/lib/status";
import type { Checkout } from "@/lib/types";
import styles from "./checkout.module.css";
import { PayOptions } from "./PayOptions";
import { useCheckout } from "./useCheckout";

const CONFIRM_WAIT_MS = 60_000;
const MONO: React.CSSProperties = { fontFamily: "var(--font-mono)" };
const CARD: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14 };

interface Waiting {
  via: "freighter" | "manual";
  /** Transaction hash, when the customer paid with Freighter. */
  hash: string | null;
  /** What the request looked like when they paid; any change means the payment was seen. */
  key: string;
}

const snapshotKey = (c: Checkout) => `${c.status}|${c.amountReceived}`;

/** Stroops back to a decimal string, for the "extra" on an overpaid request. */
function fromStroops(stroops: bigint): string {
  const digits = stroops.toString().padStart(8, "0");
  return `${digits.slice(0, -7)}.${digits.slice(-7)}`;
}

export function CheckoutClient({ publicId }: { publicId: string }) {
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  /** Set when 60 s passed without the payment showing up. */
  const [overdue, setOverdue] = useState<Waiting | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const { state, retry, setEager } = useCheckout(publicId);

  const checkout = state.phase === "ready" ? state.checkout : null;
  const open = checkout ? isOpen(checkout.status) : false;
  const key = checkout ? snapshotKey(checkout) : "";
  const confirming = open && waiting !== null && waiting.key === key;
  const closing = open && checkout !== null && new Date(checkout.expiresAt).getTime() <= now;
  const wantEager = confirming || closing;

  // While the customer waits for a payment (or for the link to close), also poll: belt and braces.
  useEffect(() => {
    setEager(wantEager);
  }, [wantEager, setEager]);

  useEffect(() => {
    if (!open) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [open]);

  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      setOverdue(waiting);
      setWaiting(null);
    }, CONFIRM_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  const onSent = (via: "freighter" | "manual", hash?: string) => {
    if (!checkout) return;
    setOverdue(null);
    setWaiting({ via, hash: hash ?? null, key: snapshotKey(checkout) });
  };

  return (
    <div className={styles.page}>
      <div className={`${styles.bar} ${styles.noPrint}`}>
        <div className={styles.barInner}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          Stellar Testnet · no real money
        </div>
      </div>

      <main className={styles.column}>
        {state.phase === "loading" && <Loading />}
        {state.phase === "not-found" && <NotFound />}
        {state.phase === "error" && <LoadError message={state.message} retry={retry} />}
        {state.phase === "ready" && (
          <Ready
            checkout={state.checkout}
            paidSeenAt={state.paidSeenAt}
            now={now}
            confirming={confirming ? waiting : null}
            overdue={open && overdue !== null && overdue.key === key ? overdue : null}
            closing={closing}
            onSent={onSent}
          />
        )}
      </main>

      <div className={`${styles.footer} ${styles.noPrint}`}>
        <LogoMark size={14} />
        Secured on Stellar · Powered by PayLink
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div style={{ ...CARD, padding: 18, display: "flex", flexDirection: "column", gap: 14 }} aria-busy="true">
      <span className="sr-only" role="status">
        Loading this payment…
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div className="skeleton" style={{ width: 40, height: 40, borderRadius: 10 }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="skeleton" style={{ width: "50%", height: 16 }} />
          <div className="skeleton" style={{ width: "70%", height: 13 }} />
        </div>
      </div>
      <div className="skeleton" style={{ width: "60%", height: 46, marginTop: 14 }} />
      <div className="skeleton" style={{ width: "100%", height: 24 }} />
    </div>
  );
}

function NotFound() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: 12, padding: 24 }}>
      <span
        aria-hidden="true"
        style={{ width: 56, height: 56, borderRadius: "50%", background: "var(--border)", color: "var(--slate)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 800 }}
      >
        ?
      </span>
      <h1 style={{ fontSize: 22, fontWeight: 800 }}>We can&apos;t find this payment link</h1>
      <span style={{ fontSize: 15, color: "var(--slate)" }}>
        Check the link you were sent, or ask the business for a new one. Don&apos;t send money to an address you can&apos;t confirm.
      </span>
    </div>
  );
}

function LoadError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: 12, padding: 24 }}>
      <span
        aria-hidden="true"
        style={{ width: 56, height: 56, borderRadius: "50%", background: "var(--border)", color: "var(--slate)", display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <Icon name="refresh" size={24} />
      </span>
      <h1 style={{ fontSize: 22, fontWeight: 800 }}>We couldn&apos;t load this payment</h1>
      <span style={{ fontSize: 15, color: "var(--slate)" }} role="alert">
        {message} Don&apos;t send anything until this page loads.
      </span>
      <button type="button" onClick={retry} className="btn btn-primary" style={{ minWidth: 160 }}>
        Try again
      </button>
    </div>
  );
}

interface ReadyProps {
  checkout: Checkout;
  paidSeenAt: number | null;
  now: number;
  confirming: Waiting | null;
  overdue: Waiting | null;
  closing: boolean;
  onSent: (via: "freighter" | "manual", hash?: string) => void;
}

function Ready({ checkout, paidSeenAt, now, confirming, overdue, closing, onSent }: ReadyProps) {
  const { status, businessName: biz } = checkout;
  const paid = status === "PAID" || status === "OVERPAID";
  const open = isOpen(status);
  const closed = status === "EXPIRED" || status === "CANCELLED" || status === "NETWORK_RESET";

  return (
    <>
      <div style={{ ...CARD, padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            aria-hidden="true"
            style={{ width: 40, height: 40, borderRadius: 10, background: "var(--teal-tint)", color: "var(--teal-deep)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, flexShrink: 0 }}
          >
            {initials(biz)}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <h1 style={{ fontSize: 16, fontWeight: 700, overflowWrap: "anywhere" }}>{biz}</h1>
            {checkout.description && <span style={{ fontSize: 13, color: "var(--slate)", overflowWrap: "anywhere" }}>{checkout.description}</span>}
          </div>
        </div>

        {paid ? (
          <PaidStamp checkout={checkout} paidSeenAt={paidSeenAt} />
        ) : (
          <Due checkout={checkout} now={now} confirming={confirming !== null} closing={closing} />
        )}
      </div>

      {paid && (
        <>
          <div style={{ ...CARD, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
            <Row label="Paid to">
              <span style={MONO} title={checkout.wallet}>
                {shortAddress(checkout.wallet)}
              </span>
            </Row>
            <Row label="Memo">
              <span style={MONO}>{checkout.memo}</span>
            </Row>
            <Row label="Network">Stellar Testnet</Row>
            {checkout.paidTxHash && (
              <Row label="Transaction">
                <a
                  href={explorerTx(checkout.paidTxHash)}
                  target="_blank"
                  rel="noreferrer"
                  style={{ ...MONO, fontWeight: 600, display: "inline-flex", gap: 4, alignItems: "center" }}
                  aria-label={`Transaction ${shortHash(checkout.paidTxHash)} on Stellar Expert (opens in a new tab)`}
                >
                  {shortHash(checkout.paidTxHash)}
                  <Icon name="external" size={13} strokeWidth={2.2} />
                </a>
              </Row>
            )}
          </div>
          <button type="button" onClick={() => window.print()} className={`btn btn-secondary btn-block ${styles.noPrint}`} style={{ height: 48, fontSize: 15, borderColor: "var(--border)" }}>
            Save receipt
          </button>
        </>
      )}

      {closed && <ClosedCard checkout={checkout} />}

      {confirming && (
        <div style={{ ...CARD, padding: "22px 18px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }} role="status">
          <span style={{ color: "var(--teal)", display: "inline-flex", transform: "scale(1.8)" }}>
            <span className={styles.spinner} aria-hidden="true" />
          </span>
          <span style={{ fontSize: 17, fontWeight: 800, marginTop: 6 }}>Confirming on Stellar…</span>
          <span style={{ fontSize: 14, color: "var(--slate)" }}>
            {confirming.via === "manual" ? (
              <>
                Watching {biz}&apos;s wallet for a payment with memo <span style={MONO}>{checkout.memo}</span>. This usually takes about 5 seconds.
              </>
            ) : (
              "Your payment is on its way. This usually takes about 5 seconds."
            )}
          </span>
        </div>
      )}

      {open && !confirming && closing && (
        <div style={{ background: "var(--muted-bg)", border: "1px solid var(--border-input)", borderRadius: 14, padding: 16, display: "flex", flexDirection: "column", gap: 8 }} role="status">
          <span style={{ fontWeight: 800 }}>This link is closing</span>
          <span style={{ fontSize: 14, color: "var(--slate-strong)" }}>
            Its time is up, so don&apos;t send a payment now. If you already paid, stay on this page: it will update by itself.
          </span>
        </div>
      )}

      {open && !confirming && !closing && (
        <>
          {overdue && (
            <div className="notice" role="status" style={{ borderRadius: 14, padding: "12px 16px" }}>
              {overdue.via === "freighter" ? (
                <>
                  Your payment was sent, but it hasn&apos;t shown up here yet. Don&apos;t pay again. This page will update by itself when it arrives
                  {overdue.hash ? (
                    <>
                      {" "}
                      (
                      <a href={explorerTx(overdue.hash)} target="_blank" rel="noreferrer" style={{ fontWeight: 700 }}>
                        see the transaction
                      </a>
                      )
                    </>
                  ) : null}
                  . If it still doesn&apos;t, tell {biz}.
                </>
              ) : (
                <>
                  Your payment hasn&apos;t shown up yet. If you sent it, don&apos;t send it again: this page will update by itself when it arrives. If you
                  haven&apos;t, check the amount and the memo below.
                </>
              )}
            </div>
          )}
          {!checkout.canReceive && <CannotReceive checkout={checkout} />}
          <PayOptions checkout={checkout} onSent={onSent} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ color: "var(--slate)" }}>To</span>
            <span style={MONO} title={checkout.wallet}>
              {shortAddress(checkout.wallet)}
            </span>
          </div>
        </>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, fontSize: 14 }}>
      <span style={{ color: "var(--slate)" }}>{label}</span>
      <span style={{ textAlign: "right", minWidth: 0, overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

function PaidStamp({ checkout, paidSeenAt }: { checkout: Checkout; paidSeenAt: number | null }) {
  const over = checkout.status === "OVERPAID";
  const code = checkout.asset.code;
  // The ledger time of the payment when the API has it; else when this page saw it flip.
  const seen = checkout.paidAt ?? (paidSeenAt === null ? null : new Date(paidSeenAt).toISOString());
  const extra = over ? toStroops(checkout.amountReceived) - toStroops(checkout.amount) : 0n;

  return (
    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 18, display: "flex", flexDirection: "column", alignItems: "center", gap: 10, textAlign: "center" }} role="status">
      <div
        className={styles.stamp}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          border: "3px solid var(--teal)",
          outline: "1.5px solid var(--teal)",
          outlineOffset: 4,
          borderRadius: 12,
          padding: "8px 22px",
          color: "var(--teal)",
          transform: "rotate(-6deg)",
          margin: "8px 0 6px",
        }}
      >
        <span style={{ fontSize: 34, fontWeight: 800, letterSpacing: "0.14em" }}>PAID</span>
        {seen && (
          <span style={{ ...MONO, fontSize: 11 }}>
            {formatDate(seen).toUpperCase()} · {formatTime(seen)}
          </span>
        )}
      </div>
      <span className="tnum" style={{ fontSize: 30, fontWeight: 800 }}>
        {formatAmount(over ? checkout.amountReceived : checkout.amount)} <span style={{ fontSize: 16, color: "var(--slate)" }}>{code}</span>
      </span>
      <span style={{ fontSize: 14, color: "var(--slate)" }}>{checkout.businessName} has been told. You can close this page.</span>
      {over && extra > 0n && (
        <span style={{ fontSize: 13, color: "var(--attention-fg)", fontWeight: 600 }}>
          That is {formatAmount(fromStroops(extra))} {code} more than the {formatAmount(checkout.amount)} {code} asked for. {checkout.businessName} has been told about the
          extra.
        </span>
      )}
    </div>
  );
}

const PILLS: Record<string, { label: string; tone: string; icon: AnyIcon }> = {
  PENDING: { label: "Pending", tone: "pill-neutral", icon: "clock" },
  UNDERPAID: { label: "Partly paid", tone: "pill-warn", icon: "alert" },
  CONFIRMING: { label: "Confirming", tone: "pill-good", icon: "clock" },
  CLOSING: { label: "Closing…", tone: "pill-muted", icon: "clock" },
  EXPIRED: { label: "Expired", tone: "pill-muted", icon: "cross" },
  CANCELLED: { label: "Cancelled", tone: "pill-muted", icon: "dash" },
  NETWORK_RESET: { label: "Closed", tone: "pill-muted", icon: "dash" },
};

function Due({ checkout, now, confirming, closing }: { checkout: Checkout; now: number; confirming: boolean; closing: boolean }) {
  const { status } = checkout;
  const code = checkout.asset.code;
  const open = isOpen(status);
  const under = status === "UNDERPAID";
  const pill = PILLS[confirming ? "CONFIRMING" : closing ? "CLOSING" : status] ?? PILLS.PENDING!;

  // Whole percent of the total received, in exact integer maths.
  const total = toStroops(checkout.amount);
  const percent = total > 0n ? (toStroops(checkout.amountReceived) * 100n) / total : 0n;
  const width = `${percent > 100n ? 100 : percent.toString()}%`;

  return (
    <>
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14, display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 13, color: "var(--slate)" }}>{under ? "Still due" : open ? "Amount due" : "Amount"}</span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span className="tnum" style={{ fontSize: 42, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.15, color: open ? "var(--ink)" : "var(--slate-soft)", overflowWrap: "anywhere" }}>
            {formatAmount(open ? checkout.amountRemaining : checkout.amount)}
          </span>
          <span style={{ fontSize: 17, fontWeight: 600, color: "var(--slate)" }}>{code}</span>
        </div>
        {under && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
            <div
              role="progressbar"
              aria-label="Amount received"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent > 100n ? 100 : parseInt(percent.toString(), 10)}
              style={{ height: 8, borderRadius: 999, background: "var(--border)", overflow: "hidden" }}
            >
              <div style={{ width, height: 8, background: "#D97706" }} />
            </div>
            <span style={{ fontSize: 13, color: "var(--attention-fg)", fontWeight: 600 }}>
              {formatAmount(checkout.amountReceived)} of {formatAmount(checkout.amount)} received. Send the rest with the same memo.
            </span>
          </div>
        )}
        {!open && isPositive(checkout.amountReceived) && (
          <span style={{ fontSize: 13, color: "var(--slate)" }}>
            {formatAmount(checkout.amountReceived)} of {formatAmount(checkout.amount)} {code} was received.
          </span>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className={`pill ${pill.tone}`} style={{ padding: "4px 10px", fontWeight: 700 }}>
          <Icon name={pill.icon} size={13} strokeWidth={2.4} />
          {pill.label}
        </span>
        {open && !confirming && !closing && (
          <span style={{ fontSize: 13, color: "var(--slate)" }}>
            Expires in{" "}
            <span role="timer" style={{ ...MONO, color: "var(--ink)", fontWeight: 600 }}>
              {countdown(checkout.expiresAt, now)}
            </span>
          </span>
        )}
        {status === "EXPIRED" && (
          <span style={{ fontSize: 13, color: "var(--slate)" }}>
            Expired{" "}
            <span style={{ ...MONO, color: "var(--ink)", fontWeight: 600 }}>
              {formatDate(checkout.expiresAt)}, {formatTime(checkout.expiresAt)}
            </span>
          </span>
        )}
      </div>
    </>
  );
}

function ClosedCard({ checkout }: { checkout: Checkout }) {
  const biz = checkout.businessName;
  const contact = checkout.supportContact?.trim() || null;
  const isPhone = contact !== null && /^[+\d][\d\s().-]{5,}$/.test(contact);

  const copy =
    checkout.status === "CANCELLED"
      ? { title: "This payment was cancelled", body: `${biz} cancelled this request, so don't send a payment. If you already paid, don't pay again. They can see your payment.` }
      : checkout.status === "NETWORK_RESET"
        ? {
            title: "This link is closed",
            body: `Stellar Testnet was reset, which closed this request. Don't send a payment. If you still need to pay, ask ${biz} for a new link.`,
          }
        : { title: "This link has expired", body: `Ask ${biz} for a new link. If you already paid, don't pay again. They can see your payment.` };

  return (
    <div style={{ background: "var(--muted-bg)", border: "1px solid var(--border-input)", borderRadius: 14, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ fontWeight: 800 }}>{copy.title}</span>
      <span style={{ fontSize: 14, color: "var(--slate-strong)" }}>{copy.body}</span>
      {contact && (
        <>
          <span style={{ fontSize: 14, color: "var(--slate-strong)" }}>
            Reach {biz}: <span style={{ fontWeight: 700, color: "var(--ink)", overflowWrap: "anywhere" }}>{contact}</span>
          </span>
          <CopyButton
            value={contact}
            label={`Copy ${biz}'s ${isPhone ? "number" : "contact"}`}
            copiedLabel={`${contact} copied`}
            className="btn btn-secondary btn-block"
            style={{ height: 44, whiteSpace: "normal", lineHeight: 1.2 }}
          />
        </>
      )}
    </div>
  );
}

function CannotReceive({ checkout }: { checkout: Checkout }) {
  const biz = checkout.businessName;
  const code = checkout.asset.code;
  const why =
    checkout.cannotReceiveReason === "ACCOUNT_NOT_FOUND"
      ? `${biz}'s wallet isn't active on Stellar Testnet yet.`
      : checkout.cannotReceiveReason === "NO_TRUSTLINE"
        ? `${biz}'s wallet isn't set up to hold ${code} yet.`
        : checkout.cannotReceiveReason === "TRUSTLINE_LIMIT_TOO_LOW"
          ? `${biz}'s wallet can't hold this much ${code} right now.`
          : `${biz}'s wallet can't accept this payment right now.`;

  return (
    <div className="alert" role="alert" style={{ borderRadius: 14, padding: "14px 16px", display: "flex", gap: 10, alignItems: "flex-start" }}>
      <Icon name="alert" size={18} style={{ marginTop: 1 }} />
      <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontWeight: 800 }}>Don&apos;t send this payment yet</span>
        <span>
          {why} A payment sent now would fail. Tell {biz} so they can fix it, then reload this page.
        </span>
      </span>
    </div>
  );
}
