"use client";

import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toast";
import { formatAmount, formatTime } from "@/lib/format";
import type { AssetRef, ChainPayment, PaymentOutcome, PaymentRequest } from "@/lib/types";

/** Below 0.01 of an asset a refund is dust: anyone can attach a one-stroop payment to a public memo. */
export const DUST_STROOPS = 100_000n;

/** Outcomes where money reached the wallet but was not applied, so it should go back. */
export const REFUNDABLE_OUTCOMES: PaymentOutcome[] = ["DUPLICATE", "LATE", "AFTER_CANCEL", "AFTER_RESET", "WRONG_ASSET"];

/** Payments recorded before a testnet reset: that money no longer exists on the network. */
export const isPreReset = (p: Pick<ChainPayment, "eventId">) => p.eventId.startsWith("reset-");

export const sameAsset = (a: AssetRef, b: AssetRef) => a.code === b.code && (a.issuer ?? null) === (b.issuer ?? null);

/** "50.00 USDC" */
export const money = (amount: string, code: string) => `${formatAmount(amount)} ${code}`;

/** Stroops (bigint, not negative) -> a 7-decimal string, for amounts worked out on screen. */
export function fromStroops(stroops: bigint): string {
  const abs = stroops < 0n ? 0n : stroops;
  return `${abs / 10_000_000n}.${(abs % 10_000_000n).toString().padStart(7, "0")}`;
}

/** "today at 10:42", "tomorrow at 09:00", "yesterday at 18:20", "12 Oct at 10:42". */
export function dayAt(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  const day = (offset: number) => new Date(now + offset * 86_400_000).toDateString();
  const key = at.toDateString();
  let label: string;
  if (key === day(0)) label = "today";
  else if (key === day(1)) label = "tomorrow";
  else if (key === day(-1)) label = "yesterday";
  else {
    const sameYear = at.getFullYear() === new Date(now).getFullYear();
    label = at.toLocaleDateString("en-GB", sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
  }
  return `${label} at ${formatTime(iso)}`;
}

export async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Clipboard API unavailable (insecure context): fall back to a hidden textarea.
    const area = document.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/** The design's 40 px square copy button; confirms with a toast. */
export function CopyIconButton({ value, ariaLabel, toast }: { value: string; ariaLabel: string; toast: string }) {
  const show = useToast();
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={async () => {
        await copyText(value);
        show(toast);
      }}
      style={{ width: 40, height: 40, flexShrink: 0, border: "1px solid var(--border)", background: "var(--surface)", borderRadius: 8, color: "var(--slate-strong)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
    >
      <Icon name="copy" size={16} />
    </button>
  );
}

export interface RefundLine {
  asset: AssetRef;
  amount: string;
  stroops: bigint;
}

/**
 * Splits what a request still owes back into its two sources:
 * - `payments`: linked payments that were not applied and are not yet marked refunded;
 * - `own`: whatever `refundDue` holds beyond those (overpaid excess, or money counted before
 *   the request closed), which is recorded against the request itself.
 * Dust is left out of both.
 */
export function splitRefunds(request: PaymentRequest, payments: ChainPayment[]): { payments: ChainPayment[]; own: RefundLine[] } {
  const pending = payments.filter((p) => REFUNDABLE_OUTCOMES.includes(p.outcome) && !isPreReset(p) && p.refundedAt === null);
  const own: RefundLine[] = [];
  for (const line of request.refundDue) {
    const explained = pending.filter((p) => sameAsset(p.asset, line.asset)).reduce((sum, p) => sum + BigInt(p.amountStroops), 0n);
    const rest = BigInt(line.amountStroops) - explained;
    if (rest >= DUST_STROOPS) own.push({ asset: line.asset, amount: fromStroops(rest), stroops: rest });
  }
  return { payments: pending.filter((p) => BigInt(p.amountStroops) >= DUST_STROOPS), own };
}
