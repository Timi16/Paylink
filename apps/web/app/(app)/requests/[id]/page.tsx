"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icon";
import { OutcomePill, Pill, RequestStatusPill } from "@/components/StatusPill";
import { useToast } from "@/components/Toast";
import { api, ApiError, errorMessage } from "@/lib/api";
import { explorerAccount, explorerTx } from "@/lib/config";
import { formatAmount, formatDateTime, formatTime, shortAddress, shortHash, timeLeft } from "@/lib/format";
import { useNow, usePollWhenOffline } from "@/lib/live";
import { useWallets } from "@/lib/session";
import { PAYMENT_OUTCOME, REQUEST_STATUS, requestTitle } from "@/lib/status";
import type { ChainPayment, PaymentRequest, RequestDetail, RequestEvent } from "@/lib/types";
import { RefundDialog } from "../_components/RefundDialog";
import { CopyIconButton, copyText, dayAt, fromStroops, isPreReset, money, sameAsset, splitRefunds, type RefundLine } from "../_components/shared";

type Tone = "teal" | "amber" | "grey" | "red";
const DOT: Record<Tone, string> = { teal: "var(--teal)", amber: "#D97706", grey: "var(--slate-soft)", red: "var(--error)" };

type RefundTarget = { kind: "payment"; payment: ChainPayment } | { kind: "request"; line: RefundLine };

const touches = (k: unknown) => typeof k === "string" && (k.startsWith("/v1/payment-requests") || k.startsWith("/v1/payments") || k.startsWith("/v1/summary"));

/** Time alone for today, otherwise the date too. */
const when = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? formatTime(iso) : formatDateTime(iso));

const smallLabel: React.CSSProperties = { fontSize: 12, color: "var(--slate)", fontWeight: 700 };
const stack: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };

function Breadcrumb({ current }: { current: string }) {
  return (
    <nav aria-label="Breadcrumb" style={{ fontSize: 14, color: "var(--slate)", overflowWrap: "anywhere" }}>
      <Link href="/requests" style={{ fontWeight: 600 }}>
        Requests
      </Link>{" "}
      / {current}
    </nav>
  );
}

/** Why a payment that was not applied has to go back, in one clause. */
function refundReason(p: ChainPayment, request: PaymentRequest): string {
  switch (p.outcome) {
    case "WRONG_ASSET":
      return `was sent instead of ${request.asset.code} and isn't counted`;
    case "DUPLICATE":
      return "arrived after this request was already paid, so it isn't counted";
    case "LATE":
      return "arrived after the link expired and isn't counted";
    case "AFTER_CANCEL":
      return "arrived after you cancelled this request and isn't counted";
    case "AFTER_RESET":
      return "arrived after a testnet reset closed this request";
    default:
      return "wasn't applied to this request";
  }
}

interface HistoryItem {
  key: string;
  at: string;
  title: string;
  sub: string;
  tone: Tone;
}

function actorText(actor: string): string {
  if (actor === "merchant") return "By you";
  if (actor === "api") return "Through the API";
  return "Automatic";
}

function eventItem(e: RequestEvent, request: PaymentRequest, payments: ChainPayment[]): HistoryItem {
  const from = REQUEST_STATUS[e.fromStatus].label;
  const to = REQUEST_STATUS[e.toStatus].label;
  const changed = e.fromStatus !== e.toStatus;
  const payment = e.paymentEventId ? payments.find((p) => p.eventId === e.paymentEventId) : undefined;
  let title = changed ? `${from} → ${to}` : e.reason.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  let detail: string;
  switch (e.reason) {
    case "payment_counted":
      if (!changed) title = "Payment applied";
      detail = payment ? `${money(payment.amount, payment.asset.code)} applied` : "A payment was applied";
      break;
    case "expired":
      detail = "The link ran out of time";
      break;
    case "cancelled":
      detail = "The link was closed";
      break;
    case "accepted":
      detail = `Accepted ${money(request.amountReceived, request.asset.code)} as full payment`;
      break;
    case "network_reset":
      detail = "Stellar Testnet was reset";
      break;
    default:
      detail = changed ? e.reason.replace(/_/g, " ") : "";
  }
  const tone: Tone = e.toStatus === "PAID" || e.toStatus === "OVERPAID" ? "teal" : e.toStatus === "UNDERPAID" ? "amber" : e.toStatus === "CANCELLED" ? "red" : "grey";
  return { key: `e-${e.id}`, at: e.createdAt, title, sub: [detail, actorText(e.actor)].filter(Boolean).join(" · "), tone };
}

function buildHistory(request: PaymentRequest, payments: ChainPayment[], events: RequestEvent[]): HistoryItem[] {
  const items: HistoryItem[] = events.map((e) => eventItem(e, request, payments));
  for (const p of payments) {
    if (p.outcome !== "COUNTED") {
      items.push({ key: `p-${p.eventId}`, at: p.ledgerClosedAt, title: `${PAYMENT_OUTCOME[p.outcome].label} payment`, sub: `${money(p.amount, p.asset.code)} · not applied`, tone: "amber" });
    }
    if (p.refundedAt) {
      items.push({ key: `r-${p.eventId}`, at: p.refundedAt, title: `${money(p.amount, p.asset.code)} refunded`, sub: `Recorded by you${p.refundTxHash ? ` · tx ${shortHash(p.refundTxHash)}` : ""}`, tone: "grey" });
    }
  }
  if (request.refundedAt) items.push({ key: "r-request", at: request.refundedAt, title: "Refund recorded", sub: "You sent back what this request owed", tone: "grey" });
  items.push({
    key: "created",
    at: request.createdAt,
    title: "Request created",
    sub: `${request.createdVia === "api" ? "Through the API" : "From the dashboard"} · ${money(request.amount, request.asset.code)}`,
    tone: "grey",
  });
  // Newest first; "created" stays last among equals.
  return items.map((item, i) => ({ item, i })).sort((a, b) => new Date(b.item.at).getTime() - new Date(a.item.at).getTime() || a.i - b.i).map((x) => x.item);
}

function Banner({ tone, title, children, action }: { tone: "amber" | "teal" | "grey"; title: string; children: React.ReactNode; action?: React.ReactNode }) {
  const look = {
    amber: { background: "var(--attention-bg)", border: "1px solid var(--attention-border)", fg: "#713F12" },
    teal: { background: "var(--teal-tint)", border: "1px solid #A7DCD3", fg: "var(--teal-deep)" },
    grey: { background: "var(--muted-bg)", border: "1px solid var(--border-input)", fg: "var(--slate-strong)" },
  }[tone];
  return (
    <div role="status" style={{ background: look.background, border: look.border, borderRadius: 14, padding: "16px 18px", display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 320px", minWidth: 0, display: "flex", gap: 14, alignItems: "flex-start" }}>
        {tone === "amber" ? (
          <span aria-hidden="true" style={{ width: 32, height: 32, flexShrink: 0, borderRadius: "50%", background: "var(--warn-bg)", color: "var(--attention-fg)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800 }}>
            !
          </span>
        ) : tone === "teal" ? (
          <span style={{ width: 32, height: 32, flexShrink: 0, borderRadius: "50%", background: "var(--teal)", color: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="check" size={14} strokeWidth={2.6} />
          </span>
        ) : null}
        <div style={stack}>
          <span style={{ fontWeight: 800, color: tone === "grey" ? "var(--ink)" : look.fg }}>{title}</span>
          <span style={{ fontSize: 14, color: look.fg }}>{children}</span>
        </div>
      </div>
      {action}
    </div>
  );
}

export default function RequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const refreshInterval = usePollWhenOffline();
  const { data, error, isLoading, mutate: reload } = useSWR<RequestDetail>(`/v1/payment-requests/${encodeURIComponent(id)}`, { refreshInterval });
  const wallets = useWallets();
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const now = useNow();

  const [dialog, setDialog] = useState<"accept" | "cancel" | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refund, setRefund] = useState<RefundTarget | null>(null);

  if (!data) {
    const missing = error instanceof ApiError && (error.status === 404 || error.status === 400);
    if (missing) {
      return (
        <>
          <Breadcrumb current="Not found" />
          <div className="card empty" style={{ padding: "56px 24px" }}>
            <strong style={{ fontSize: 17 }}>We couldn&apos;t find that request</strong>
            <span>The link may be wrong, or the request belongs to another account.</span>
            <Link href="/requests" className="btn btn-primary" style={{ marginTop: 8 }}>
              Back to requests
            </Link>
          </div>
        </>
      );
    }
    if (error && !isLoading) {
      return (
        <>
          <Breadcrumb current="Request" />
          <div className="card empty" role="alert" style={{ padding: "56px 24px" }}>
            <strong style={{ fontSize: 17 }}>We couldn&apos;t load this request</strong>
            <span>{errorMessage(error)}</span>
            <button type="button" className="btn btn-secondary" onClick={() => reload()} style={{ marginTop: 8 }}>
              Try again
            </button>
          </div>
        </>
      );
    }
    return (
      <div aria-busy="true" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <span className="sr-only">Loading request</span>
        <div className="skeleton" style={{ width: 180, height: 16 }} />
        <div className="skeleton" style={{ width: 300, maxWidth: "100%", height: 34 }} />
        <div className="skeleton" style={{ height: 70, borderRadius: 14 }} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
          <div className="skeleton" style={{ flex: "2 1 560px", height: 320, borderRadius: 14 }} />
          <div className="skeleton" style={{ flex: "1 1 300px", height: 320, borderRadius: 14 }} />
        </div>
      </div>
    );
  }

  const { request, payments, events } = data;
  const code = request.asset.code;
  const title = requestTitle(request);
  const status = request.status;

  const asked = BigInt(request.amountStroops);
  const received = BigInt(request.amountReceivedStroops);
  const pct = asked > 0n ? (received * 100n) / asked : 0n;
  const barPct = pct > 100n ? 100n : pct;

  // Payments set aside because they arrived after the request closed: Accept counts them.
  const setAsideOutcome = status === "EXPIRED" ? "LATE" : status === "CANCELLED" ? "AFTER_CANCEL" : null;
  const setAside = setAsideOutcome ? payments.filter((p) => p.outcome === setAsideOutcome && !isPreReset(p)) : [];
  const canAcceptLate = setAside.length > 0 && setAside.every((p) => p.refundedAt === null);
  const setAsideStroops = setAside.filter((p) => sameAsset(p.asset, request.asset)).reduce((sum, p) => sum + BigInt(p.amountStroops), 0n);
  const canAccept = status === "UNDERPAID" || canAcceptLate;
  const acceptStroops = status === "UNDERPAID" ? received : received + setAsideStroops;
  const acceptAmount = fromStroops(acceptStroops);
  const canCancel = status === "PENDING";

  const refunds = splitRefunds(request, payments);
  const ownRefund = refunds.own[0];
  const accepted = events.some((e) => e.reason === "accepted");
  const senders = [...new Set(payments.filter((p) => p.outcome === "COUNTED").map((p) => p.from))];
  const sender = senders.length === 1 && senders[0] ? shortAddress(senders[0]) : "the sender";
  const expiresAt = dayAt(request.expiresAt, now);
  const left = timeLeft(request.expiresAt, now);
  const wallet = wallets.data?.data.find((w) => w.id === request.walletId);
  const history = buildHistory(request, payments, events);

  const run = async (path: string, done: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.post<{ request: PaymentRequest }>(path);
      await mutate(touches);
      setDialog(null);
      toast(done);
    } catch (err) {
      setActionError(errorMessage(err));
      // The request moved on while the dialog was open: show where it stands now.
      if (err instanceof ApiError && err.code === "INVALID_TRANSITION") void mutate(touches);
    } finally {
      setBusy(false);
    }
  };

  const closeDialog = () => {
    setDialog(null);
    setActionError(null);
  };

  const recordRefund = async (txHash: string | undefined) => {
    if (!refund) return;
    const body = txHash ? { txHash } : {};
    if (refund.kind === "payment") await api.post(`/v1/payments/${encodeURIComponent(refund.payment.eventId)}/refunded`, body);
    else await api.post(`/v1/payment-requests/${encodeURIComponent(request.id)}/refunded`, body);
    await mutate(touches);
    setRefund(null);
    toast("Refund recorded");
  };

  const ownRefundButton = ownRefund ? (
    <button type="button" className="btn btn-secondary" style={{ fontSize: 15, padding: "0 18px", whiteSpace: "normal" }} onClick={() => setRefund({ kind: "request", line: ownRefund })}>
      Mark {money(ownRefund.amount, ownRefund.asset.code)} as refunded
    </button>
  ) : undefined;

  /** The second line of a closed request's banner: what, if anything, the merchant still has to do. */
  const closedNote = (closedHow: string) => {
    if (canAcceptLate) {
      return `${money(fromStroops(setAsideStroops), code)} arrived after ${closedHow}. Accept it as paid, or send it back from your wallet and mark it below.`;
    }
    if (ownRefund) return `${money(ownRefund.amount, ownRefund.asset.code)} was received and needs to go back to ${sender}. Send it from your wallet, then mark it here.`;
    if (refunds.payments.length > 0) return "A payment that wasn't applied still needs to go back. See below.";
    if (received > 0n || request.refundedAt) return "Everything that was received has been marked as refunded.";
    return "Nothing was received, so there is nothing to refund.";
  };

  let banner: React.ReactNode;
  switch (status) {
    case "PENDING":
      banner = (
        <Banner tone="grey" title="Waiting for payment">
          {left ? `The link is open until ${expiresAt}.` : "The link is about to expire."} Share it with your customer. This page updates by itself when they pay.
        </Banner>
      );
      break;
    case "UNDERPAID":
      banner = (
        <Banner tone="amber" title={`${money(request.amountRemaining, code)} is still due`}>
          The link stays open until {expiresAt}. Wait for the rest, or accept {money(request.amountReceived, code)} as full payment.
        </Banner>
      );
      break;
    case "PAID":
      banner = (
        <Banner
          tone="teal"
          title={
            accepted && received < asked
              ? `Paid. You accepted ${formatAmount(request.amountReceived)} of ${money(request.amount, code)} as full payment.`
              : accepted
                ? `Paid. You accepted ${money(request.amountReceived, code)} as full payment.`
                : `Paid in full. ${money(request.amountReceived, code)} received.`
          }
          action={ownRefundButton}
        >
          The link is closed. Your customer now sees a Paid receipt.
          {ownRefund ? ` ${money(ownRefund.amount, ownRefund.asset.code)} more than you asked for was received. Send it back to ${sender} from your wallet, then mark it here.` : ""}
        </Banner>
      );
      break;
    case "OVERPAID":
      banner = (
        <Banner tone="teal" title={`Paid, with ${money(fromStroops(received - asked), code)} extra.`} action={ownRefundButton}>
          Your customer sent more than you asked for. The link is closed and they see a Paid receipt.{" "}
          {ownRefund ? `Send the extra ${money(ownRefund.amount, ownRefund.asset.code)} back to ${sender} from your wallet, then mark it here.` : "The extra has been marked as refunded."}
        </Banner>
      );
      break;
    case "EXPIRED":
      banner = (
        <Banner tone="grey" title="Expired. The link no longer accepts payments." action={ownRefundButton}>
          {closedNote("the link expired")}
        </Banner>
      );
      break;
    case "CANCELLED":
      banner = (
        <Banner tone="grey" title="Cancelled. The link no longer accepts payments." action={ownRefundButton}>
          {closedNote("you cancelled")}
        </Banner>
      );
      break;
    default:
      banner = (
        <Banner tone="grey" title="Closed by a Stellar Testnet reset." action={ownRefundButton}>
          Testnet was wiped and restarted, so this request can no longer be paid, and payments from before the reset no longer exist on the network. Create a new request if you still need this payment.
        </Banner>
      );
  }

  // The third figure of the summary depends on where the request stands.
  let due: { label: string; value: string; warn: boolean };
  if (status === "PENDING" || status === "UNDERPAID") due = { label: "Still due", value: request.amountRemaining, warn: status === "UNDERPAID" };
  else if (status === "OVERPAID" || (status === "PAID" && received > asked)) due = { label: "Extra received", value: fromStroops(received - asked), warn: false };
  else if (status === "PAID") due = received < asked ? { label: "Written off", value: request.amountRemaining, warn: false } : { label: "Still due", value: "0", warn: false };
  else due = { label: "To refund", value: request.refundDue.find((l) => sameAsset(l.asset, request.asset))?.amount ?? "0", warn: false };

  let expiresText: string;
  if (status === "PENDING" || status === "UNDERPAID") expiresText = `${expiresAt.replace(/^./, (c) => c.toUpperCase())}${left ? ` · in ${left}` : ""}`;
  else if (status === "PAID" || status === "OVERPAID") expiresText = accepted ? "Closed when you accepted it" : "Closed when it was paid";
  else if (status === "CANCELLED") expiresText = "Closed when you cancelled it";
  else if (status === "EXPIRED") expiresText = `Expired ${dayAt(request.expiresAt, now)}`;
  else expiresText = "Closed by the testnet reset";

  let customerText: string;
  if (status === "PENDING") customerText = `The checkout page asks for ${money(request.amount, code)}, with the memo.`;
  else if (status === "UNDERPAID") customerText = `The checkout page shows ${money(request.amountRemaining, code)} remaining, with the same memo.`;
  else if (status === "PAID" || status === "OVERPAID") customerText = "The checkout page shows the Paid receipt.";
  else if (status === "EXPIRED") customerText = "The checkout page says this request has expired.";
  else if (status === "CANCELLED") customerText = "The checkout page says this request was cancelled.";
  else customerText = "The checkout page says this request can no longer be paid.";

  const createdLine = `${request.customerRef && request.description ? `${request.description} · created` : "Created"} ${dayAt(request.createdAt, now)} ${request.createdVia === "api" ? "through the API" : "from the dashboard"}`;
  const remainingAfterAccept = asked > acceptStroops ? asked - acceptStroops : 0n;
  const extraAfterAccept = acceptStroops > asked ? acceptStroops - asked : 0n;
  let acceptText: string;
  if (status === "UNDERPAID") {
    acceptText = `${title} will be marked Paid. The remaining ${money(fromStroops(remainingAfterAccept), code)} won't be collected, and the link closes for your customer.`;
  } else {
    acceptText = `${title} will be marked Paid, counting the ${money(fromStroops(setAsideStroops), code)} that arrived after ${status === "EXPIRED" ? "the link expired" : "you cancelled"}.`;
    if (remainingAfterAccept > 0n) acceptText += ` The remaining ${money(fromStroops(remainingAfterAccept), code)} won't be collected.`;
    if (extraAfterAccept > 0n) acceptText += ` That is ${money(fromStroops(extraAfterAccept), code)} more than you asked for, which you'd still owe back.`;
    acceptText += " Your customer will see a Paid receipt.";
  }

  return (
    <>
      <div className="page-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <Breadcrumb current={title} />
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h1 className="h1" style={{ overflowWrap: "anywhere" }}>
              {title}
            </h1>
            <RequestStatusPill status={status} />
          </div>
          <span className="sub">{createdLine}</span>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ fontSize: 15, padding: "0 18px" }}
            onClick={async () => {
              await copyText(request.checkoutUrl);
              toast("Checkout link copied");
            }}
          >
            <Icon name="copy" size={16} />
            Copy link
          </button>
          {canCancel ? (
            <button type="button" className="btn btn-secondary" style={{ fontSize: 15, padding: "0 18px", color: "var(--error)" }} onClick={() => setDialog("cancel")}>
              Cancel request
            </button>
          ) : null}
          {canAccept ? (
            <button type="button" className="btn btn-primary" style={{ fontSize: 15 }} onClick={() => setDialog("accept")}>
              Accept {formatAmount(acceptAmount)} as paid
            </button>
          ) : null}
        </div>
      </div>

      {banner}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
        <div style={{ flex: "2 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}>
          <section aria-label="Amounts" className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12 }}>
              <div style={stack}>
                <span style={{ fontSize: 13, color: "var(--slate)" }}>Asked</span>
                <span className="tnum" style={{ fontSize: 26, fontWeight: 800, overflowWrap: "anywhere" }}>
                  {formatAmount(request.amount)}
                </span>
              </div>
              <div style={stack}>
                <span style={{ fontSize: 13, color: "var(--slate)" }}>Received</span>
                <span className="tnum" style={{ fontSize: 26, fontWeight: 800, overflowWrap: "anywhere", color: received > 0n ? "var(--teal-deep)" : "var(--slate)" }}>
                  {formatAmount(request.amountReceived)}
                </span>
              </div>
              <div style={stack}>
                <span style={{ fontSize: 13, color: "var(--slate)" }}>{due.label}</span>
                <span className="tnum" style={{ fontSize: 26, fontWeight: 800, overflowWrap: "anywhere", color: due.warn ? "var(--attention-fg)" : "var(--slate)" }}>
                  {formatAmount(due.value)}
                </span>
              </div>
            </div>
            <div role="progressbar" aria-label="Share of the amount received" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number.parseInt(barPct.toString(), 10)} style={{ height: 10, borderRadius: 999, background: "var(--border)", overflow: "hidden" }}>
              <div style={{ width: `${barPct.toString()}%`, height: 10, background: "var(--teal)" }} />
            </div>
            <span style={{ fontSize: 13, color: "var(--slate)" }}>
              {pct.toString()}% received · all amounts in {code}
            </span>
          </section>

          <section aria-labelledby="payments-title" className="card" style={{ overflow: "hidden" }}>
            <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <h2 id="payments-title" style={{ fontSize: 17, fontWeight: 800 }}>
                Payments to this request
              </h2>
              <span style={{ fontSize: 13, color: "var(--slate)" }}>
                {payments.length} payment{payments.length === 1 ? "" : "s"}
              </span>
            </div>
            {payments.length === 0 ? (
              <div className="empty">
                <strong>No payments yet</strong>
                <span>{status === "PENDING" ? "A payment shows up here within seconds of arriving." : "Nothing was sent to this request."}</span>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table" style={{ minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th style={{ textAlign: "right" }}>Amount</th>
                      <th>From</th>
                      <th>Outcome</th>
                      <th style={{ textAlign: "right" }}>Transaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.eventId}>
                        <td>{when(p.ledgerClosedAt)}</td>
                        <td className="num">{money(p.amount, p.asset.code)}</td>
                        <td className="mono" style={{ fontSize: 13 }}>
                          <a href={explorerAccount(p.from)} target="_blank" rel="noopener noreferrer" title={p.from} style={{ color: "var(--ink)" }}>
                            {shortAddress(p.from)}
                          </a>
                        </td>
                        <td>
                          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                            <OutcomePill outcome={p.outcome} />
                            {p.refundedAt ? <Pill tone="muted">Refunded</Pill> : null}
                          </span>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <a href={explorerTx(p.txHash)} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 13, display: "inline-flex", gap: 4, alignItems: "center" }}>
                            {shortHash(p.txHash)}
                            <Icon name="external" size={13} strokeWidth={2.2} />
                            <span className="sr-only">(opens the explorer in a new tab)</span>
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {refunds.payments.map((p) => (
              <div key={p.eventId} style={{ margin: 16, background: "var(--attention-bg)", border: "1px solid var(--attention-border)", borderRadius: 12, padding: "14px 16px", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ flex: "1 1 300px", minWidth: 0, fontSize: 14, color: "#713F12" }}>
                  <span style={{ fontWeight: 800 }}>Refund owed:</span> {money(p.amount, p.asset.code)} {refundReason(p, request)}.{" "}
                  {canAcceptLate && p.outcome === setAsideOutcome ? "Accept it as paid above, or send" : "Send"} it back to{" "}
                  <span className="mono" title={p.from}>
                    {shortAddress(p.from)}
                  </span>{" "}
                  from your wallet.
                </span>
                <button type="button" className="btn btn-secondary btn-sm" style={{ height: 40, padding: "0 14px" }} onClick={() => setRefund({ kind: "payment", payment: p })}>
                  Mark as refunded
                </button>
              </div>
            ))}
          </section>

          <section aria-labelledby="history-title" className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            <h2 id="history-title" style={{ fontSize: 17, fontWeight: 800 }}>
              History
            </h2>
            <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column" }}>
              {history.map((h) => (
                <li key={h.key} style={{ display: "flex", gap: 14, padding: "10px 0", borderBottom: "1px solid var(--border-soft)" }}>
                  <span aria-hidden="true" style={{ width: 10, height: 10, marginTop: 5, flexShrink: 0, borderRadius: "50%", background: DOT[h.tone] }} />
                  <div style={stack}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{h.title}</span>
                    <span style={{ fontSize: 13, color: "var(--slate)" }}>
                      {h.sub} · {when(h.at)}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside style={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}>
          <section aria-labelledby="details-title" className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12, fontSize: 14 }}>
            <h2 id="details-title" style={{ fontSize: 17, fontWeight: 800 }}>
              Details
            </h2>
            <div style={stack}>
              <span style={smallLabel}>Memo</span>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <span className="mono" style={{ fontWeight: 600, fontSize: 15 }}>
                  {request.memo}
                </span>
                <CopyIconButton value={request.memo} ariaLabel="Copy memo" toast={`Memo ${request.memo} copied`} />
              </div>
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--teal)", fontWeight: 600 }}>No text memo? Use the number or this address</summary>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
                  <span style={{ fontSize: 13, color: "var(--slate)" }}>For wallets that can&apos;t attach a text memo. Either one matches this request exactly like the memo does.</span>
                  <div style={stack}>
                    <span style={smallLabel}>Memo as a number (memo ID)</span>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                      <span className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>
                        {request.memoId}
                      </span>
                      <CopyIconButton value={request.memoId} ariaLabel="Copy memo ID" toast="Memo ID copied" />
                    </div>
                  </div>
                  <div style={stack}>
                    <span style={smallLabel}>Address with the memo built in</span>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                      <span className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
                        {request.muxedAddress}
                      </span>
                      <CopyIconButton value={request.muxedAddress} ariaLabel="Copy address with the memo built in" toast="Address copied" />
                    </div>
                  </div>
                </div>
              </details>
            </div>
            <div style={stack}>
              <span style={smallLabel}>Receive into</span>
              <span>
                {wallet?.label ? `${wallet.label} · ` : ""}
                <a href={explorerAccount(request.wallet)} target="_blank" rel="noopener noreferrer" className="mono" title={request.wallet}>
                  {shortAddress(request.wallet)}
                </a>
              </span>
            </div>
            <div style={stack}>
              <span style={smallLabel}>Asset</span>
              {request.asset.issuer ? (
                <span>
                  {code} · issuer{" "}
                  <span className="mono" title={request.asset.issuer}>
                    {shortAddress(request.asset.issuer)}
                  </span>
                </span>
              ) : (
                <span>{code} · Stellar&apos;s native asset</span>
              )}
            </div>
            <div style={stack}>
              <span style={smallLabel}>Expires</span>
              <span>{expiresText}</span>
            </div>
            {request.paidTxHash ? (
              <div style={stack}>
                <span style={smallLabel}>Paying transaction</span>
                <a href={explorerTx(request.paidTxHash)} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 13 }}>
                  {shortHash(request.paidTxHash)}
                </a>
              </div>
            ) : null}
            <div style={stack}>
              <span style={smallLabel}>Checkout link</span>
              <span className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>
                {request.checkoutUrl}
              </span>
            </div>
          </section>
          <section aria-label="Customer view" style={{ background: "var(--night)", color: "#FFFFFF", borderRadius: 14, padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--teal-on-dark)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Customer view</span>
            <span style={{ fontSize: 15, color: "#E2E8F0" }}>{customerText}</span>
            <a href={request.checkoutUrl} target="_blank" rel="noopener noreferrer" className="btn" style={{ background: "var(--teal-bright)", color: "var(--night)", fontSize: 15, alignSelf: "flex-start" }}>
              Open checkout page
            </a>
          </section>
        </aside>
      </div>

      <Dialog
        open={dialog === "accept"}
        onClose={closeDialog}
        title={`Accept ${money(acceptAmount, code)} as full payment?`}
        width={480}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={closeDialog} disabled={busy}>
              Not now
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(`/v1/payment-requests/${encodeURIComponent(request.id)}/accept`, `${title} marked Paid`)}>
              {busy ? "Accepting…" : "Accept as paid"}
            </button>
          </>
        }
      >
        <span style={{ fontSize: 15, color: "var(--slate)" }}>
          {acceptText}
        </span>
        {actionError ? (
          <div role="alert" className="alert">
            {actionError}
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={dialog === "cancel"}
        onClose={closeDialog}
        title="Cancel this request?"
        width={480}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={closeDialog} disabled={busy}>
              Keep request
            </button>
            <button type="button" className="btn" style={{ background: "var(--error)", color: "#FFFFFF" }} disabled={busy} onClick={() => run(`/v1/payment-requests/${encodeURIComponent(request.id)}/cancel`, "Request cancelled. The link is closed.")}>
              {busy ? "Cancelling…" : "Cancel request"}
            </button>
          </>
        }
      >
        <span style={{ fontSize: 15, color: "var(--slate)" }}>
          The link stops working right away. Nothing has been received yet, so there is nothing to refund. If your customer pays after this, the money still reaches your wallet and you can accept it or send it back.
        </span>
        {actionError ? (
          <div role="alert" className="alert">
            {actionError}
          </div>
        ) : null}
      </Dialog>

      <RefundDialog
        amount={refund ? (refund.kind === "payment" ? money(refund.payment.amount, refund.payment.asset.code) : money(refund.line.amount, refund.line.asset.code)) : null}
        onClose={() => setRefund(null)}
        onConfirm={recordRefund}
      />
    </>
  );
}
