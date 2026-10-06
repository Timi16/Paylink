import type { ChainPayment, PaymentOutcome, PaymentRequest, RequestStatus } from "./types";

export type PillTone = "neutral" | "good" | "warn" | "muted" | "danger";
export type IconName = "check" | "clock" | "alert" | "cross" | "dash";

export const ICON_PATHS: Record<IconName, string> = {
  check: "M5 12l5 5L20 7",
  clock: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 7v5l3 2",
  alert: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 8v5M12 16v.01",
  cross: "M6 6l12 12M18 6L6 18",
  dash: "M5 12h14",
};

interface PillSpec {
  label: string;
  tone: PillTone;
  icon: IconName;
}

export const REQUEST_STATUS: Record<RequestStatus, PillSpec> = {
  PENDING: { label: "Pending", tone: "neutral", icon: "clock" },
  UNDERPAID: { label: "Underpaid", tone: "warn", icon: "alert" },
  PAID: { label: "Paid", tone: "good", icon: "check" },
  OVERPAID: { label: "Overpaid", tone: "good", icon: "check" },
  EXPIRED: { label: "Expired", tone: "muted", icon: "cross" },
  CANCELLED: { label: "Cancelled", tone: "muted", icon: "dash" },
  NETWORK_RESET: { label: "Network reset", tone: "muted", icon: "dash" },
};

/** How each payment outcome is worded for a merchant, and what they should do about it. */
export const PAYMENT_OUTCOME: Record<PaymentOutcome, PillSpec & { explain: string }> = {
  COUNTED: { label: "Applied", tone: "good", icon: "check", explain: "Counted toward the request." },
  DUPLICATE: { label: "Refund owed", tone: "warn", icon: "alert", explain: "The request was already paid. Send this one back." },
  LATE: { label: "Arrived late", tone: "warn", icon: "alert", explain: "It arrived after the link expired. Accept it, or send it back." },
  AFTER_CANCEL: { label: "After cancel", tone: "warn", icon: "alert", explain: "It arrived after you cancelled. Accept it, or send it back." },
  AFTER_RESET: { label: "After reset", tone: "muted", icon: "dash", explain: "It arrived after a testnet reset closed the request." },
  WRONG_ASSET: { label: "Wrong asset", tone: "danger", icon: "cross", explain: "Right memo, wrong asset. It doesn't count. Send it back." },
  WRONG_ISSUER: { label: "Fake asset", tone: "danger", icon: "cross", explain: "Same name, different issuer. This is not the asset you asked for." },
  WRONG_WALLET: { label: "Wrong wallet", tone: "danger", icon: "cross", explain: "The memo belongs to a request on another wallet." },
  NO_MEMO: { label: "No memo", tone: "danger", icon: "alert", explain: "No memo, so it couldn't be matched to a request." },
  UNKNOWN_MEMO: { label: "Unknown memo", tone: "danger", icon: "alert", explain: "The memo doesn't match any request." },
  MEMO_TYPE_MISMATCH: { label: "Wrong memo type", tone: "danger", icon: "alert", explain: "The memo was a number or hash, not the text memo." },
};

export const OPEN_STATUSES: RequestStatus[] = ["PENDING", "UNDERPAID"];
export const isOpen = (status: RequestStatus) => OPEN_STATUSES.includes(status);

/** What to call a request in lists: the merchant's reference, else the description, else the memo. */
export function requestTitle(r: Pick<PaymentRequest, "customerRef" | "description" | "memo">): string {
  return r.customerRef || r.description || r.memo;
}

/** The secondary line under the title. */
export function requestSubtitle(r: Pick<PaymentRequest, "customerRef" | "description" | "memo">): string {
  return r.customerRef && r.description ? r.description : r.memo;
}

export const isUnmatched = (p: Pick<ChainPayment, "outcome" | "requestId">) =>
  p.requestId === null && (p.outcome === "NO_MEMO" || p.outcome === "UNKNOWN_MEMO" || p.outcome === "MEMO_TYPE_MISMATCH");
