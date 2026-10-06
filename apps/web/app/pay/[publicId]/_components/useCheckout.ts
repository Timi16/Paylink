"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "@/lib/api";
import { API_URL } from "@/lib/config";
import { isOpen } from "@/lib/status";
import type { Checkout, CheckoutStatus } from "@/lib/types";

const POLL_MS = 5000;
const RETRY_MS = 5000;

export type CheckoutState =
  | { phase: "loading" }
  | { phase: "not-found" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      checkout: Checkout;
      /** When this page saw the request become paid (ms). Null if it was already paid on arrival. */
      paidSeenAt: number | null;
    };

const isSettled = (status: Checkout["status"]) => status === "PAID" || status === "OVERPAID";

/**
 * Loads the public checkout and keeps it live: an EventSource for status events, with a
 * 5-second poll of the same GET whenever the stream is down (or `setEager(true)` was called, e.g. while
 * the customer is waiting for a payment to show up). Stops for good once the status is final.
 */
export function useCheckout(publicId: string): { state: CheckoutState; retry: () => void; setEager: (eager: boolean) => void } {
  const [state, setState] = useState<CheckoutState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const eagerRef = useRef(false);
  const setEager = useCallback((eager: boolean) => {
    eagerRef.current = eager;
  }, []);

  useEffect(() => {
    const path = `/public/pay/${encodeURIComponent(publicId)}`;
    const aborter = new AbortController();
    let stopped = false;
    let current: Checkout | null = null;
    let paidSeenAt: number | null = null;
    let source: EventSource | null = null;
    let streamUp = false;
    let streamOpens = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    /** Bumped by every stream event, so a slower GET can't overwrite newer news. */
    let seq = 0;
    let loading = false;

    const publish = (next: Checkout) => {
      if (current && isOpen(current.status) && isSettled(next.status)) paidSeenAt = Date.now();
      current = next;
      setState({ phase: "ready", checkout: next, paidSeenAt });
      if (!isOpen(next.status)) closeStream();
    };

    const closeStream = () => {
      clearTimeout(retryTimer);
      source?.close();
      source = null;
      streamUp = false;
    };

    const load = async () => {
      if (loading) return;
      loading = true;
      const startedAt = seq;
      try {
        const fresh = await api.get<Checkout>(path, { signal: aborter.signal });
        if (stopped) return;
        // A status event that arrived while this was in flight is newer for the live fields.
        if (current && seq !== startedAt) {
          const { status, amountReceived, amountRemaining, paidTxHash, paidAt, expiresAt } = current;
          publish({ ...fresh, status, amountReceived, amountRemaining, paidTxHash, paidAt, expiresAt });
        } else {
          publish(fresh);
        }
      } catch (err) {
        if (stopped || current) return; // keep showing what we have; the next poll tries again
        if (err instanceof ApiError && (err.status === 404 || err.status === 400)) setState({ phase: "not-found" });
        else setState({ phase: "error", message: errorMessage(err) });
      } finally {
        loading = false;
      }
    };

    const connect = () => {
      if (stopped || typeof EventSource === "undefined") return;
      if (current && !isOpen(current.status)) return;
      const es = new EventSource(`${API_URL}${path}/events`);
      source = es;
      es.onopen = () => {
        streamUp = true;
        streamOpens += 1;
        // Coming back after a drop: catch up on anything missed in between.
        if (streamOpens > 1) void load();
      };
      es.addEventListener("status", (event) => {
        let update: CheckoutStatus;
        try {
          update = JSON.parse((event as MessageEvent<string>).data) as CheckoutStatus;
        } catch {
          return;
        }
        seq += 1;
        if (current) {
          publish({
            ...current,
            status: update.status,
            amountReceived: update.amountReceived,
            amountRemaining: update.amountRemaining,
            paidTxHash: update.paidTxHash,
            paidAt: update.paidAt,
            expiresAt: update.expiresAt,
          });
        }
      });
      es.onerror = () => {
        // Don't let the browser auto-reconnect: we decide, so a finished request stays quiet.
        es.close();
        if (source === es) source = null;
        streamUp = false;
        if (stopped || (current && !isOpen(current.status))) return;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, RETRY_MS);
      };
    };

    void load().then(() => {
      if (!stopped && current) connect();
    });

    const poll = setInterval(() => {
      if (!current || !isOpen(current.status)) return;
      if (document.visibilityState === "hidden") return;
      if (!streamUp || eagerRef.current) void load();
    }, POLL_MS);

    // Phones suspend background tabs: when the customer comes back from their wallet app, check at once.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !current || !isOpen(current.status)) return;
      void load();
      if (!source) {
        clearTimeout(retryTimer);
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      aborter.abort();
      clearInterval(poll);
      closeStream();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [publicId, attempt]);

  const retry = useCallback(() => {
    setState({ phase: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return { state, retry, setEager };
}
