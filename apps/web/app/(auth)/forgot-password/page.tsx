"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Logo } from "@/components/Logo";
import { api, errorMessage } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [tried, setTried] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const send = async (again = false) => {
    setTried(true);
    if (!emailOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/password/forgot", { email: email.trim() });
      setSent(true);
      setResent(again);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ width: "100%", minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "48px 24px", gap: 32 }}>
      <Logo size={36} fontSize={22} />
      <div style={{ width: "100%", maxWidth: 440, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 18, padding: 32, display: "flex", flexDirection: "column", gap: 18 }}>
        {!sent ? (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            style={{ display: "flex", flexDirection: "column", gap: 18 }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}>Reset your password</h1>
              <span style={{ fontSize: 15, color: "var(--slate)" }}>Enter the email you signed up with. We&apos;ll send a link that works for one hour.</span>
            </div>
            {error ? (
              <div role="alert" className="alert">
                {error}
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="email" className="label">
                Email
              </label>
              <input id="email" type="email" className={`input${tried && !emailOk ? " invalid" : ""}`} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourbusiness.com" autoComplete="email" autoFocus />
              {tried && !emailOk ? <span className="field-error">Enter a valid email address.</span> : null}
            </div>
            <button type="submit" className="btn btn-primary btn-lg" disabled={busy} aria-busy={busy}>
              {busy ? "Sending…" : "Send reset link"}
            </button>
          </form>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-start" }}>
            <span style={{ width: 52, height: 52, borderRadius: "50%", background: "var(--teal-tint)", color: "var(--teal)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon name="mail" size={24} strokeWidth={2.2} />
            </span>
            <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}>Check your email</h1>
            <span style={{ fontSize: 15, color: "var(--slate)" }}>
              If an account exists for <span style={{ fontWeight: 700, color: "var(--ink)" }}>{email.trim()}</span>, a reset link is on its way. It works once, for one hour.
            </span>
            {error ? (
              <div role="alert" className="alert" style={{ alignSelf: "stretch" }}>
                {error}
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 16, fontSize: 14, flexWrap: "wrap" }}>
              <button type="button" className="btn-link" onClick={() => void send(true)} disabled={busy} aria-busy={busy}>
                {busy ? "Sending…" : resent ? "Sent again" : "Resend email"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSent(false);
                  setTried(false);
                  setResent(false);
                }}
                style={{ border: "none", background: "transparent", padding: 0, color: "var(--slate)", fontWeight: 600 }}
              >
                Use a different email
              </button>
            </div>
          </div>
        )}
      </div>
      <Link href="/login" style={{ fontSize: 14, fontWeight: 700 }}>
        Back to log in
      </Link>
    </div>
  );
}
