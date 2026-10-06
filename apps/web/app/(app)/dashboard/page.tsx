"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { Icon } from "@/components/Icon";
import { RequestStatusPill } from "@/components/StatusPill";
import { formatAmount, formatTime, shortAddress, shortHash, timeAgo, timeLeft } from "@/lib/format";
import { useLive, useNow, usePollWhenOffline } from "@/lib/live";
import { useMe, useWallets } from "@/lib/session";
import { PAYMENT_OUTCOME, isUnmatched, requestSubtitle, requestTitle } from "@/lib/status";
import type { ChainPayment, Page, PaymentRequest, Summary } from "@/lib/types";

type Period = "today" | "week" | "month";
const PERIODS: { key: Period; label: string; collected: string; paid: string }[] = [
  { key: "today", label: "Today", collected: "Collected today", paid: "Links paid today" },
  { key: "week", label: "7 days", collected: "Collected this week", paid: "Links paid this week" },
  { key: "month", label: "30 days", collected: "Collected this month", paid: "Links paid this month" },
];

/** Start of the period in the merchant's own timezone, as ISO. Stable for the whole day. */
function periodStart(period: Period): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (period === "week") d.setDate(d.getDate() - 6);
  if (period === "month") d.setDate(d.getDate() - 29);
  return d.toISOString();
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function timing(r: PaymentRequest, now: number): { text: string; warn: boolean } {
  if (r.refundOwed && r.refundDue[0]) return { text: `Refund ${formatAmount(r.refundDue[0].amount)} owed`, warn: true };
  switch (r.status) {
    case "PENDING": {
      const left = timeLeft(r.expiresAt, now);
      return { text: left ? `Expires in ${left}` : "Closing…", warn: false };
    }
    case "UNDERPAID": {
      const left = timeLeft(r.expiresAt, now);
      return { text: `${formatAmount(r.amountRemaining)} due${left ? ` · ${left} left` : ""}`, warn: true };
    }
    case "PAID":
    case "OVERPAID":
      return { text: r.paidAt ? `Paid ${timeAgo(r.paidAt, now)}` : "Paid", warn: false };
    case "EXPIRED":
      return { text: `Expired ${timeAgo(r.expiresAt, now)}`, warn: false };
    case "CANCELLED":
      return { text: r.cancelledAt ? `Cancelled ${timeAgo(r.cancelledAt, now)}` : "Cancelled", warn: false };
    default:
      return { text: "Closed by a testnet reset", warn: false };
  }
}

function Tile({ href, label, value, sub, attention }: { href?: string; label: string; value: React.ReactNode; sub: React.ReactNode; attention?: boolean }) {
  const style: React.CSSProperties = {
    background: attention ? "var(--attention-bg)" : "var(--surface)",
    border: `1px solid ${attention ? "var(--attention-border)" : "var(--border)"}`,
    borderRadius: 14,
    padding: "18px 20px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    color: "var(--ink)",
    textDecoration: "none",
  };
  const body = (
    <>
      <span style={{ fontSize: 13, color: attention ? "var(--attention-fg)" : "var(--slate)", fontWeight: attention ? 700 : 400 }}>{label}</span>
      <span className="tnum" style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em" }}>
        {value}
      </span>
      <span style={{ fontSize: 13, color: "var(--slate)" }}>{sub}</span>
    </>
  );
  return href ? (
    <Link href={href} style={style}>
      {body}
    </Link>
  ) : (
    <div style={style}>{body}</div>
  );
}

function feedLine(p: ChainPayment): { colour: string; what: string; sub: string } {
  const spec = PAYMENT_OUTCOME[p.outcome];
  if (p.outcome === "COUNTED") return { colour: "var(--teal-deep)", what: "applied to a request", sub: `From ${shortAddress(p.from)} · tx ${shortHash(p.txHash)}` };
  if (isUnmatched(p)) return { colour: "var(--attention-fg)", what: "no request matched", sub: `${spec.label} · needs you` };
  return { colour: "var(--danger-fg)", what: "not applied", sub: spec.explain };
}

export default function OverviewPage() {
  const { merchant } = useMe();
  const { data: wallets } = useWallets();
  const [period, setPeriod] = useState<Period>("today");
  const now = useNow();
  const poll = usePollWhenOffline();
  const live = useLive();
  const from = useMemo(() => periodStart(period), [period]);
  const spec = PERIODS.find((p) => p.key === period) ?? PERIODS[0]!;

  const { data: summary, error: summaryError } = useSWR<Summary>(`/v1/summary?from=${encodeURIComponent(from)}`, { refreshInterval: poll, keepPreviousData: true });
  const { data: requests, error: requestsError } = useSWR<Page<PaymentRequest>>("/v1/payment-requests?limit=6", { refreshInterval: poll });
  const { data: payments } = useSWR<Page<ChainPayment>>("/v1/payments?limit=5", { refreshInterval: poll });

  const hour = new Date(now).getHours();
  const greeting = `${hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"}${merchant ? `, ${merchant.businessName}` : ""}`;
  const today = new Date(now).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const mainWallet = wallets?.data.find((w) => w.id === merchant?.defaultWalletId) ?? wallets?.data.find((w) => w.verified) ?? wallets?.data[0];

  const usdc = summary?.collected.find((c) => c.asset.code === "USDC");
  const others = summary?.collected.filter((c) => c !== usdc) ?? [];
  const primary = usdc ?? others[0];
  const rest = primary === usdc ? others : others.slice(1);
  const rate = summary && summary.requests.created > 0 ? Math.round((summary.requests.settled / summary.requests.created) * 100) : null;
  const needs = summary ? summary.needsYou.unmatched + summary.needsYou.refunds : null;
  const feed = payments?.data ?? [];

  return (
    <>
      <div className="page-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h1 className="h1">{greeting}</h1>
          <span className="sub">
            {today}
            {mainWallet ? (
              <>
                {" "}
                · payments land in {mainWallet.label ?? "your wallet"} <span className="mono">{shortAddress(mainWallet.address)}</span>
              </>
            ) : wallets ? (
              <>
                {" "}
                · <Link href="/get-started">add a wallet to start getting paid</Link>
              </>
            ) : null}
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <div role="group" aria-label="Period" className="seg">
            {PERIODS.map((p) => (
              <button key={p.key} type="button" aria-pressed={period === p.key} onClick={() => setPeriod(p.key)}>
                {p.label}
              </button>
            ))}
          </div>
          <Link href="/requests/new" className="btn btn-primary">
            <Icon name="plus" strokeWidth={2.5} />
            New request
          </Link>
        </div>
      </div>

      {summaryError ? (
        <div role="alert" className="alert">
          We couldn&apos;t load your numbers. They&apos;ll appear when the connection is back.
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 16 }} aria-busy={!summary}>
        <Tile
          href="/payments"
          label={spec.collected}
          value={summary ? (primary ? formatAmount(primary.amount) : "0.00") : <span className="skeleton">000.00</span>}
          sub={
            summary
              ? primary
                ? `${primary.asset.code} from ${plural(primary.payments, "payment")}${rest.map((c) => ` · ${formatAmount(c.amount)} ${c.asset.code}`).join("")}`
                : "No payments yet"
              : " "
          }
        />
        <Tile
          href="/requests"
          label="Waiting on customers"
          value={summary ? summary.open.count : <span className="skeleton">0</span>}
          sub={
            summary
              ? summary.open.count === 0
                ? "No open links"
                : [summary.open.underpaid > 0 ? `${summary.open.underpaid} part-paid` : null, summary.open.nextExpiresAt ? `next link closes in ${timeLeft(summary.open.nextExpiresAt, now) || "a moment"}` : null]
                    .filter(Boolean)
                    .join(" · ") || "All waiting for a first payment"
              : " "
          }
        />
        <Tile
          label={spec.paid}
          value={summary ? (rate === null ? "—" : `${rate}%`) : <span className="skeleton">00%</span>}
          sub={summary ? (summary.requests.created === 0 ? "No requests created" : `${summary.requests.settled} of ${plural(summary.requests.created, "request")} settled`) : " "}
        />
        <Tile
          href="/unmatched"
          attention={Boolean(needs)}
          label="Needs you"
          value={needs === null ? <span className="skeleton">0</span> : needs}
          sub={summary ? (needs === 0 ? "Nothing waiting" : `${summary.needsYou.unmatched} to match · ${plural(summary.needsYou.refunds, "refund")} to send`) : " "}
        />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
        <section className="card" style={{ flex: "2 1 560px", minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 20px 12px" }}>
            <h2 className="h2">Latest requests</h2>
            <Link href="/requests" style={{ fontSize: 14, fontWeight: 600 }}>
              View all
            </Link>
          </div>
          {requestsError ? (
            <div className="empty">
              <strong>Couldn&apos;t load requests</strong>
              <span>They&apos;ll appear when the connection is back.</span>
            </div>
          ) : requests && requests.data.length === 0 ? (
            <div className="empty">
              <strong>No requests yet</strong>
              <span>Create one and share the link to get paid.</span>
              <Link href="/requests/new" className="btn btn-primary" style={{ marginTop: 8 }}>
                Create a request
              </Link>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th style={{ textAlign: "right" }}>Amount</th>
                    <th>Status</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {requests
                    ? requests.data.map((r) => {
                        const when = timing(r, now);
                        return (
                          <tr key={r.id}>
                            <td>
                              <div style={{ display: "flex", flexDirection: "column" }}>
                                <Link className="rowlink" href={`/requests/${r.id}`}>
                                  {requestTitle(r)}
                                </Link>
                                <span style={{ fontSize: 12, color: "var(--slate)" }}>{requestSubtitle(r)}</span>
                              </div>
                            </td>
                            <td className="num">
                              {formatAmount(r.amount)} {r.asset.code}
                            </td>
                            <td>
                              <RequestStatusPill status={r.status} />
                            </td>
                            <td style={{ color: when.warn ? "var(--attention-fg)" : "var(--slate)" }}>{when.text}</td>
                          </tr>
                        );
                      })
                    : [0, 1, 2].map((i) => (
                        <tr key={i}>
                          <td colSpan={4}>
                            <span className="skeleton">Loading request</span>
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div style={{ flex: "1 1 320px", minWidth: 0, display: "flex", flexDirection: "column", gap: 24 }}>
          <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <h2 className="h2" style={{ marginBottom: 8 }}>
              Waiting on you
            </h2>
            {!summary ? (
              <span className="skeleton">Loading</span>
            ) : needs === 0 ? (
              <span className="sub" style={{ padding: "6px 0" }}>
                Nothing right now. Every payment is matched and no refunds are owed.
              </span>
            ) : (
              <>
                {summary.needsYou.unmatched > 0 ? (
                  <div style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-soft)" }}>
                    <span style={{ width: 32, height: 32, flexShrink: 0, borderRadius: 8, background: "var(--attention-bg)", color: "var(--attention-fg)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800 }}>!</span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 14 }}>
                      <span style={{ fontWeight: 600 }}>{plural(summary.needsYou.unmatched, "payment")} arrived without a usable memo</span>
                      <span style={{ color: "var(--slate)", fontSize: 13 }}>Match each one to its order, or send it back.</span>
                      <Link href="/unmatched" style={{ fontWeight: 700, fontSize: 13 }}>
                        Review payments
                      </Link>
                    </div>
                  </div>
                ) : null}
                {summary.needsYou.refundRequests.map((r) => (
                  <div key={r.id} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-soft)" }}>
                    <span style={{ width: 32, height: 32, flexShrink: 0, borderRadius: 8, background: "var(--teal-tint)", color: "var(--teal-deep)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Icon name="payments" size={16} strokeWidth={2.2} />
                    </span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 14 }}>
                      <span style={{ fontWeight: 600 }}>
                        {requestTitle(r)}: {r.refundDue.map((d) => `${formatAmount(d.amount)} ${d.asset.code}`).join(" + ")} to send back
                      </span>
                      <span style={{ color: "var(--slate)", fontSize: 13 }}>Return it from your wallet, then mark it refunded.</span>
                      <Link href={`/requests/${r.id}`} style={{ fontWeight: 700, fontSize: 13 }}>
                        Open request
                      </Link>
                    </div>
                  </div>
                ))}
                {summary.needsYou.refunds > summary.needsYou.refundRequests.length ? (
                  <span className="sub" style={{ paddingTop: 8, fontSize: 13 }}>
                    and {summary.needsYou.refunds - summary.needsYou.refundRequests.length} more with a refund to send.
                  </span>
                ) : null}
              </>
            )}
          </section>

          <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 className="h2">Live on Stellar</h2>
              <span
                role="status"
                style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 10px", border: "1px solid var(--border)", background: "var(--surface)", borderRadius: 999, fontSize: 12, fontWeight: 700, color: live.connected ? "var(--teal-deep)" : "var(--slate)" }}
              >
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: live.connected ? "var(--teal)" : "var(--slate-soft)" }} />
                {live.connected ? "Live" : "Reconnecting"}
              </span>
            </div>
            {!payments ? (
              <span className="skeleton">Loading</span>
            ) : feed.length === 0 ? (
              <span className="sub">Payments to your wallets show up here within seconds of landing.</span>
            ) : (
              <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 14, fontSize: 14 }}>
                {feed.map((p) => {
                  const line = feedLine(p);
                  return (
                    <li key={p.eventId} style={{ display: "flex", gap: 12 }}>
                      <span className="mono" title={new Date(p.ledgerClosedAt).toLocaleString("en-GB")} style={{ fontSize: 12, color: "var(--slate)", width: 40, flexShrink: 0, paddingTop: 2 }}>
                        {formatTime(p.ledgerClosedAt)}
                      </span>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                        <span>
                          <span style={{ fontWeight: 700, color: line.colour }}>
                            {formatAmount(p.amount)} {p.asset.code}
                          </span>{" "}
                          {p.requestId ? <Link href={`/requests/${p.requestId}`}>{line.what}</Link> : line.what}
                        </span>
                        <span style={{ fontSize: 12, color: "var(--slate)" }}>{line.sub}</span>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
