"use client";

import { useState } from "react";
import useSWR from "swr";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { api, errorMessage } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import type { Session } from "@/lib/types";
import { describeDevice, DEVICE_ICON } from "./device";
import { Section } from "./Section";

const ROW: React.CSSProperties = { display: "flex", gap: 12, alignItems: "center", borderTop: "1px solid var(--border-soft)", paddingTop: 12 };

export function SessionsCard() {
  const toast = useToast();
  const { data, error, mutate } = useSWR<{ data: Session[] }>("/auth/sessions");
  const [endingId, setEndingId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [endingAll, setEndingAll] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // This device first, then newest sign-in first.
  const sessions = data ? [...data.data].sort((a, b) => (a.current === b.current ? b.createdAt.localeCompare(a.createdAt) : a.current ? -1 : 1)) : undefined;
  const others = sessions?.filter((s) => !s.current) ?? [];
  const busy = endingId !== null || endingAll;

  const end = async (session: Session, label: string) => {
    if (busy) return;
    setEndingId(session.id);
    setActionError(null);
    try {
      await api.delete(`/auth/sessions/${session.id}`);
      await mutate();
      toast(`${label} logged out`);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setEndingId(null);
    }
  };

  const endAll = async () => {
    if (busy) return;
    const count = others.length;
    setEndingAll(true);
    setActionError(null);
    try {
      await api.post("/auth/sessions/logout-others");
      await mutate();
      toast(`Logged out of ${count} other device${count === 1 ? "" : "s"}`);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setEndingAll(false);
      setConfirmAll(false);
    }
  };

  const count = !sessions ? (error ? null : "Loading…") : sessions.length === 1 ? "Only this device" : `${sessions.length} devices`;

  return (
    <Section title="Where you're signed in" sub={count}>
      {actionError ? (
        <div role="alert" className="alert">
          {actionError}
        </div>
      ) : null}
      {sessions ? (
        sessions.length === 0 ? (
          <div className="empty" style={{ padding: "16px 0" }}>
            <strong>No sign-ins to show</strong>
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 16 }}>
            {sessions.map((s) => {
              const device = describeDevice(s.userAgent);
              return (
                <li key={s.id} style={ROW}>
                  <span style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 10, background: "var(--muted-bg)", color: "var(--slate-strong)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d={device.mobile ? DEVICE_ICON.mobile : DEVICE_ICON.desktop} />
                    </svg>
                  </span>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{device.label}</span>
                    <span style={{ fontSize: 13, color: "var(--slate)", overflowWrap: "anywhere" }}>
                      {s.current ? <span style={{ color: "var(--teal-deep)", fontWeight: 700 }}>This device · </span> : null}
                      {s.ip ? <span className="mono">{s.ip}</span> : null}
                      {s.ip ? " · " : null}
                      Signed in {formatDate(s.createdAt)}
                      {s.current ? null : ` · active ${timeAgo(s.lastSeenAt)}`}
                    </span>
                  </div>
                  {s.current ? null : (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => end(s, device.label)}
                      disabled={busy}
                      aria-label={`Log out ${device.label}, signed in ${formatDate(s.createdAt)}`}
                      style={{ height: 40, padding: "0 14px", background: "var(--surface)", borderColor: "var(--border)", color: "var(--ink)" }}
                    >
                      {endingId === s.id ? "Logging out…" : "Log out"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )
      ) : error ? (
        <div className="empty" role="alert" style={{ padding: "16px 0" }}>
          <strong>We couldn&apos;t load your sign-ins</strong>
          <span>{errorMessage(error)}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => mutate()} style={{ marginTop: 8 }}>
            Try again
          </button>
        </div>
      ) : (
        <div aria-busy="true" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {[0, 1].map((i) => (
            <div key={i} style={ROW}>
              <span className="skeleton" style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 10 }} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="skeleton" style={{ width: 140, height: 14 }} />
                <span className="skeleton" style={{ width: 200, maxWidth: "100%", height: 12 }} />
              </div>
            </div>
          ))}
        </div>
      )}
      {others.length > 0 ? (
        <button type="button" className="btn btn-secondary" onClick={() => setConfirmAll(true)} disabled={busy} style={{ padding: "0 18px", fontSize: 15, color: "var(--error)" }}>
          Log out everywhere else
        </button>
      ) : null}

      <Dialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        title="Log out everywhere else?"
        width={480}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmAll(false)} disabled={endingAll} style={{ padding: "0 18px", fontSize: 15 }}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={endAll} disabled={endingAll} style={{ fontSize: 15, background: "var(--error)", color: "#FFFFFF" }}>
              {endingAll ? "Logging out…" : "Log them out"}
            </button>
          </>
        }
      >
        <span style={{ fontSize: 15, color: "var(--slate)" }}>Every other browser and phone will need to log in again. You&apos;ll stay logged in here.</span>
      </Dialog>
    </Section>
  );
}
