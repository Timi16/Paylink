"use client";

import Link from "next/link";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toast";
import { api, ApiError, errorMessage } from "@/lib/api";
import { formatAmount, initials, isPositive, shortAddress, toStroops } from "@/lib/format";
import { useNow } from "@/lib/live";
import { useMe, useWallets } from "@/lib/session";
import type { PaymentRequest, Wallet } from "@/lib/types";
import { copyText, dayAt, money } from "../_components/shared";

const MIN_MINUTES = 5;
const MAX_MINUTES = 43_200; // 30 days, the API's limit
const MAX_STROOPS = 9_223_372_036_854_775_807n;
const DESC_MAX = 80;

type AssetCode = "USDC" | "XLM";
const ASSETS: { code: AssetCode; sub: string }[] = [
  { code: "USDC", sub: "US dollar stablecoin" },
  { code: "XLM", sub: "Stellar Lumens" },
];

const EXPIRIES: { key: string; label: string }[] = [
  { key: "15", label: "15 min" },
  { key: "30", label: "30 min" },
  { key: "60", label: "1 hour" },
  { key: "1440", label: "24 hours" },
  { key: "custom", label: "Custom" },
];

type FieldName = "wallet" | "asset" | "amount" | "expiry" | "desc" | "ref";
type FieldErrors = Partial<Record<FieldName, string>>;

/** Which form field each API validation path belongs to. */
const API_FIELDS: Record<string, FieldName> = {
  walletId: "wallet",
  asset: "asset",
  amount: "amount",
  expiresInMinutes: "expiry",
  description: "desc",
  customerRef: "ref",
};

function amountError(amount: string): string {
  if (amount === "") return "Enter an amount.";
  if (!/^\d+(\.\d+)?$/.test(amount)) return "Use numbers only, like 18.50.";
  const [whole = "", frac = ""] = amount.split(".");
  if (frac.length > 7) return "Stellar allows up to 7 decimal places.";
  if (whole.length > 12 || toStroops(amount) > MAX_STROOPS) return "That amount is too large for Stellar.";
  if (!isPositive(amount)) return "The amount must be more than zero.";
  return "";
}

function receiveProblem(wallet: Wallet, asset: AssetCode): string | null {
  const check = wallet.canReceive[asset];
  if (!check || check.canReceive) return null;
  if (check.reason === "ACCOUNT_NOT_FOUND") return "This wallet's account doesn't exist on Stellar Testnet yet. Fund it first.";
  if (check.reason === "NO_TRUSTLINE") return `This wallet has no ${asset} trustline, so it can't receive ${asset} yet. Add the trustline in your wallet.`;
  if (check.reason === "TRUSTLINE_LIMIT_TOO_LOW") return `This wallet's ${asset} trustline limit is too low to receive more ${asset}.`;
  return `This wallet can't receive ${asset} right now.`;
}

function newKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Insecure context (plain http on a LAN address): build the same shape from random bytes.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const walletName = (w: Wallet) => w.label ?? "Wallet";

const chipStyle = (on: boolean): React.CSSProperties => ({
  height: 44,
  padding: "0 16px",
  borderRadius: 10,
  border: on ? "1.5px solid var(--teal)" : "1px solid var(--border-input)",
  background: on ? "var(--teal-tint)" : "var(--surface)",
  color: on ? "var(--teal-deep)" : "var(--slate-strong)",
  fontWeight: on ? 700 : 600,
  fontSize: 14,
});

const assetStyle = (on: boolean): React.CSSProperties => ({
  flex: "1 1 180px",
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: on ? "14px 16px" : "15px 17px",
  borderRadius: 12,
  border: on ? "2px solid var(--teal)" : "1px solid var(--border-input)",
  background: on ? "#F0FAF8" : "var(--surface)",
  cursor: "pointer",
});

const help: React.CSSProperties = { fontSize: 13, color: "var(--slate)" };
const fieldErr: React.CSSProperties = { fontSize: 13, color: "var(--error)", fontWeight: 600 };

function Head() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <nav aria-label="Breadcrumb" style={{ fontSize: 14, color: "var(--slate)" }}>
        <Link href="/requests" style={{ fontWeight: 600 }}>
          Requests
        </Link>{" "}
        / New request
      </nav>
      <h1 className="h1">New payment request</h1>
    </div>
  );
}

export default function NewRequestPage() {
  const { merchant } = useMe();
  const wallets = useWallets();
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const now = useNow();

  // null = not chosen yet: fall back to the merchant's defaults.
  const [walletChoice, setWalletChoice] = useState<string | null>(null);
  const [asset, setAsset] = useState<AssetCode>("USDC");
  const [amount, setAmount] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [expiryChoice, setExpiryChoice] = useState<string | null>(null);
  const [customChoice, setCustomChoice] = useState<string | null>(null);
  const [desc, setDesc] = useState("");
  const [ref, setRef] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [apiErrors, setApiErrors] = useState<FieldErrors>({});
  const [created, setCreated] = useState<PaymentRequest | null>(null);
  /** One key per distinct form fill: a retry of the same body reuses it, so it can never create twice. */
  const idem = useRef<{ key: string; body: string } | null>(null);

  const all = wallets.data?.data ?? [];
  const verified = all.filter((w) => w.verified);
  const preferred = verified.find((w) => w.id === merchant?.defaultWalletId) ?? verified[0];
  const wallet = verified.find((w) => w.id === walletChoice) ?? preferred;

  const defaultMinutes = merchant?.defaultExpiryMinutes ?? 30;
  const defaultKey = EXPIRIES.some((e) => e.key === String(defaultMinutes)) ? String(defaultMinutes) : "custom";
  const expiry = expiryChoice ?? defaultKey;
  const customMin = customChoice ?? String(defaultKey === "custom" ? defaultMinutes : 45);

  const amt = amount.trim();
  const amountErr = amountError(amt);
  const customValid = /^\d{1,5}$/.test(customMin.trim());
  const minutes = expiry === "custom" ? (customValid ? Number.parseInt(customMin.trim(), 10) : 0) : Number.parseInt(expiry, 10);
  const customBad = expiry === "custom" && (!customValid || minutes < MIN_MINUTES || minutes > MAX_MINUTES);
  const descBad = desc.trim() === "";
  const errorCount = (amountErr ? 1 : 0) + (descBad ? 1 : 0) + (customBad ? 1 : 0);

  const shownMinutes = customBad ? 30 : minutes;
  const expiresText = dayAt(new Date(now + shownMinutes * 60_000).toISOString(), now);
  const previewTimer = shownMinutes >= 60 ? `${Math.floor(shownMinutes / 60)}h ${String(shownMinutes % 60).padStart(2, "0")}m` : `${String(shownMinutes).padStart(2, "0")}:00`;
  const problem = wallet ? receiveProblem(wallet, asset) : null;
  const showAmountErr = (tried || amountTouched) && amountErr !== "";

  const clearError = (field: FieldName) => setApiErrors((e) => (e[field] ? { ...e, [field]: undefined } : e));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (busy || !wallet || errorCount > 0) return;
    const body = {
      walletId: wallet.id,
      asset,
      amount: amt,
      expiresInMinutes: minutes,
      description: desc.trim(),
      ...(ref.trim() ? { customerRef: ref.trim() } : {}),
    };
    const serialized = JSON.stringify(body);
    if (idem.current?.body !== serialized) idem.current = { key: newKey(), body: serialized };
    setBusy(true);
    setFormError(null);
    setApiErrors({});
    try {
      const res = await api.post<{ request: PaymentRequest; checkoutUrl: string }>("/v1/payment-requests", body, { headers: { "Idempotency-Key": idem.current.key } });
      setCreated(res.request);
      void mutate((k) => typeof k === "string" && (k.startsWith("/v1/payment-requests") || k.startsWith("/v1/summary")));
    } catch (err) {
      const next: FieldErrors = {};
      if (err instanceof ApiError) {
        if (err.code === "WALLET_NOT_VERIFIED") next.wallet = "This wallet isn't verified yet. Verify it on the Wallets page, then try again.";
        else if (err.code === "ACCOUNT_NOT_FOUND") next.wallet = err.message;
        else if (err.code === "NOT_FOUND") next.wallet = "This wallet is no longer on your account. Choose another one.";
        else if (err.code === "NO_TRUSTLINE") next.asset = `This wallet has no ${asset} trustline, so it can't receive ${asset}. Add the trustline in your wallet, or choose another asset.`;
        else if (err.code === "TRUSTLINE_LIMIT_TOO_LOW") next.amount = `This is more ${asset} than the wallet's trustline limit lets it receive. Lower the amount or raise the limit.`;
        else if (err.code === "VALIDATION_FAILED") {
          for (const d of err.details) {
            const field = d.path ? API_FIELDS[d.path] : undefined;
            if (field && d.message && !next[field]) next[field] = d.message;
          }
        }
        // The wallet's state on the network is not what this page had: fetch it again.
        if (next.wallet || next.asset) void mutate("/v1/wallets");
      }
      if (Object.keys(next).length > 0) setApiErrors(next);
      else setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const another = () => {
    idem.current = null;
    setCreated(null);
    setTried(false);
    setAmountTouched(false);
    setAmount("");
    setDesc("");
    setRef("");
    setExpiryChoice(null);
    setFormError(null);
    setApiErrors({});
  };

  if (created) {
    return (
      <>
        <Head />
        <CreatedView request={created} businessName={merchant?.businessName ?? ""} onAnother={another} onCopied={() => toast("Link copied. Paste it anywhere.")} />
      </>
    );
  }

  if (!wallets.data) {
    return (
      <>
        <Head />
        {wallets.error ? (
          <div className="card empty" role="alert">
            <strong>We couldn&apos;t load your wallets</strong>
            <span>{errorMessage(wallets.error)}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => wallets.mutate()} style={{ marginTop: 4 }}>
              Try again
            </button>
          </div>
        ) : (
          <div className="card" aria-busy="true" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 22, maxWidth: 720 }}>
            {[46, 76, 46, 44, 46].map((h, i) => (
              <div key={i} className="skeleton" style={{ height: h, borderRadius: 10 }} />
            ))}
          </div>
        )}
      </>
    );
  }

  if (!wallet) {
    return (
      <>
        <Head />
        <div className="card" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start", maxWidth: 620 }}>
          <span style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--warn-bg)", color: "var(--attention-fg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="wallets" size={22} />
          </span>
          <h2 style={{ fontSize: 20, fontWeight: 800 }}>Verify a wallet first</h2>
          <span className="sub" style={{ fontSize: 15 }}>
            {all.length === 0
              ? "Payments go straight into your own Stellar wallet, so PayLink needs to know which one. Connect it and prove it's yours, then you can create requests."
              : "You've added a wallet, but it isn't verified yet. Only verified wallets can receive requests, so nobody can ask for payments into a wallet they don't own."}
          </span>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
            <Link href="/get-started" className="btn btn-primary">
              Finish setting up
            </Link>
            <Link href="/requests" className="btn btn-secondary">
              Back to requests
            </Link>
          </div>
        </div>
      </>
    );
  }

  const inputStyle = (bad: boolean): React.CSSProperties => (bad ? { border: "1.5px solid var(--error-border)" } : {});
  const amountMsg = apiErrors.amount ?? (showAmountErr ? amountErr : "");
  const descMsg = apiErrors.desc ?? (tried && descBad ? "Add a short description. Your customer sees it." : "");
  const business = merchant?.businessName ?? "";

  return (
    <>
      <Head />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
        <form onSubmit={submit} noValidate className="card" style={{ flex: "3 1 520px", minWidth: 0, padding: 24, display: "flex", flexDirection: "column", gap: 22 }}>
          {tried && errorCount > 0 ? (
            <div role="alert" className="alert" style={{ padding: "12px 14px", fontWeight: 600 }}>
              {errorCount === 1 ? "Fix 1 field to create this request." : `Fix ${errorCount} fields to create this request.`}
            </div>
          ) : formError ? (
            <div role="alert" className="alert" style={{ padding: "12px 14px", fontWeight: 600 }}>
              {formError}
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="wallet" className="label">
              Receive into
            </label>
            <select
              id="wallet"
              className="select"
              value={wallet.id}
              aria-invalid={Boolean(apiErrors.wallet)}
              style={inputStyle(Boolean(apiErrors.wallet))}
              onChange={(e) => {
                setWalletChoice(e.target.value);
                clearError("wallet");
                clearError("asset");
                clearError("amount");
              }}
            >
              {all.map((w) => (
                <option key={w.id} value={w.id} disabled={!w.verified}>
                  {walletName(w)} · {shortAddress(w.address)} · {w.verified ? "Verified" : "Not verified"}
                </option>
              ))}
            </select>
            {apiErrors.wallet ? (
              <span role="alert" style={fieldErr}>
                {apiErrors.wallet}
              </span>
            ) : null}
            <span style={help}>
              Only verified wallets can receive requests.{" "}
              <Link href="/wallets" style={{ fontWeight: 700 }}>
                Manage wallets
              </Link>
            </span>
          </div>

          <fieldset style={{ border: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
            <legend className="label" style={{ padding: 0, marginBottom: 8 }}>
              Asset
            </legend>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {ASSETS.map((a) => (
                <label key={a.code} style={assetStyle(asset === a.code)}>
                  <input
                    type="radio"
                    name="asset"
                    value={a.code}
                    checked={asset === a.code}
                    onChange={() => {
                      setAsset(a.code);
                      clearError("asset");
                      clearError("amount");
                    }}
                    style={{ width: 18, height: 18, accentColor: "var(--teal)", margin: 0 }}
                  />
                  <span style={{ display: "flex", flexDirection: "column" }}>
                    <span style={{ fontWeight: 800 }}>{a.code}</span>
                    <span style={help}>{a.sub}</span>
                  </span>
                </label>
              ))}
            </div>
            {apiErrors.asset ? (
              <span role="alert" style={fieldErr}>
                {apiErrors.asset}
              </span>
            ) : problem ? (
              <span role="status" style={{ ...fieldErr, color: "var(--attention-fg)" }}>
                {problem}{" "}
                <Link href="/wallets" style={{ fontWeight: 700 }}>
                  Check this wallet
                </Link>
              </span>
            ) : null}
          </fieldset>

          <div className="field">
            <label htmlFor="amount" className="label">
              Amount
            </label>
            <div style={{ position: "relative", maxWidth: 320 }}>
              <input
                id="amount"
                className="input tnum"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setAmountTouched(true);
                  clearError("amount");
                }}
                placeholder="0.00"
                aria-invalid={amountMsg !== ""}
                aria-describedby="amount-help"
                style={{ paddingRight: 70, fontSize: 20, fontWeight: 700, ...inputStyle(amountMsg !== "") }}
              />
              <span className="mono" style={{ position: "absolute", right: 14, top: 13, fontWeight: 700, color: "var(--slate)" }}>
                {asset}
              </span>
            </div>
            {amountMsg ? (
              <span role="alert" style={fieldErr}>
                {amountMsg}
              </span>
            ) : null}
            <span id="amount-help" style={help}>
              Up to 7 decimal places. Partial payments add up until the link expires.
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span id="expiry-label" className="label">
              Link expires after
            </span>
            <div role="group" aria-labelledby="expiry-label" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {EXPIRIES.map((x) => (
                <button
                  key={x.key}
                  type="button"
                  aria-pressed={expiry === x.key}
                  onClick={() => {
                    setExpiryChoice(x.key);
                    clearError("expiry");
                  }}
                  style={chipStyle(expiry === x.key)}
                >
                  {x.label}
                </button>
              ))}
            </div>
            {expiry === "custom" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <label htmlFor="mins" style={{ fontSize: 14, color: "var(--slate-strong)" }}>
                  Minutes
                </label>
                <input
                  id="mins"
                  type="number"
                  min={MIN_MINUTES}
                  max={MAX_MINUTES}
                  step={1}
                  value={customMin}
                  onChange={(e) => {
                    setCustomChoice(e.target.value);
                    clearError("expiry");
                  }}
                  aria-invalid={customBad}
                  style={{ width: 110, height: 44, borderRadius: 10, padding: "0 12px", fontSize: 15, border: customBad ? "1.5px solid var(--error-border)" : "1px solid var(--border-input)" }}
                />
                {customBad ? (
                  <span role="alert" style={fieldErr}>
                    Between 5 minutes and 30 days (43,200 minutes).
                  </span>
                ) : null}
              </div>
            ) : null}
            {apiErrors.expiry ? (
              <span role="alert" style={fieldErr}>
                {apiErrors.expiry}
              </span>
            ) : null}
            <span style={help}>
              Expires <span style={{ fontWeight: 700, color: "var(--ink)" }}>{expiresText}</span>.
            </span>
          </div>

          <div className="field">
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <label htmlFor="desc" className="label">
                Description
              </label>
              <span style={desc.length > DESC_MAX - 10 ? { fontSize: 13, color: "var(--attention-fg)", fontWeight: 700 } : help}>
                {desc.length}/{DESC_MAX}
              </span>
            </div>
            <input
              id="desc"
              className="input"
              value={desc}
              maxLength={DESC_MAX}
              onChange={(e) => {
                setDesc(e.target.value.slice(0, DESC_MAX));
                clearError("desc");
              }}
              placeholder="What is this payment for?"
              aria-invalid={descMsg !== ""}
              style={inputStyle(descMsg !== "")}
            />
            {descMsg ? (
              <span role="alert" style={fieldErr}>
                {descMsg}
              </span>
            ) : null}
            <span style={help}>Your customer sees this.</span>
          </div>

          <div className="field">
            <label htmlFor="ref" className="label">
              Order reference <span style={{ fontWeight: 500, color: "var(--slate)" }}>(optional)</span>
            </label>
            <input
              id="ref"
              className="input"
              value={ref}
              maxLength={64}
              onChange={(e) => {
                setRef(e.target.value);
                clearError("ref");
              }}
              placeholder="e.g. INV-2210"
              aria-invalid={Boolean(apiErrors.ref)}
              style={{ maxWidth: 320, ...inputStyle(Boolean(apiErrors.ref)) }}
            />
            {apiErrors.ref ? (
              <span role="alert" style={fieldErr}>
                {apiErrors.ref}
              </span>
            ) : null}
            <span style={help}>Only you see this. Handy for matching with your own books.</span>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, borderTop: "1px solid var(--border-soft)", paddingTop: 18, flexWrap: "wrap" }}>
            <Link href="/requests" className="btn btn-secondary" style={{ fontSize: 15 }}>
              Cancel
            </Link>
            <button type="submit" className="btn btn-primary" style={{ fontSize: 15 }} disabled={busy} aria-busy={busy}>
              {busy ? "Creating…" : "Create request"}
            </button>
          </div>
        </form>

        <aside aria-label="Customer preview" style={{ flex: "2 1 340px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--slate)", textTransform: "uppercase", letterSpacing: "0.08em" }}>What your customer sees</span>
          <div style={{ background: "var(--row)", border: "1px solid var(--border)", borderRadius: 22, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <span style={{ fontSize: 12, color: "var(--slate)" }}>Stellar Testnet · no real money</span>
            <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 38, height: 38, flexShrink: 0, borderRadius: 10, background: "var(--teal-tint)", color: "var(--teal-deep)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{initials(business)}</div>
                <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <span style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{business}</span>
                  <span style={{ fontSize: 13, color: "var(--slate)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{desc.trim() || "Add a description"}</span>
                </div>
              </div>
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span className="tnum" style={{ fontSize: 36, fontWeight: 800, letterSpacing: "-0.02em", overflowWrap: "anywhere" }}>
                  {amountErr ? "0.00" : formatAmount(amt)}
                </span>
                <span style={{ fontWeight: 700, color: "var(--slate)" }}>{asset}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <span className="pill pill-neutral">Pending</span>
                <span style={help}>
                  Expires in{" "}
                  <span className="mono" style={{ color: "var(--ink)" }}>
                    {previewTimer}
                  </span>
                </span>
              </div>
            </div>
            <div style={{ background: "var(--attention-bg)", border: "1px solid var(--attention-border)", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--attention-fg)" }}>Memo required</span>
              <span style={help}>Generated when you create the link</span>
            </div>
            <div aria-hidden="true" style={{ height: 48, borderRadius: 10, background: "var(--teal)", color: "#FFFFFF", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
              Pay with Freighter
            </div>
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8, fontSize: 14, color: "var(--slate-strong)" }}>
            <li style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Icon name={problem ? "alert" : "check"} size={14} strokeWidth={2.6} style={{ color: problem ? "var(--attention-fg)" : "var(--teal)" }} />
              {walletName(wallet)} {problem ? `can't receive ${asset} yet` : `can receive ${asset}`}
            </li>
            <li style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Icon name="check" size={14} strokeWidth={2.6} style={{ color: "var(--teal)" }} />
              Wallet ownership verified
            </li>
          </ul>
        </aside>
      </div>
    </>
  );
}

function CreatedView({ request, businessName, onAnother, onCopied }: { request: PaymentRequest; businessName: string; onAnother: () => void; onCopied: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    let live = true;
    QRCode.toDataURL(request.checkoutUrl, { margin: 0, width: 300, color: { dark: "#0F172A", light: "#FFFFFF" } })
      .then((url) => {
        if (live) setQr(url);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [request.checkoutUrl]);

  const amount = money(request.amount, request.asset.code);
  const summary = [request.customerRef, amount, request.description].filter(Boolean).join(" · ");
  const shareText = `${businessName ? `${businessName} is requesting` : "Payment request for"} ${amount}${request.description ? ` for ${request.description}` : ""}. Pay here: ${request.checkoutUrl}`;
  const secondary: React.CSSProperties = { fontSize: 15, padding: "0 18px" };

  return (
    <section aria-labelledby="created-title" className="card" style={{ width: "100%", maxWidth: 560, borderRadius: 18, padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div role="status" style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <span style={{ width: 44, height: 44, flexShrink: 0, borderRadius: "50%", background: "var(--teal-tint)", color: "var(--teal)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="check" size={22} strokeWidth={2.6} />
        </span>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <h2 id="created-title" style={{ fontSize: 22, fontWeight: 800 }}>
            Request created
          </h2>
          <span className="sub" style={{ overflowWrap: "anywhere" }}>
            {summary}
          </span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ padding: 10, border: "1px solid var(--border)", borderRadius: 12, background: "#FFFFFF", lineHeight: 0 }}>
          {qr ? (
            <img src={qr} width={150} height={150} alt="QR code for the checkout link" style={{ imageRendering: "pixelated" }} />
          ) : (
            <div className="skeleton" style={{ width: 150, height: 150 }} />
          )}
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--slate)" }}>Checkout link</span>
            <span className="mono" style={{ fontSize: 13, background: "var(--row)", border: "1px solid var(--border)", borderRadius: 8, padding: 10, wordBreak: "break-all" }}>
              {request.checkoutUrl}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
            <span style={{ color: "var(--slate)" }}>Memo</span>
            <span className="mono" style={{ fontWeight: 600 }}>
              {request.memo}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
            <span style={{ color: "var(--slate)" }}>Expires</span>
            <span style={{ fontWeight: 600 }}>{dayAt(request.expiresAt, now)}</span>
          </div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
        <button
          type="button"
          className="btn btn-primary"
          style={{ fontSize: 15 }}
          onClick={async () => {
            await copyText(request.checkoutUrl);
            onCopied();
          }}
        >
          <Icon name="copy" size={16} />
          Copy link
        </button>
        <a className="btn btn-secondary" style={secondary} href={`https://wa.me/?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noopener noreferrer">
          Share on WhatsApp
        </a>
        <a className="btn btn-secondary" style={secondary} href={request.checkoutUrl} target="_blank" rel="noopener noreferrer">
          Open checkout
        </a>
        <button type="button" className="btn btn-secondary" style={secondary} onClick={onAnother}>
          Create another
        </button>
      </div>
      <div style={{ display: "flex", justifyContent: "center", gap: 20, flexWrap: "wrap" }}>
        <Link href={`/requests/${request.id}`} style={{ fontSize: 14, fontWeight: 700, padding: 8 }}>
          View this request
        </Link>
        <Link href="/requests" style={{ fontSize: 14, fontWeight: 700, padding: 8 }}>
          Done, back to requests
        </Link>
      </div>
    </section>
  );
}
