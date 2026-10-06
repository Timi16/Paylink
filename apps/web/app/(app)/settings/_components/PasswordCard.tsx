"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { PasswordInput, StrengthMeter } from "@/components/PasswordInput";
import { useToast } from "@/components/Toast";
import { api, ApiError, errorMessage } from "@/lib/api";
import { Section } from "./Section";

type Field = "cur" | "np" | "np2";

export function PasswordCard({ email }: { email: string }) {
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const [cur, setCur] = useState("");
  const [np, setNp] = useState("");
  const [np2, setNp2] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wrongCurrent, setWrongCurrent] = useState(false);
  const [newServerError, setNewServerError] = useState<string | null>(null);

  // The first problem only, as in the design.
  let problem: { field: Field; message: string } | null = null;
  if (!cur) problem = { field: "cur", message: "Enter your current password." };
  else if (np.length < 10) problem = { field: "np", message: "The new password needs at least 10 characters." };
  else if (np.length > 200) problem = { field: "np", message: "Keep the new password to 200 characters or fewer." };
  else if (np === cur) problem = { field: "np", message: "The new password must be different from your current one." };
  else if (np !== np2) problem = { field: "np2", message: "The new passwords don't match." };

  const shown: { field: Field; message: string } | null = wrongCurrent
    ? { field: "cur", message: "Current password is incorrect" }
    : newServerError
      ? { field: "np", message: newServerError }
      : tried
        ? problem
        : null;
  const errorFor = (field: Field) =>
    shown?.field === field ? (
      <span id={`${field}-error`} className="field-error" role="alert" style={{ fontWeight: 600 }}>
        {shown.message}
      </span>
    ) : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (busy || problem) return;
    setBusy(true);
    setError(null);
    setWrongCurrent(false);
    setNewServerError(null);
    try {
      await api.post("/auth/password", { currentPassword: cur, newPassword: np });
      setCur("");
      setNp("");
      setNp2("");
      setTried(false);
      toast("Password updated. Other devices were logged out.");
      void mutate("/auth/sessions");
    } catch (err) {
      const field = err instanceof ApiError ? err.field("newPassword") : undefined;
      if (err instanceof ApiError && err.code === "INVALID_CREDENTIALS") setWrongCurrent(true);
      else if (field) setNewServerError(field);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Password" sub={<>Signed in as {email}</>}>
      <form onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {error ? (
          <div role="alert" className="alert">
            {error}
          </div>
        ) : null}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, alignItems: "start" }}>
          <div className="field">
            <label htmlFor="cur" className="label">
              Current password
            </label>
            <PasswordInput
              id="cur"
              value={cur}
              onChange={(v) => {
                setCur(v);
                setWrongCurrent(false);
              }}
              invalid={shown?.field === "cur"}
              autoComplete="current-password"
              describedBy={shown?.field === "cur" ? "cur-error" : undefined}
            />
            {errorFor("cur")}
          </div>
          <div className="field">
            <label htmlFor="np" className="label">
              New password
            </label>
            <PasswordInput
              id="np"
              value={np}
              onChange={(v) => {
                setNp(v);
                setNewServerError(null);
              }}
              invalid={shown?.field === "np"}
              autoComplete="new-password"
              describedBy={shown?.field === "np" ? "np-error" : "np-hint"}
            />
            {errorFor("np")}
            <StrengthMeter password={np} id="np-hint" />
          </div>
          <div className="field">
            <label htmlFor="np2" className="label">
              Confirm new password
            </label>
            <PasswordInput id="np2" value={np2} onChange={setNp2} invalid={shown?.field === "np2"} autoComplete="new-password" describedBy={shown?.field === "np2" ? "np2-error" : undefined} />
            {errorFor("np2")}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "var(--slate)" }}>At least 10 characters. Updating it logs you out everywhere else.</span>
          <button type="submit" className="btn btn-primary" disabled={busy} style={{ fontSize: 15 }}>
            {busy ? "Updating…" : "Update password"}
          </button>
        </div>
      </form>
    </Section>
  );
}
