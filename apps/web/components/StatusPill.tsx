import { PAYMENT_OUTCOME, REQUEST_STATUS, type IconName, type PillTone } from "@/lib/status";
import type { PaymentOutcome, RequestStatus } from "@/lib/types";
import { Icon } from "./Icon";

export function Pill({ tone, icon, children }: { tone: PillTone; icon?: IconName; children: React.ReactNode }) {
  return (
    <span className={`pill pill-${tone}`}>
      {icon ? <Icon name={icon} size={12} strokeWidth={2.5} /> : null}
      {children}
    </span>
  );
}

export function RequestStatusPill({ status }: { status: RequestStatus }) {
  const spec = REQUEST_STATUS[status];
  return (
    <Pill tone={spec.tone} icon={spec.icon}>
      {spec.label}
    </Pill>
  );
}

export function OutcomePill({ outcome }: { outcome: PaymentOutcome }) {
  const spec = PAYMENT_OUTCOME[outcome];
  return (
    <Pill tone={spec.tone} icon={spec.icon}>
      {spec.label}
    </Pill>
  );
}
