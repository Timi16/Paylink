"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useSWRConfig } from "swr";
import { AuthHero } from "@/components/AuthHero";
import { Icon } from "@/components/Icon";
import { PasswordInput, StrengthMeter } from "@/components/PasswordInput";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { Merchant } from "@/lib/types";

export default function SignupPage() {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const [biz, setBiz] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agree, setAgree] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);

  const invalid = {
    biz: biz.trim().length < 2,
    email: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()),
    password: password.length < 10,
    agree: !agree,
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (busy || invalid.biz || invalid.email || invalid.password || invalid.agree) return;
    setBusy(true);
    setError(null);
    setEmailTaken(false);
    try {
      const res = await api.post<{ merchant: Merchant }>("/auth/signup", { businessName: biz.trim(), email: email.trim(), password });
      await mutate("/auth/me", res, { revalidate: false });
      router.replace("/get-started");
    } catch (err) {
      if (err instanceof ApiError && err.code === "EMAIL_TAKEN") setEmailTaken(true);
      else setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <AuthHero title="Get your first USDC payment in about five minutes.">
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 16, fontSize: 16, color: "#E2E8F0" }}>
          {["Free on Stellar Testnet", "Payments go straight to your wallet", "No card needed to start"].map((line) => (
            <li key={line} style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <Icon name="check" size={20} strokeWidth={2.6} style={{ color: "var(--teal-on-dark)" }} />
              {line}
            </li>
          ))}
        </ul>
      </AuthHero>
      <section className="auth-panel">
        <form onSubmit={submit} noValidate className="auth-card">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <h2>Create your account</h2>
            <span className="sub">
              Already have one?{" "}
              <Link href="/login" style={{ fontWeight: 700 }}>
                Sign in
              </Link>
            </span>
          </div>
          {error ? (
            <div role="alert" className="alert">
              {error}
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="biz" className="label">
              Business name
            </label>
            <input id="biz" className={`input${tried && invalid.biz ? " invalid" : ""}`} value={biz} onChange={(e) => setBiz(e.target.value)} placeholder="Ada's Kitchen" maxLength={100} autoComplete="organization" autoFocus />
            {tried && invalid.biz ? <span className="field-error">Enter the name customers know you by.</span> : <span className="hint">Shown on every checkout page.</span>}
          </div>
          <div className="field">
            <label htmlFor="email" className="label">
              Work email
            </label>
            <input
              id="email"
              type="email"
              className={`input${(tried && invalid.email) || emailTaken ? " invalid" : ""}`}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailTaken(false);
              }}
              placeholder="ada@example.com"
              autoComplete="email"
            />
            {tried && invalid.email ? <span className="field-error">Enter a valid email address.</span> : null}
            {emailTaken ? (
              <span className="field-error" role="alert">
                An account with this email already exists. <Link href="/login">Sign in instead</Link>
              </span>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="pw" className="label">
              Password
            </label>
            <PasswordInput id="pw" value={password} onChange={setPassword} invalid={tried && invalid.password} autoComplete="new-password" describedBy="pw-hint" />
            <StrengthMeter password={password} id="pw-hint" />
          </div>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14, color: "var(--slate-strong)" }}>
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ width: 18, height: 18, marginTop: 1, accentColor: "var(--teal)" }} />
            I understand PayLink runs on Stellar Testnet and no real money moves.
          </label>
          {tried && invalid.agree ? (
            <span className="field-error" style={{ marginTop: -8 }}>
              Tick the box to continue.
            </span>
          ) : null}
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
            {busy ? "Creating account…" : "Create account"}
          </button>
          <span className="hint" style={{ textAlign: "center" }}>
            Next, you&apos;ll connect the wallet you want to get paid into.
          </span>
        </form>
      </section>
    </div>
  );
}
