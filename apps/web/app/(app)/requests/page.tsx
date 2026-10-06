"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Icon } from "@/components/Icon";
import { RequestStatusPill } from "@/components/StatusPill";
import { errorMessage, qs } from "@/lib/api";
import { formatAmount, isPositive, timeAgo, timeLeft } from "@/lib/format";
import { useNow, usePollWhenOffline } from "@/lib/live";
import { REQUEST_STATUS, requestSubtitle, requestTitle } from "@/lib/status";
import type { Page, PaymentRequest, RequestStats, RequestStatus } from "@/lib/types";
import { CopyIconButton, DUST_STROOPS, money } from "./_components/shared";

const PAGE_SIZE = 20;

type Range = "7d" | "today" | "30d" | "all";
const RANGES: { value: Range; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "today", label: "Today" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" },
];

const CHIPS: RequestStatus[] = ["PENDING", "UNDERPAID", "PAID", "OVERPAID", "EXPIRED", "CANCELLED", "NETWORK_RESET"];

/** Start of the range as an ISO time, pinned to a midnight so the query stays stable while the page is open. */
function rangeStart(range: Range): string | undefined {
  if (range === "all") return undefined;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (range === "7d") start.setDate(start.getDate() - 6);
  if (range === "30d") start.setDate(start.getDate() - 29);
  return start.toISOString();
}

/** The Timing column: what matters about this request right now. */
function timing(r: PaymentRequest, now: number): { text: string; warn: boolean } {
  if (r.status === "PENDING") {
    const left = timeLeft(r.expiresAt, now);
    return { text: left ? `Expires in ${left}` : "Expiring now", warn: false };
  }
  if (r.status === "UNDERPAID") {
    const left = timeLeft(r.expiresAt, now);
    return { text: `${formatAmount(r.amountRemaining)} due · ${left ? `${left} left` : "expiring now"}`, warn: true };
  }
  if (r.refundOwed) {
    const lines = r.refundDue.filter((l) => BigInt(l.amountStroops) >= DUST_STROOPS);
    const first = lines[0];
    if (first && lines.length === 1) return { text: `Refund ${money(first.amount, first.asset.code)} owed`, warn: true };
    return { text: "Refunds owed", warn: true };
  }
  if (r.status === "PAID" || r.status === "OVERPAID") return { text: r.paidAt ? `Paid ${timeAgo(r.paidAt, now)}` : "Paid", warn: false };
  if (r.status === "EXPIRED") return { text: `Expired ${timeAgo(r.expiresAt, now)}`, warn: false };
  if (r.status === "CANCELLED") return { text: `Cancelled ${timeAgo(r.cancelledAt ?? r.updatedAt, now)}`, warn: false };
  return { text: `Closed ${timeAgo(r.updatedAt, now)}`, warn: false };
}

const chipStyle = (on: boolean): React.CSSProperties => ({
  height: 36,
  padding: "0 14px",
  borderRadius: 999,
  border: `1px solid ${on ? "var(--teal)" : "var(--border)"}`,
  background: on ? "var(--teal-tint)" : "var(--surface)",
  color: on ? "var(--teal-deep)" : "var(--slate-strong)",
  fontSize: 13,
  fontWeight: on ? 700 : 600,
});

const pagerStyle: React.CSSProperties = { height: 40, padding: "0 14px", border: "1px solid var(--border)", background: "var(--surface)", borderRadius: 8, fontWeight: 600, color: "var(--ink)" };

export default function RequestsPage() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [range, setRange] = useState<Range>("7d");
  const [status, setStatus] = useState<RequestStatus | null>(null);
  /** The cursor that opened each page after the first; the last one is the current page. */
  const [cursors, setCursors] = useState<string[]>([]);
  const now = useNow();
  const refreshInterval = usePollWhenOffline();

  // Debounce typing into the query, and go back to the first page when it changes.
  useEffect(() => {
    const id = setTimeout(() => {
      setQ(search.trim().slice(0, 64));
      setCursors((c) => (c.length ? [] : c));
    }, 300);
    return () => clearTimeout(id);
  }, [search]);

  const from = useMemo(() => rangeStart(range), [range]);
  const cursor = cursors[cursors.length - 1];

  const list = useSWR<Page<PaymentRequest>>(`/v1/payment-requests${qs({ status, from, q, cursor, limit: PAGE_SIZE })}`, { refreshInterval, keepPreviousData: true });
  const stats = useSWR<RequestStats>(`/v1/payment-requests/stats${qs({ from, q })}`, { refreshInterval, keepPreviousData: true });

  const rows = list.data?.data ?? [];
  const loading = !list.data && list.isLoading;
  const failed = !list.data && list.error;
  const filtered = q !== "" || status !== null || range !== "all";

  const clear = () => {
    setSearch("");
    setQ("");
    setStatus(null);
    setRange("all");
    setCursors([]);
  };

  const count = (s: RequestStatus | null) => (stats.data ? (s === null ? stats.data.total : (stats.data.byStatus[s] ?? 0)) : null);
  const chips = CHIPS.filter((s) => s !== "NETWORK_RESET" || status === s || (count(s) ?? 0) > 0);

  const total = count(status);
  const first = cursors.length * PAGE_SIZE + 1;
  const last = first + rows.length - 1;
  let showing = "";
  if (list.data) {
    if (rows.length === 0) showing = "No results";
    else showing = total !== null && total >= last ? `Showing ${first}–${last} of ${total}` : `Showing ${first}–${last}`;
  }
  const nextCursor = list.data?.nextCursor ?? null;

  return (
    <>
      <div className="page-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h1 className="h1">Payment requests</h1>
          <span className="sub">Every link you&apos;ve created. Open one to see its payments and history.</span>
        </div>
        <Link href="/requests/new" className="btn btn-primary">
          <Icon name="plus" strokeWidth={2.5} />
          New request
        </Link>
      </div>

      <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <div style={{ flex: "1 1 320px", minWidth: 0, position: "relative" }}>
            <label htmlFor="search" className="sr-only">
              Search requests
            </label>
            <Icon name="search" style={{ position: "absolute", left: 14, top: 13, color: "var(--slate)" }} />
            <input
              id="search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              maxLength={64}
              placeholder="Search by order, description or memo"
              style={{ width: "100%", height: 44, border: "1px solid var(--border-input)", borderRadius: 10, padding: "0 14px 0 42px", fontSize: 14, background: "var(--surface)" }}
            />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--slate)" }}>
            Created
            <select
              value={range}
              onChange={(e) => {
                setRange(e.target.value as Range);
                setCursors([]);
              }}
              style={{ height: 44, border: "1px solid var(--border-input)", borderRadius: 10, padding: "0 12px", fontSize: 14, background: "var(--surface)" }}
            >
              {RANGES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div role="group" aria-label="Filter by status" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {[null, ...chips].map((s) => {
            const on = status === s;
            const n = count(s);
            return (
              <button
                key={s ?? "all"}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setStatus(s);
                  setCursors([]);
                }}
                style={chipStyle(on)}
              >
                {s === null ? "All" : REQUEST_STATUS[s].label} {n !== null ? <span className="mono">{n}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        {failed ? (
          <div className="empty" role="alert">
            <strong>We couldn&apos;t load your requests</strong>
            <span>{errorMessage(list.error)}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => list.mutate()} style={{ marginTop: 4 }}>
              Try again
            </button>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table" style={{ minWidth: 860 }} aria-busy={list.isLoading}>
                <thead>
                  <tr>
                    <th>Request</th>
                    <th style={{ textAlign: "right" }}>Amount</th>
                    <th style={{ textAlign: "right" }}>Received</th>
                    <th>Status</th>
                    <th>Timing</th>
                    <th>Memo</th>
                    <th style={{ textAlign: "right" }}>Link</th>
                  </tr>
                </thead>
                <tbody>
                  {loading
                    ? Array.from({ length: 6 }, (_, i) => (
                        <tr key={i}>
                          {[140, 90, 70, 80, 120, 100, 40].map((w, j) => (
                            <td key={j}>
                              <span className="skeleton" style={{ display: "inline-block", width: w, height: 16 }}>
                                &nbsp;
                              </span>
                            </td>
                          ))}
                        </tr>
                      ))
                    : rows.map((r) => {
                        const title = requestTitle(r);
                        const sub = requestSubtitle(r);
                        const when = timing(r, now);
                        return (
                          <tr key={r.id}>
                            <td>
                              <div style={{ display: "flex", flexDirection: "column", maxWidth: 280 }}>
                                <Link className="rowlink" href={`/requests/${r.id}`} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {title}
                                </Link>
                                {sub !== title ? <span style={{ fontSize: 12, color: "var(--slate)", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</span> : null}
                              </div>
                            </td>
                            <td className="num">{money(r.amount, r.asset.code)}</td>
                            <td className="num" style={{ color: r.status === "UNDERPAID" ? "var(--attention-fg)" : isPositive(r.amountReceived) ? "var(--ink)" : "var(--slate)" }}>
                              {formatAmount(r.amountReceived)}
                            </td>
                            <td>
                              <RequestStatusPill status={r.status} />
                            </td>
                            <td style={{ color: when.warn ? "var(--attention-fg)" : "var(--slate)" }}>{when.text}</td>
                            <td className="mono" style={{ fontSize: 13 }}>
                              {r.memo}
                            </td>
                            <td style={{ textAlign: "right" }}>
                              <CopyIconButton value={r.checkoutUrl} ariaLabel={`Copy link for ${title}`} toast={`Checkout link for ${title} copied`} />
                            </td>
                          </tr>
                        );
                      })}
                </tbody>
              </table>
            </div>
            {list.data && rows.length === 0 ? (
              filtered ? (
                <div className="empty" style={{ padding: "48px 24px", gap: 10 }}>
                  <strong style={{ fontSize: 17 }}>No requests match</strong>
                  <span>Try a different search, status or date range.</span>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={clear} style={{ height: 40, padding: "0 16px" }}>
                    Clear filters
                  </button>
                </div>
              ) : (
                <div className="empty" style={{ padding: "48px 24px", gap: 10 }}>
                  <strong style={{ fontSize: 17 }}>No requests yet</strong>
                  <span>Create a payment request and share its link with your customer.</span>
                  <Link href="/requests/new" className="btn btn-primary btn-sm" style={{ height: 40, padding: "0 16px" }}>
                    New request
                  </Link>
                </div>
              )
            ) : null}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, padding: "12px 16px", borderTop: "1px solid var(--border)", fontSize: 13, color: "var(--slate)" }}>
              <span aria-live="polite">{showing}</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" style={pagerStyle} disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
                  Previous
                </button>
                <button
                  type="button"
                  style={pagerStyle}
                  disabled={!nextCursor || list.isLoading}
                  onClick={() => {
                    if (nextCursor) setCursors((c) => [...c, nextCursor]);
                  }}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
