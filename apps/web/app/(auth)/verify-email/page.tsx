"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Logo } from "@/components/Logo";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useLogout, useMe } from "@/lib/session";
import type { Merchant } from "@/lib/types";

const RESEND_WAIT = 60;

export default function VerifyEmailPage() {
  const router = useRouter();
  const { merchant, mutate } = useMe();
  const logout = useLogout();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  // A code was sent at sign-up, so the first resend waits a minute too.
  const [wait, setWait] = useState(RESEND_WAIT);
  const submitted = useRef("");

  useEffect(() => {
    if (merchant === null) router.replace("/login");
    else if (merchant?.emailVerified) router.replace("/get-started");
  }, [merchant, router]);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  const verify = async (value: string) => {
    if (busy || value.length !== 6) return;
    submitted.current = value;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.post<{ merchant: Merchant }>("/auth/email/verify", { code: value });
      await mutate(res, { revalidate: false });
      router.replace("/get-started");
    } catch (err) {
      const isExpired = err instanceof ApiError && err.code === "CHALLENGE_EXPIRED";
      setExpired(isExpired);
      setError(isExpired ? "This code has expired or was tried too many times. Send a new one." : errorMessage(err));
      setCode("");
      setBusy(false);
    }
  };

  const onCode = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    setError(null);
    // Entering the sixth digit submits; the same wrong code is not sent twice by itself.
    if (digits.length === 6 && digits !== submitted.current) void verify(digits);
  };

  const resend = async () => {
    if (resending || wait > 0) return;
    setResending(true);
    setError(null);
    setNotice(null);
    try {
      await api.post("/auth/email/resend");
      setNotice("A new code is on its way. The old one no longer works.");
      setExpired(false);
      submitted.current = "";
      setWait(RESEND_WAIT);
    } catch (err) {
      if (err instanceof ApiError && err.code === "RATE_LIMITED" && err.retryAfter) setWait(err.retryAfter);
      else setError(errorMessage(err));
    } finally {
      setResending(false);
    }
  };

  if (!merchant || merchant.emailVerified) return <div style={{ minHeight: "100vh" }} aria-busy="true" />;

  return (
    <div style={{ width: "100%", minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "48px 24px", gap: 32 }}>
      <Logo size={36} fontSize={22} />
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void verify(code);
        }}
        className="auth-card"
        style={{ maxWidth: 440, gap: 18 }}
      >
        <span style={{ width: 52, height: 52, borderRadius: "50%", background: "var(--teal-tint)", color: "var(--teal)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="mail" size={24} strokeWidth={2.2} />
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h1>Check your email</h1>
          <span style={{ fontSize: 15, color: "var(--slate)" }}>
            We sent a 6-digit code to <span style={{ fontWeight: 700, color: "var(--ink)", overflowWrap: "anywhere" }}>{merchant.email}</span>. Enter it to open your dashboard.
          </span>
        </div>
        {error ? (
          <div role="alert" className="alert">
            {error}
          </div>
        ) : notice ? (
          <div role="status" className="success">
            {notice}
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="code" className="label">
            Confirmation code
          </label>
          <input
            id="code"
            className={`input mono${error && !expired ? " invalid" : ""}`}
            value={code}
            onChange={(e) => onCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={7}
            placeholder="000000"
            autoFocus
            disabled={busy}
            aria-describedby="code-hint"
            style={{ height: 58, fontSize: 28, fontWeight: 600, letterSpacing: "0.35em", textAlign: "center", paddingLeft: "0.35em" }}
          />
          <span id="code-hint" className="hint">
            The code works for 15 minutes. Check spam if you don&apos;t see it.
          </span>
        </div>
        <button type="submit" className="btn btn-primary btn-lg" disabled={busy || code.length !== 6} aria-busy={busy}>
          {busy ? "Checking…" : "Confirm email"}
        </button>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", fontSize: 14 }}>
          <button type="button" className="btn-link" onClick={resend} disabled={resending || wait > 0}>
            {resending ? "Sending…" : wait > 0 ? `Send a new code in ${wait}s` : "Send a new code"}
          </button>
          <button type="button" onClick={logout} style={{ border: "none", background: "transparent", padding: 0, color: "var(--slate)", fontWeight: 600 }}>
            Wrong email? Log out
          </button>
        </div>
      </form>
    </div>
  );
}
