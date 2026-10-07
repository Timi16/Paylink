"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icon";
import { Pill, RequestStatusPill } from "@/components/StatusPill";
import { useToast } from "@/components/Toast";
import { api, errorMessage } from "@/lib/api";
import { explorerAccount, explorerTx } from "@/lib/config";
import { formatAmount, formatDateTime, formatTime, shortAddress, shortHash, toStroops } from "@/lib/format";
import { usePollWhenOffline } from "@/lib/live";
import { useWallets } from "@/lib/session";
import { isOpen, PAYMENT_OUTCOME, REQUEST_STATUS, requestSubtitle, requestTitle } from "@/lib/status";
import type { ChainPayment, Page, PaymentRequest, RequestDetail } from "@/lib/types";

const UNMATCHED_PATH = "/v1/payments?unmatched=true&limit=100";

interface Resolved {
  eventId: string;
  amount: string;
  code: string;
  from: string;
  what: string;
  requestId: string | null;
}

/** Funds from before a testnet reset no longer exist on the network, so they cannot pay a request. */
const isPreReset = (p: ChainPayment) => p.eventId.startsWith("reset-");
const canAssign = (p: ChainPayment) => !isPreReset(p) && p.walletId !== null;

/** Today's payments show the time; older ones the date too. */
function when(iso: string): string {
  return new Date(iso).toDateString() === new Date().toDateString() ? formatTime(iso) : formatDateTime(iso);
}

function memoSent(p: ChainPayment): string {
  if (p.memo === null || p.memo === "") return p.toMuxedId ? `${p.toMuxedId} (muxed ID)` : "none";
  if (p.memoType === "id") return `${p.memo} (ID)`;
  if (p.memoType === "hash") return `${shortHash(p.memo)} (hash)`;
  return p.memo;
}

/** Stroops -> decimal string with 7 decimals, for formatAmount. */
function fromStroops(stroops: bigint): string {
  return `${stroops / 10_000_000n}.${(stroops % 10_000_000n).toString().padStart(7, "0")}`;
}

/** What assigning `payment` to `request` would do, in plain words. */
function assignEffect(payment: ChainPayment, request: PaymentRequest): { text: string; tone: "good" | "warn" | "muted" } {
  switch (request.status) {
    case "PAID":
    case "OVERPAID":
      return { text: "Already paid: becomes a refund", tone: "muted" };
    case "EXPIRED":
      return { text: "Expired: arrives as late", tone: "muted" };
    case "CANCELLED":
      return { text: "Cancelled: arrives as after cancel", tone: "muted" };
    case "NETWORK_RESET":
      return { text: "Closed by a testnet reset: won't count", tone: "muted" };
    default: {
      const paid = toStroops(payment.amount);
      const due = toStroops(request.amountRemaining);
      if (paid === due) return { text: "Pays it in full", tone: "good" };
      if (paid < due) return { text: `Leaves ${formatAmount(fromStroops(due - paid))} due`, tone: "warn" };
      return { text: `Overpays by ${formatAmount(fromStroops(paid - due))}`, tone: "warn" };
    }
  }
}

const EFFECT_COLOR = { good: "var(--teal-deep)", warn: "var(--attention-fg)", muted: "var(--slate)" } as const;

const rowBtn: React.CSSProperties = { height: 40, padding: "0 14px", borderRadius: 8, fontSize: 13 };

export default function UnmatchedPage() {
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const { data, error, isLoading, mutate: reload } = useSWR<Page<ChainPayment>>(UNMATCHED_PATH, { refreshInterval: usePollWhenOffline() });
  const [assigning, setAssigning] = useState<ChainPayment | null>(null);
  const [refunding, setRefunding] = useState<ChainPayment | null>(null);
  const [resolved, setResolved] = useState<Resolved[]>([]);

  // Hide what was resolved in this session straight away; the refreshed list then agrees.
  const rows = data?.data.filter((p) => !resolved.some((r) => r.eventId === p.eventId));

  const refreshLists = () => {
    for (const prefix of ["/v1/payments", "/v1/payment-requests", "/v1/summary"]) {
      void mutate((k) => typeof k === "string" && k.startsWith(prefix));
    }
  };

  const resolve = (p: ChainPayment, what: string, requestId: string | null) => {
    setResolved((list) => [{ eventId: p.eventId, amount: p.amount, code: p.asset.code, from: p.from, what, requestId }, ...list]);
    refreshLists();
  };

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 760 }}>
        <h1 className="h1">Unmatched payments</h1>
        <span className="sub">
          These reached your wallet but couldn&apos;t be tied to a request, usually because the memo was missing or mistyped. Assign each one to the right
          request, or refund it.
        </span>
      </div>

      {error && !data ? (
        <div className="card empty" role="alert">
          <strong>We couldn&apos;t load unmatched payments</strong>
          <span>{errorMessage(error)}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => reload()} style={{ marginTop: 6 }}>
            Try again
          </button>
        </div>
      ) : !rows ? (
        <div className="card" style={{ overflow: "hidden" }} aria-busy={isLoading}>
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 860 }}>
              <TableHead />
              <tbody>
                {Array.from({ length: 3 }, (_, i) => (
                  <tr key={i}>
                    {["00:00", "000.00 USDC", "GXXX…XXXX", "XXXXXXXXXXX", "Unknown memo", "xxxx…xxxx", "Assign  Mark refunded"].map((text, j) => (
                      <td key={j} style={{ textAlign: j === 1 || j === 6 ? "right" : undefined }}>
                        <span className="skeleton">{text}</span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : rows.length > 0 ? (
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 860 }}>
              <TableHead />
              <tbody>
                {rows.map((p) => (
                  <tr key={p.eventId}>
                    <td title={new Date(p.ledgerClosedAt).toLocaleString("en-GB")}>{when(p.ledgerClosedAt)}</td>
                    <td className="num" style={{ fontWeight: 600 }}>
                      {formatAmount(p.amount)} {p.asset.code}
                    </td>
                    <td className="mono" style={{ fontSize: 13 }}>
                      <a href={explorerAccount(p.from)} target="_blank" rel="noreferrer" title={p.from}>
                        {shortAddress(p.from)}
                      </a>
                    </td>
                    <td className="mono" style={{ fontSize: 13, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }} title={p.memo ?? undefined}>
                      {memoSent(p)}
                    </td>
                    <td style={{ whiteSpace: "normal", minWidth: 220 }}>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                        <Pill tone="warn">{PAYMENT_OUTCOME[p.outcome].label}</Pill>
                        <span style={{ fontSize: 12, color: "var(--slate)" }}>{PAYMENT_OUTCOME[p.outcome].explain}</span>
                      </div>
                    </td>
                    <td>
                      <a
                        href={explorerTx(p.txHash)}
                        target="_blank"
                        rel="noreferrer"
                        className="mono"
                        style={{ fontSize: 13, display: "inline-flex", gap: 4, alignItems: "center" }}
                        aria-label={`Transaction ${shortHash(p.txHash)} on Stellar Expert`}
                      >
                        {shortHash(p.txHash)}
                        <Icon name="external" size={13} strokeWidth={2.2} />
                      </a>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                        <div style={{ display: "inline-flex", gap: 8 }}>
                          {canAssign(p) ? (
                            <button type="button" className="btn btn-primary" style={rowBtn} onClick={() => setAssigning(p)}>
                              Assign
                            </button>
                          ) : null}
                          <button type="button" className="btn btn-secondary" style={{ ...rowBtn, borderColor: "var(--border)" }} onClick={() => setRefunding(p)}>
                            Mark refunded
                          </button>
                        </div>
                        {isPreReset(p) ? <span style={{ fontSize: 12, color: "var(--slate)" }}>From before a testnet reset: can&apos;t be assigned.</span> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data?.nextCursor ? (
            <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", fontSize: 13, color: "var(--slate)" }}>
              Showing the 100 most recent. Older ones appear as you resolve these.
            </div>
          ) : null}
        </div>
      ) : (
        <div className="card" style={{ padding: "56px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, textAlign: "center" }}>
          <span
            style={{ width: 56, height: 56, borderRadius: "50%", background: "var(--teal-tint)", color: "var(--teal)", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="check" size={26} strokeWidth={2.6} />
          </span>
          <span style={{ fontSize: 19, fontWeight: 800 }}>All caught up</span>
          <span style={{ fontSize: 14, color: "var(--slate)", maxWidth: 420 }}>Every payment that reached your wallets is tied to a request or refunded.</span>
          <Link href="/payments" className="btn btn-secondary" style={{ padding: "0 18px", fontSize: 15, marginTop: 6 }}>
            See all payments
          </Link>
        </div>
      )}

      {resolved.length > 0 ? (
        <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-live="polite">
          <h2 style={{ fontSize: 16, fontWeight: 800 }}>Resolved just now</h2>
          {resolved.map((x) => (
            <div key={x.eventId} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 14, flexWrap: "wrap" }}>
              <span style={{ color: "var(--teal)", display: "inline-flex" }}>
                <Icon name="check" size={14} strokeWidth={2.6} />
              </span>
              <span className="mono">
                {formatAmount(x.amount)} {x.code}
              </span>
              <span className="muted">from {shortAddress(x.from)}</span>
              <span style={{ fontWeight: 700 }}>{x.what}</span>
              {x.requestId ? (
                <Link href={`/requests/${x.requestId}`} style={{ fontWeight: 700 }}>
                  Open request
                </Link>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <div style={{ background: "var(--surface)", border: "1px dashed var(--border-input)", borderRadius: 14, padding: "16px 18px", fontSize: 14, color: "var(--slate-strong)" }}>
        To prevent these, share links with the QR code or the Freighter button. Both fill in the memo for your customer.
      </div>

      {assigning ? (
        <AssignDialog
          key={assigning.eventId}
          payment={assigning}
          onClose={() => setAssigning(null)}
          onDone={(request) => {
            const title = requestTitle(request);
            resolve(assigning, `Assigned to ${title}`, request.id);
            toast(`${formatAmount(assigning.amount)} ${assigning.asset.code} assigned to ${title} · now ${REQUEST_STATUS[request.status].label}`);
            setAssigning(null);
          }}
        />
      ) : null}
      {refunding ? (
        <RefundDialog
          key={refunding.eventId}
          payment={refunding}
          onClose={() => setRefunding(null)}
          onDone={() => {
            resolve(refunding, "Marked refunded", null);
            toast("Marked as refunded");
            setRefunding(null);
          }}
        />
      ) : null}
    </>
  );
}

function TableHead() {
  return (
    <thead>
      <tr>
        <th>Time</th>
        <th style={{ textAlign: "right" }}>Amount</th>
        <th>From</th>
        <th>Memo sent</th>
        <th>Why it didn&apos;t match</th>
        <th>Transaction</th>
        <th style={{ textAlign: "right" }}>Actions</th>
      </tr>
    </thead>
  );
}

function AssignDialog({ payment, onClose, onDone }: { payment: ChainPayment; onClose: () => void; onDone: (request: PaymentRequest) => void }) {
  const searchId = useId();
  const poll = usePollWhenOffline();
  const suggestedId = payment.suggestedRequestId;
  const list = useSWR<Page<PaymentRequest>>(`/v1/payment-requests?walletId=${encodeURIComponent(payment.walletId ?? "")}&limit=100`, { refreshInterval: poll });
  // The suggested request may be older than the 100 listed: fetch it by id when it is missing.
  const suggestedMissing = Boolean(suggestedId && list.data && !list.data.data.some((r) => r.id === suggestedId));
  const extra = useSWR<RequestDetail>(suggestedMissing ? `/v1/payment-requests/${suggestedId}` : null);
  const wallets = useWallets();

  const [query, setQuery] = useState("");
  const [pick, setPick] = useState<string | null>(suggestedId);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const code = payment.asset.code;
  const wallet = wallets.data?.data.find((w) => w.id === payment.walletId);
  const walletName = wallet ? wallet.label || shortAddress(wallet.address) : shortAddress(payment.to);

  const candidates = useMemo(() => {
    const all = [...(list.data?.data ?? [])];
    if (extra.data && !all.some((r) => r.id === extra.data?.request.id)) all.push(extra.data.request);
    const paid = toStroops(payment.amount);
    const gap = (r: PaymentRequest) => {
      const diff = toStroops(r.amountRemaining) - paid;
      return diff < 0n ? -diff : diff;
    };
    const rank = (r: PaymentRequest) => (r.id === suggestedId ? 0 : isOpen(r.status) ? 1 : 2);
    return all
      .filter((r) => r.asset.code === payment.asset.code && r.asset.issuer === payment.asset.issuer)
      .sort((a, b) => {
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        if (rank(a) === 1) {
          // Open requests: closest amount due first.
          const ga = gap(a);
          const gb = gap(b);
          if (ga !== gb) return ga < gb ? -1 : 1;
        }
        return b.createdAt.localeCompare(a.createdAt);
      });
  }, [list.data, extra.data, payment, suggestedId]);

  const q = query.trim().toLowerCase();
  const shown = candidates.filter(
    (r) => !q || [r.customerRef, r.description, r.memo].some((text) => text?.toLowerCase().includes(q)),
  );
  const picked = candidates.find((r) => r.id === pick) ?? null;

  const assign = async () => {
    if (!picked || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await api.post<{ payment: ChainPayment; request: PaymentRequest }>(`/v1/payments/${encodeURIComponent(payment.eventId)}/assign`, {
        requestId: picked.id,
      });
      onDone(res.request);
    } catch (err) {
      // PAYMENT_NOT_ASSIGNABLE and the rest carry a plain message from the API.
      setFailure(errorMessage(err));
      setBusy(false);
    }
  };

  const loading = !list.data && list.isLoading;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Assign ${formatAmount(payment.amount)} ${code}`}
      width={540}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy} aria-busy={busy} style={{ padding: "0 18px", fontSize: 15 }}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={assign}
            disabled={!picked || busy}
            style={{ fontSize: 15, maxWidth: "100%", ...(picked ? null : { background: "var(--border)", color: "#64748B", opacity: 1 }) }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {busy ? "Assigning…" : picked ? `Assign to ${requestTitle(picked)}` : "Pick a request"}
            </span>
          </button>
        </>
      }
    >
      <span style={{ fontSize: 14, color: "var(--slate)", marginTop: -8 }}>
        From <span className="mono">{shortAddress(payment.from)}</span> at {when(payment.ledgerClosedAt)} · {PAYMENT_OUTCOME[payment.outcome].label.toLowerCase()}
      </span>
      <div>
        <label htmlFor={searchId} className="sr-only">
          Search requests
        </label>
        <input
          id={searchId}
          type="search"
          className="input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by order or description"
        />
      </div>
      <fieldset style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }} disabled={busy} aria-busy={busy}>
        <legend style={{ fontSize: 13, fontWeight: 700, color: "var(--slate)", padding: 0, marginBottom: 8 }}>Which request is this for?</legend>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 320, overflowY: "auto", padding: 2 }}>
          {loading ? (
            Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="skeleton" style={{ height: 62, borderRadius: 12 }}>
                Loading
              </div>
            ))
          ) : list.error && !list.data ? (
            <div className="alert" role="alert" style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
              {errorMessage(list.error)}
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => list.mutate()}>
                Try again
              </button>
            </div>
          ) : shown.length === 0 ? (
            <span style={{ fontSize: 14, color: "var(--slate)", padding: "12px 0" }}>
              {q ? `No ${code} requests match that search.` : `No ${code} requests on this wallet yet.`}
            </span>
          ) : (
            shown.map((r) => {
              const on = pick === r.id;
              const effect = assignEffect(payment, r);
              const sub = requestSubtitle(r);
              return (
                <label
                  key={r.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: on ? "12px 14px" : "13px 15px",
                    borderRadius: 12,
                    border: on ? "2px solid var(--teal)" : "1px solid var(--border)",
                    background: on ? "#F0FAF8" : "var(--surface)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="radio"
                    name="assign-candidate"
                    checked={on}
                    onChange={() => setPick(r.id)}
                    style={{ width: 18, height: 18, accentColor: "var(--teal)", margin: 0, flexShrink: 0 }}
                  />
                  <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 700, overflowWrap: "anywhere" }}>
                        {requestTitle(r)}
                        {sub !== requestTitle(r) ? <span style={{ fontWeight: 400, color: "var(--slate)" }}> · {sub}</span> : null}
                      </span>
                      {r.id === suggestedId ? (
                        <Pill tone="good" icon="check">
                          Exact amount match
                        </Pill>
                      ) : null}
                    </span>
                    <span style={{ fontSize: 13, color: EFFECT_COLOR[effect.tone], fontWeight: effect.tone === "muted" ? 400 : 600 }}>{effect.text}</span>
                  </span>
                  {isOpen(r.status) ? (
                    <span className="mono" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                      {formatAmount(r.amountRemaining)} <span style={{ fontWeight: 400, color: "var(--slate)", fontFamily: "var(--font-sans)", fontSize: 12 }}>due</span>
                    </span>
                  ) : (
                    <RequestStatusPill status={r.status} />
                  )}
                </label>
              );
            })
          )}
        </div>
      </fieldset>
      <span style={{ fontSize: 13, color: "var(--slate)" }}>
        Showing {code} requests on {walletName} only, since that&apos;s where this payment landed.
        {list.data?.nextCursor ? " Only the 100 most recent are listed." : ""}
      </span>
      {failure ? (
        <div className="alert" role="alert">
          {failure}
        </div>
      ) : null}
    </Dialog>
  );
}

function RefundDialog({ payment, onClose, onDone }: { payment: ChainPayment; onClose: () => void; onDone: () => void }) {
  const hashId = useId();
  const [hash, setHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const txHash = hash.trim().toLowerCase();
  const badHash = txHash !== "" && !/^[0-9a-f]{64}$/.test(txHash);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (busy || badHash) return;
    setBusy(true);
    setFailure(null);
    try {
      await api.post<{ payment: ChainPayment }>(`/v1/payments/${encodeURIComponent(payment.eventId)}/refunded`, txHash ? { txHash } : {});
      onDone();
    } catch (err) {
      setFailure(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Did you send ${formatAmount(payment.amount)} ${payment.asset.code} back?`}
      width={480}
    >
      <form onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <span style={{ fontSize: 15, color: "var(--slate)" }}>
          {isPreReset(payment) ? (
            <>
              This payment from <span className="mono">{shortAddress(payment.from)}</span> was made before a testnet reset, so it no longer exists on the
              network. Marking it here only removes it from this list.
            </>
          ) : (
            <>
              Refund it from your own wallet to <span className="mono">{shortAddress(payment.from)}</span> first. Marking it here only removes it from this
              list.
            </>
          )}
        </span>
        <div className="field">
          <label htmlFor={hashId} className="label">
            Refund transaction hash <span style={{ fontWeight: 400, color: "var(--slate)" }}>(optional)</span>
          </label>
          <input
            id={hashId}
            className={`input mono${tried && badHash ? " invalid" : ""}`}
            value={hash}
            onChange={(e) => setHash(e.target.value)}
            placeholder="64 characters"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={tried && badHash}
            aria-describedby={`${hashId}-hint`}
            style={{ fontSize: 13 }}
          />
          {tried && badHash ? (
            <span id={`${hashId}-hint`} className="field-error">
              A transaction hash is 64 characters, using 0-9 and a-f.
            </span>
          ) : (
            <span id={`${hashId}-hint`} className="hint">
              Keeps a record of the transaction you sent it back with.
            </span>
          )}
        </div>
        {failure ? (
          <div className="alert" role="alert">
            {failure}
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy} aria-busy={busy} style={{ padding: "0 18px", fontSize: 15 }}>
            Not yet
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy} style={{ fontSize: 15 }}>
            {busy ? "Saving…" : "Yes, mark refunded"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
