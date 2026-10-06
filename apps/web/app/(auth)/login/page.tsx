"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useSWRConfig } from "swr";
import { AuthHero } from "@/components/AuthHero";
import { Icon } from "@/components/Icon";
import { PasswordInput } from "@/components/PasswordInput";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { Merchant } from "@/lib/types";

/** Only same-site paths are followed after sign-in. */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { mutate } = useSWRConfig();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || password.length === 0) {
      setError("Enter your email and password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ merchant: Merchant }>("/auth/login", { email: email.trim(), password, remember });
      await mutate("/auth/me", res, { revalidate: false });
      router.replace(safeNext(params.get("next")));
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "INVALID_CREDENTIALS"
          ? "That email and password don't match. Try again or reset your password."
          : errorMessage(err),
      );
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="auth-card">
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h2>Sign in</h2>
        <span className="sub">
          New to PayLink?{" "}
          <Link href="/signup" style={{ fontWeight: 700 }}>
            Create an account
          </Link>
        </span>
      </div>
      {params.get("reset") === "1" && !error ? <div className="success">Password updated. Sign in with your new password.</div> : null}
      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="email" className="label">
          Email
        </label>
        <input id="email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
      </div>
      <div className="field">
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <label htmlFor="pw" className="label">
            Password
          </label>
          <Link href="/forgot-password" style={{ fontSize: 13, fontWeight: 700 }}>
            Forgot password?
          </Link>
        </div>
        <PasswordInput id="pw" value={password} onChange={setPassword} autoComplete="current-password" />
      </div>
      <label style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 14, color: "var(--slate-strong)" }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ width: 18, height: 18, accentColor: "var(--teal)" }} />
        Keep me logged in for 14 days
      </label>
      <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="auth">
      <AuthHero title="Welcome back. Your payments kept moving while you were away.">
        {/* Illustration of what the dashboard shows; not live data. */}
        <div
          aria-hidden="true"
          style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 16, padding: 18, display: "flex", flexDirection: "column", gap: 12, maxWidth: 420 }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 36, height: 36, borderRadius: "50%", background: "rgba(94,234,212,0.18)", color: "var(--teal-on-dark)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon name="check" strokeWidth={2.6} />
            </span>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontWeight: 700 }}>80.00 USDC received</span>
              <span style={{ fontSize: 13, color: "#CBD5E1" }}>Order #1044 · Paid in full</span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 36, height: 36, borderRadius: "50%", background: "rgba(251,191,36,0.18)", color: "#FCD34D", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800 }}>!</span>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontWeight: 700 }}>3 payments need you</span>
              <span style={{ fontSize: 13, color: "#CBD5E1" }}>Missing memos, waiting to be assigned</span>
            </div>
          </div>
        </div>
      </AuthHero>
      <section className="auth-panel">
        <Suspense fallback={<div className="auth-card" aria-busy="true" style={{ minHeight: 420 }} />}>
          <LoginForm />
        </Suspense>
      </section>
    </div>
  );
}
