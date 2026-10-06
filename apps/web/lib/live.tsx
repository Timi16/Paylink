"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { API_URL } from "./config";
import type { ChainPayment } from "./types";

interface LiveState {
  /** True while the stream is open. When false, pages fall back to polling. */
  connected: boolean;
  /** Payments detected since this page loaded, newest first (at most 20). */
  recent: ChainPayment[];
}

const LiveContext = createContext<LiveState>({ connected: false, recent: [] });

const startsWith = (prefix: string) => (key: unknown) => typeof key === "string" && key.startsWith(prefix);

/**
 * Holds the merchant's live stream (GET /v1/stream) open for the whole dashboard. Each event
 * refreshes the lists it affects, so every page updates without a reload. The server ends a
 * stream after 15 minutes; EventSource reconnects by itself.
 */
export function LiveProvider({ children }: { children: React.ReactNode }) {
  const { mutate } = useSWRConfig();
  const [state, setState] = useState<LiveState>({ connected: false, recent: [] });
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const refresh = (...prefixes: string[]) => {
      for (const prefix of prefixes) void mutateRef.current(startsWith(prefix));
    };

    const connect = () => {
      if (stopped) return;
      source = new EventSource(`${API_URL}/v1/stream`, { withCredentials: true });
      source.addEventListener("ready", () => setState((s) => ({ ...s, connected: true })));
      source.addEventListener("request.updated", () => refresh("/v1/payment-requests", "/v1/summary"));
      source.addEventListener("payment.detected", (ev) => {
        refresh("/v1/payments", "/v1/payment-requests", "/v1/summary");
        try {
          const payment = JSON.parse((ev as MessageEvent<string>).data) as ChainPayment;
          setState((s) => ({ ...s, recent: [payment, ...s.recent.filter((p) => p.eventId !== payment.eventId)].slice(0, 20) }));
        } catch {
          // ignore a malformed event; the list refresh above still shows the payment
        }
      });
      source.addEventListener("wallet.updated", () => refresh("/v1/wallets"));
      source.addEventListener("resync", () => refresh("/v1/"));
      source.onerror = () => {
        setState((s) => ({ ...s, connected: false }));
        // CLOSED means the browser gave up (e.g. a 401 or 429); try again ourselves, slowly.
        if (source?.readyState === EventSource.CLOSED && !stopped) {
          source.close();
          retry = setTimeout(connect, 15_000);
        }
      };
    };
    connect();

    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, []);

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);

/** SWR refresh interval: poll every 15 s only while the live stream is down. */
export function usePollWhenOffline(): number {
  return useLive().connected ? 0 : 15_000;
}

/** Re-renders every `ms` so countdowns and "9 min ago" stay current. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
