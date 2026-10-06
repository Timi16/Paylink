"use client";

import { useState } from "react";

interface Props {
  id: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  autoComplete: "current-password" | "new-password";
  describedBy?: string;
}

/** Password field with a Show / Hide toggle. */
export function PasswordInput({ id, value, onChange, invalid, autoComplete, describedBy }: Props) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <input
        id={id}
        className={`input${invalid ? " invalid" : ""}`}
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        style={{ paddingRight: 64 }}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-pressed={show}
        style={{ position: "absolute", right: 6, top: 6, height: 34, padding: "0 10px", border: "none", background: "transparent", color: "var(--teal)", fontWeight: 700, fontSize: 13 }}
      >
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}

/** 0 = empty, 1 = too short, 2 = good, 3 = strong. The API requires at least 10 characters. */
export function passwordStrength(pw: string): 0 | 1 | 2 | 3 {
  if (pw.length === 0) return 0;
  if (pw.length < 10) return 1;
  return /[0-9]/.test(pw) && /[A-Za-z]/.test(pw) && pw.length >= 12 ? 3 : 2;
}

const HINTS = ["At least 10 characters", "Too short — at least 10 characters", "Good password", "Strong password"] as const;

export function StrengthMeter({ password, id }: { password: string; id?: string }) {
  const strength = passwordStrength(password);
  const colour = (n: number) => (strength >= n ? (strength === 1 ? "#F59E0B" : "var(--teal)") : "var(--border)");
  return (
    <>
      <div style={{ display: "flex", gap: 4 }} aria-hidden="true">
        {[1, 2, 3].map((n) => (
          <span key={n} style={{ flex: 1, height: 4, borderRadius: 999, background: colour(n) }} />
        ))}
      </div>
      <span id={id} className="hint">
        {HINTS[strength]}
      </span>
    </>
  );
}
