"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { useToast } from "@/components/Toast";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { Merchant } from "@/lib/types";
import { GRID, Section } from "./Section";

interface Draft {
  name: string;
  support: string;
}

export function BusinessCard({ merchant }: { merchant: Merchant }) {
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const saved: Draft = { name: merchant.businessName, support: merchant.supportContact ?? "" };
  // null = showing what is saved.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supportError, setSupportError] = useState<string | null>(null);

  const value = draft ?? saved;
  const dirty = value.name !== saved.name || value.support !== saved.support;
  const nameBad = tried && !value.name.trim();

  const edit = (patch: Partial<Draft>) => {
    setDraft({ ...value, ...patch });
    setError(null);
    if (patch.support !== undefined) setSupportError(null);
  };

  const discard = () => {
    setDraft(null);
    setTried(false);
    setError(null);
    setSupportError(null);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !dirty) return;
    setTried(true);
    if (!value.name.trim()) return;
    setBusy(true);
    setError(null);
    setSupportError(null);
    try {
      const res = await api.post<{ merchant: Merchant }>("/auth/settings", {
        businessName: value.name.trim(),
        supportContact: value.support.trim() || null,
      });
      await mutate("/auth/me", res, { revalidate: false });
      setDraft(null);
      setTried(false);
      toast("Business details saved");
    } catch (err) {
      const field = err instanceof ApiError ? err.field("supportContact") : undefined;
      if (field) setSupportError(field);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Business" sub="Customers see this on every checkout page.">
      <form onSubmit={save} noValidate style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {error ? (
          <div role="alert" className="alert">
            {error}
          </div>
        ) : null}
        <div style={GRID}>
          <div className="field">
            <label htmlFor="bname" className="label">
              Business name
            </label>
            <input
              id="bname"
              className={`input${nameBad ? " invalid" : ""}`}
              value={value.name}
              onChange={(e) => edit({ name: e.target.value })}
              maxLength={100}
              autoComplete="organization"
              aria-invalid={nameBad || undefined}
            />
            {nameBad ? (
              <span className="field-error" role="alert" style={{ fontWeight: 600 }}>
                Your business needs a name.
              </span>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="support" className="label">
              Support contact
            </label>
            <input
              id="support"
              className={`input${supportError ? " invalid" : ""}`}
              value={value.support}
              onChange={(e) => edit({ support: e.target.value })}
              maxLength={100}
              aria-invalid={supportError ? true : undefined}
              aria-describedby="support-hint"
            />
            {supportError ? (
              <span className="field-error" role="alert" style={{ fontWeight: 600 }}>
                {supportError}
              </span>
            ) : null}
            <span id="support-hint" className="hint">
              A phone number, email or handle customers can reach you on. Leave it empty to show none.
            </span>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {dirty ? (
            <button type="button" className="btn btn-secondary" onClick={discard} disabled={busy} aria-busy={busy} style={{ padding: "0 18px", fontSize: 15 }}>
              Discard
            </button>
          ) : null}
          <button
            type="submit"
            className="btn"
            disabled={!dirty || busy}
            style={{ fontSize: 15, opacity: 1, background: dirty ? "var(--teal)" : "var(--border)", color: dirty ? "#FFFFFF" : "#64748B" }}
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Section>
  );
}
