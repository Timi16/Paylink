"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { Icon } from "@/components/Icon";
import { OutcomePill, Pill } from "@/components/StatusPill";
import { useToast } from "@/components/Toast";
import { api, errorMessage, qs } from "@/lib/api";
import { explorerAccount, explorerTx } from "@/lib/config";
import { formatAmount, formatDate, formatTime, shortAddress, shortHash } from "@/lib/format";
import { useNow, usePollWhenOffline } from "@/lib/live";
import { isUnmatched } from "@/lib/status";
import type { ChainPayment, Page, PaymentOutcome } from "@/lib/types";

const MAX_ROWS = 1000;
const REFUND_OUTCOMES: PaymentOutcome[] = ["DUPLICATE", "LATE", "AFTER_CANCEL", "AFTER_RESET", "WRONG_ASSET"];
const REJECTED_OUTCOMES: PaymentOutcome[] = ["WRONG_ISSUER", "WRONG_WALLET"];

type Filter = "all" | "counted" | "refund" | "unmatched" | "rejected";
type DayMode = "today" | "yesterday" | "date";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "counted", label: "Counted" },
  { key: "refund", label: "Refund owed" },
  { key: "unmatched", label: "Unmatched" },
  { key: "rejected", label: "Rejected" },
];

/** Which chip a payment belongs to. Refunded payments are settled, so they sit under "All" only. */
function category(p: ChainPayment): Exclude<Filter, "all"> | null {
  if (p.outcome === "COUNTED") return "counted";
  if (REJECTED_OUTCOMES.includes(p.outcome)) return "rejected";
  if (p.refundedAt) return null;
  // Funds from before a testnet reset no longer exist, so nothing is owed back for them.
  if (REFUND_OUTCOMES.includes(p.outcome)) return p.eventId.startsWith("reset-") ? null : "refund";
  if (isUnmatched(p)) return "unmatched";
  return null;
}

/** Local calendar day as "YYYY-MM-DD" (the value of a date input). */
function localDay(ms: number, offsetDays = 0): string {
  const d = new Date(ms);
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The first and last instant of a local day, as ISO strings. Null for an unusable date. */
function dayRange(day: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = new Date(`${day}T00:00:00`); // no offset: parsed in local time
  if (Number.isNaN(start.getTime())) return null;
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  return { from: start.toISOString(), to: new Date(next.getTime() - 1).toISOString() };
}

interface DayPayments {
  rows: ChainPayment[];
  capped: boolean;
}

/** Loads every page of a day's payments, stopping at MAX_ROWS. */
async function fetchDay(path: string): Promise<DayPayments> {
  const rows: ChainPayment[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: Page<ChainPayment> = await api.get<Page<ChainPayment>>(cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path);
    rows.push(...page.data);
    cursor = page.nextCursor;
    if (!cursor) return { rows, capped: false };
    if (rows.length >= MAX_ROWS) return { rows: rows.slice(0, MAX_ROWS), capped: true };
  }
}

/** Stroops -> decimal string with 7 decimals, for formatAmount. */
function fromStroops(stroops: bigint): string {
  return `${stroops / 10_000_000n}.${(stroops % 10_000_000n).toString().padStart(7, "0")}`;
}

function csvCell(value: string | null): string {
  let text = value ?? "";
  // Memos are written by the payer: stop a spreadsheet from running one as a formula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsv(rows: ChainPayment[]): string {
  const head = ["time", "amount", "asset", "issuer", "from", "to", "memo", "outcome", "request id", "tx hash", "refunded at"];
  const lines = rows.map((p) =>
    [p.ledgerClosedAt, p.amount, p.asset.code, p.asset.issuer, p.from, p.to, p.memo, p.outcome, p.requestId, p.txHash, p.refundedAt].map(csvCell).join(","),
  );
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}

const tile: React.CSSProperties = { padding: "16px 18px", display: "flex", flexDirection: "column", gap: 4 };
const tileLabel: React.CSSProperties = { fontSize: 13, color: "var(--slate)" };
const tileValue: React.CSSProperties = { fontSize: 24, fontWeight: 800 };

export default function PaymentsPage() {
  const toast = useToast();
  const now = useNow(60_000);
  const today = localDay(now);
  const [mode, setMode] = useState<DayMode>("today");
  const [picked, setPicked] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const day = mode === "today" ? today : mode === "yesterday" ? localDay(now, -1) : picked;
  const range = dayRange(day);
  const key = range ? `/v1/payments${qs({ from: range.from, to: range.to, limit: 100 })}` : null;
  const { data, error, isLoading, mutate } = useSWR<DayPayments>(key, fetchDay, { refreshInterval: usePollWhenOffline() });

  const rows = data?.rows;
  const stats = useMemo(() => {
    const counts: Record<Filter, number> = { all: 0, counted: 0, refund: 0, unmatched: 0, rejected: 0 };
    const sums = new Map<string, { id: string; code: string; stroops: bigint }>();
    for (const p of rows ?? []) {
      counts.all += 1;
      const cat = category(p);
      if (cat) counts[cat] += 1;
      if (cat === "counted") {
        // One total per asset: different assets are never added together.
        const id = `${p.asset.code}:${p.asset.issuer ?? ""}`;
        const sum = sums.get(id) ?? { id, code: p.asset.code, stroops: 0n };
        sum.stroops += BigInt(p.amountStroops);
        sums.set(id, sum);
      }
    }
    return { counts, counted: [...sums.values()] };
  }, [rows]);

  const shown = (rows ?? []).filter((p) => filter === "all" || category(p) === filter);

  const exportCsv = () => {
    if (!rows || rows.length === 0) return;
    const name = `paylink-payments-${day}.csv`;
    const url = URL.createObjectURL(new Blob([buildCsv(rows)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`${name} downloaded · ${rows.length} row${rows.length === 1 ? "" : "s"}`);
  };

  const pickMode = (next: DayMode) => {
    setMode(next);
    setFilter("all");
    if (next === "date" && !picked) setPicked(day || today);
  };

  const loading = key !== null && isLoading && !data;
  const dayLabel = mode === "today" ? "today" : mode === "yesterday" ? "yesterday" : range ? `on ${formatDate(range.from)}` : "";

  return (
    <>
      <div className="page-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h1 className="h1">Payments</h1>
          <span className="sub">Everything that reached your wallets, and what PayLink did with it.</span>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--slate)" }}>
            Day
            <select className="select" value={mode} onChange={(e) => pickMode(e.target.value as DayMode)} style={{ width: "auto", padding: "0 12px", fontSize: 14 }}>
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="date">Pick a date…</option>
            </select>
          </label>
          {mode === "date" ? (
            <>
              <label htmlFor="pay-date" className="sr-only">
                Date
              </label>
              <input
                id="pay-date"
                type="date"
                className="input"
                value={picked}
                max={today}
                onChange={(e) => {
                  setPicked(e.target.value);
                  setFilter("all");
                }}
                style={{ width: "auto", padding: "0 12px", fontSize: 14 }}
              />
            </>
          ) : null}
          <button type="button" className="btn btn-secondary" onClick={exportCsv} disabled={!rows || rows.length === 0} style={{ padding: "0 18px", fontSize: 15 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
            </svg>
            Export CSV
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        <div className="card" style={tile}>
          <span style={tileLabel}>Counted</span>
          {!rows ? (
            <span className={loading ? "skeleton" : undefined} style={tileValue}>
              {loading ? "0.00" : "—"}
            </span>
          ) : stats.counted.length === 0 ? (
            <span className="tnum" style={tileValue}>
              0.00
            </span>
          ) : (
            stats.counted.map((sum) => (
              <span key={sum.id} className="tnum" style={tileValue}>
                {formatAmount(fromStroops(sum.stroops))} <span style={{ fontSize: 14, color: "var(--slate)" }}>{sum.code}</span>
              </span>
            ))
          )}
        </div>
        <div className="card" style={tile}>
          <span style={tileLabel}>Refunds owed</span>
          <span className={`tnum${loading ? " skeleton" : ""}`} style={{ ...tileValue, color: loading ? undefined : "var(--attention-fg)" }}>
            {rows ? stats.counts.refund : loading ? "0" : "—"}
          </span>
        </div>
        <div className="card" style={tile}>
          <span style={tileLabel}>Unmatched</span>
          {rows ? (
            <Link href="/unmatched" className="tnum" style={{ ...tileValue, color: "var(--error)", alignSelf: "flex-start" }}>
              {stats.counts.unmatched}
            </Link>
          ) : (
            <span className={loading ? "skeleton" : undefined} style={tileValue}>
              {loading ? "0" : "—"}
            </span>
          )}
        </div>
      </div>

      <div role="group" aria-label="Filter by outcome" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {FILTERS.map((f) => {
          const on = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={on}
              onClick={() => setFilter(f.key)}
              style={{
                height: 36,
                padding: "0 14px",
                borderRadius: 999,
                border: `1px solid ${on ? "var(--teal)" : "var(--border)"}`,
                background: on ? "var(--teal-tint)" : "var(--surface)",
                color: on ? "var(--teal-deep)" : "var(--slate-strong)",
                fontSize: 13,
                fontWeight: on ? 700 : 600,
              }}
            >
              {f.label} <span className="mono">{rows ? stats.counts[f.key] : "–"}</span>
            </button>
          );
        })}
      </div>

      {data?.capped ? (
        <div className="notice" role="status">
          Showing the first {MAX_ROWS.toLocaleString("en-GB")} payments of this day. The totals, counts and the export cover only these rows.
        </div>
      ) : null}

      <div className="card" style={{ overflow: "hidden" }}>
        {error && !data ? (
          <div className="empty" role="alert">
            <strong>We couldn&apos;t load these payments</strong>
            <span>{errorMessage(error)}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => mutate()} style={{ marginTop: 6 }}>
              Try again
            </button>
          </div>
        ) : !range ? (
          <div className="empty">
            <strong>Pick a date</strong>
            <span>Choose a day to see the payments that arrived on it.</span>
          </div>
        ) : rows && shown.length === 0 ? (
          <div className="empty">
            <strong>{rows.length === 0 ? `No payments ${dayLabel}` : "Nothing in this filter"}</strong>
            <span>
              {rows.length === 0
                ? "Payments show up here as soon as they reach one of your wallets."
                : `None of the ${rows.length} payment${rows.length === 1 ? "" : "s"} ${dayLabel} fall under it.`}
            </span>
            {rows.length > 0 ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setFilter("all")} style={{ marginTop: 6 }}>
                Show all
              </button>
            ) : null}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 860 }} aria-busy={loading}>
              <thead>
                <tr>
                  <th>Time</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                  <th>From</th>
                  <th>Request</th>
                  <th>Outcome</th>
                  <th style={{ textAlign: "right" }}>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {!rows
                  ? Array.from({ length: 6 }, (_, i) => (
                      <tr key={i}>
                        {["00:00", "000.00 USDC", "GXXX…XXXX", "Open request", "Applied", "xxxx…xxxx"].map((text, j) => (
                          <td key={j} style={{ textAlign: j === 1 || j === 5 ? "right" : undefined }}>
                            <span className="skeleton">{text}</span>
                          </td>
                        ))}
                      </tr>
                    ))
                  : shown.map((p) => <PaymentRow key={p.eventId} p={p} />)}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", fontSize: 13, color: "var(--slate)" }}>
          Transaction links open on Stellar Expert (Testnet). Counted means the payment was applied to its request.
        </div>
      </div>
    </>
  );
}

function PaymentRow({ p }: { p: ChainPayment }) {
  const fake = p.outcome === "WRONG_ISSUER";
  const odd = fake || p.outcome === "WRONG_ASSET";
  return (
    <tr>
      <td title={new Date(p.ledgerClosedAt).toLocaleString("en-GB")}>{formatTime(p.ledgerClosedAt)}</td>
      <td className="num">
        {formatAmount(p.amount)}{" "}
        <span style={odd ? { color: "var(--danger-fg)", fontWeight: 600 } : undefined}>{p.asset.code}</span>
        {fake ? (
          <span
            title={p.asset.issuer ? `Issued by ${p.asset.issuer}` : undefined}
            style={{ marginLeft: 8, fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 700, color: "var(--danger-fg)" }}
          >
            Fake asset
          </span>
        ) : null}
      </td>
      <td className="mono" style={{ fontSize: 13 }}>
        <a href={explorerAccount(p.from)} target="_blank" rel="noreferrer" title={p.from}>
          {shortAddress(p.from)}
        </a>
      </td>
      <td>
        {p.requestId ? (
          <Link href={`/requests/${p.requestId}`} className="rowlink">
            {p.matchedBy === "memo" && p.memo ? <span className="mono">{p.memo}</span> : "Open request"}
          </Link>
        ) : isUnmatched(p) && !p.refundedAt ? (
          <Link href="/unmatched" className="rowlink">
            Assign…
          </Link>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <OutcomePill outcome={p.outcome} />
          {p.refundedAt ? <Pill tone="muted">Refunded</Pill> : null}
        </span>
      </td>
      <td style={{ textAlign: "right" }}>
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
    </tr>
  );
}
