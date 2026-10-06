"use client";

import { useRef, useState } from "react";
import { API_URL } from "@/lib/config";
import s from "./landing.module.css";

const ENDPOINT = `${API_URL}/v1/payment-requests`;

/* Samples follow the real contract: JSON body, a wallet id, amounts as decimal strings. */
const SAMPLES = [
  {
    id: "curl",
    label: "cURL",
    code: `curl ${ENDPOINT} \\
  -H "Authorization: Bearer pl_test_…" \\
  -H "Idempotency-Key: order-1047" \\
  -H "Content-Type: application/json" \\
  -d '{
    "walletId": "YOUR_WALLET_ID",
    "amount": "18.00",
    "asset": "USDC",
    "description": "Moi moi, 20 wraps"
  }'`,
  },
  {
    id: "node",
    label: "Node.js",
    code: `const res = await fetch("${ENDPOINT}", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + process.env.PAYLINK_KEY,
    "Idempotency-Key": "order-1047",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    walletId: process.env.PAYLINK_WALLET_ID,
    amount: "18.00",
    asset: "USDC",
  }),
});
const { checkoutUrl } = await res.json();`,
  },
  {
    id: "res",
    label: "Response",
    code: `{
  "request": {
    "status": "PENDING",
    "amount": "18.0000000",
    "asset": { "code": "USDC", "issuer": "G…" },
    "memo": "PLW5G2HT9N",
    "expiresAt": "2026-10-04T11:03:00.000Z",
    …
  },
  "checkoutUrl": "https://…/pay/r8Qw2LmX0aZ1"
}`,
  },
] as const;

export function CodeTabs() {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const last = SAMPLES.length - 1;
    let next: number;
    if (e.key === "ArrowRight") next = active === last ? 0 : active + 1;
    else if (e.key === "ArrowLeft") next = active === 0 ? last : active - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else return;
    e.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  };

  const sample = SAMPLES[active] ?? SAMPLES[0];

  return (
    <div className={s.code}>
      <div role="tablist" aria-label="Code sample" className={s.tabs} onKeyDown={onKeyDown}>
        {SAMPLES.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`code-tab-${t.id}`}
            aria-selected={i === active}
            aria-controls="code-panel"
            tabIndex={i === active ? 0 : -1}
            className={i === active ? `${s.tab} ${s.tabOn}` : s.tab}
            onClick={() => setActive(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <pre id="code-panel" role="tabpanel" aria-labelledby={`code-tab-${sample.id}`} tabIndex={0} className={s.pre}>
        {sample.code}
      </pre>
    </div>
  );
}
