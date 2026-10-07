"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Icon } from "@/components/Icon";
import { Logo } from "@/components/Logo";
import { PasswordInput, StrengthMeter } from "@/components/PasswordInput";
import { api, ApiError, errorMessage } from "@/lib/api";

function ResetForm() {
  const token = useSearchParams().get("token") ?? "";
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  const problem = p1.length < 10 ? "Use at least 10 characters." : p1 !== p2 ? "The two passwords don't match." : "";

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/password/reset", { token, newPassword: p1 });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && (err.code === "CHALLENGE_EXPIRED" || err.code === "VALIDATION_FAILED") && !err.field("newPassword")) setExpired(true);
      else setError(errorMessage(err));
      setBusy(false);
    }
  };

  if (!token || expired) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}>This reset link no longer works</h1>
        <span style={{ fontSize: 15, color: "var(--slate)" }}>Reset links work once and expire after an hour. Ask for a new one and use it straight away.</span>
        <Link href="/forgot-password" className="btn btn-primary btn-lg">
          Send a new link
        </Link>
      </div>
    );
  }
  if (done) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-start" }}>
        <span style={{ width: 52, height: 52, borderRadius: "50%", background: "var(--teal-tint)", color: "var(--teal)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="check" size={24} strokeWidth={2.6} />
        </span>
        <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}>Password updated</h1>
        <span style={{ fontSize: 15, color: "var(--slate)" }}>For your safety, we logged you out on every device.</span>
        <Link href="/login" className="btn btn-primary btn-lg btn-block">
          Sign in
        </Link>
      </div>
    );
  }
  return (
    <form noValidate onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}>Choose a new password</h1>
      <div className="field">
        <label htmlFor="p1" className="label">
          New password
        </label>
        <PasswordInput id="p1" value={p1} onChange={setP1} autoComplete="new-password" invalid={tried && p1.length < 10} describedBy="p1-hint" />
        <StrengthMeter password={p1} id="p1-hint" />
      </div>
      <div className="field">
        <label htmlFor="p2" className="label">
          Confirm new password
        </label>
        <PasswordInput id="p2" value={p2} onChange={setP2} autoComplete="new-password" invalid={tried && p1.length >= 10 && p1 !== p2} />
      </div>
      {tried && problem ? (
        <span role="alert" className="field-error">
          {problem}
        </span>
      ) : null}
      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}
      <button type="submit" className="btn btn-primary btn-lg" disabled={busy} aria-busy={busy}>
        {busy ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div style={{ width: "100%", minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "48px 24px", gap: 32 }}>
      <Logo size={36} fontSize={22} />
      <div style={{ width: "100%", maxWidth: 440, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 18, padding: 32 }}>
        <Suspense fallback={<div style={{ minHeight: 240 }} aria-busy="true" />}>
          <ResetForm />
        </Suspense>
      </div>
      <Link href="/login" style={{ fontSize: 14, fontWeight: 700 }}>
        Back to log in
      </Link>
    </div>
  );
}
