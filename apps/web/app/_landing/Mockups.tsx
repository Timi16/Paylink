import { LogoMark } from "@/components/Logo";
import { QR_DOTS } from "./content";
import s from "./landing.module.css";

/*
 * Product illustrations. Everything in this file is sample content drawn to show what the product
 * looks like ("Ada's Kitchen", "Order #1044" …). Each one is exposed to assistive tech as a single
 * labelled image, so none of it is read out as if it were live data.
 */

type Tone = "good" | "warn" | "neutral";
const TONE: Record<Tone, string> = { good: s.tagGood ?? "", warn: s.tagWarn ?? "", neutral: s.tagNeutral ?? "" };

function Tag({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`${s.tag} ${TONE[tone]}`}>{children}</span>;
}

export function Arrow({ size = 16, strokeWidth = 2.5 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function Check({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

const SAMPLE_ROWS: { order: string; amount: string; tone: Tone; status: string; when: string }[] = [
  { order: "Order #1044", amount: "80.00 USDC", tone: "good", status: "Paid", when: "9 min ago" },
  { order: "Order #1041", amount: "120.00 USDC", tone: "warn", status: "Underpaid", when: "9 min left" },
  { order: "Order #1042", amount: "50.00 USDC", tone: "good", status: "Paid", when: "40 min ago" },
];

export function HeroArt() {
  return (
    <div
      className={s.heroArt}
      role="img"
      aria-label="Illustration: an example PayLink dashboard, a checkout page stamped Paid, and a payment received notification."
    >
      <div className={s.artDash}>
        <div className={s.artBar}>
          <i />
          <i />
          <i />
          <span>Overview · Ada&apos;s Kitchen</span>
        </div>
        <div className={s.artBody}>
          <div className={s.artStats}>
            <div className={s.artStat}>
              <div>Collected today</div>
              <div>242.50</div>
            </div>
            <div className={s.artStat}>
              <div>Waiting on customers</div>
              <div>4</div>
            </div>
            <div className={s.artStat}>
              <div>Links paid</div>
              <div>86%</div>
            </div>
          </div>
          <div className={s.artRows}>
            <div className={s.artRow}>
              <b>Order #1044</b>
              <span className={s.mono}>80.00 USDC</span>
              <Tag tone="good">Paid</Tag>
            </div>
            <div className={s.artRow}>
              <b>Order #1041</b>
              <span className={s.mono}>120.00 USDC</span>
              <Tag tone="warn">Underpaid</Tag>
            </div>
            <div className={s.artRow}>
              <b>Order #1046</b>
              <span className={s.mono}>35.00 USDC</span>
              <Tag tone="neutral">Pending</Tag>
            </div>
          </div>
        </div>
      </div>

      <div className={s.artPhone}>
        <div className={s.artPhoneIn}>
          <span className={s.artPhoneNet}>Stellar Testnet · no real money</span>
          <div className={`${s.artCard} ${s.artPaid}`}>
            <div className={s.stamp}>PAID</div>
            <span className={s.artAmount}>
              50.00 <small>USDC</small>
            </span>
            <span className={s.artTiny}>to Ada&apos;s Kitchen</span>
          </div>
          <div className={`${s.artCard} ${s.artMeta}`}>
            <div>
              <span>Memo</span>
              <span className={s.mono}>PL7K2M9QXA</span>
            </div>
            <div>
              <span>Tx</span>
              <span className={s.mono} style={{ color: "var(--teal)" }}>
                e3f9…2d14
              </span>
            </div>
          </div>
          <div className={s.artPhoneBtn}>View on Stellar Expert</div>
        </div>
      </div>

      <div className={s.artToast}>
        <span className={s.artToastIcon}>
          <Check />
        </span>
        <div>
          <span>Payment received</span>
          <span>80.00 USDC · Order #1044 · just now</span>
        </div>
      </div>
    </div>
  );
}

export function StepArt({ step }: { step: 1 | 2 | 3 }) {
  if (step === 1) {
    return (
      <div className={`${s.stepArt} ${s.stepArtCol}`} role="img" aria-label="Illustration: an amount of 18.00 USDC with a 30 minute expiry selected.">
        <span className={s.miniLabel}>Amount</span>
        <div className={s.amountBox}>
          <span>18.00</span>
          <span>USDC</span>
        </div>
        <div className={s.chips}>
          <span className={s.chip}>15 min</span>
          <span className={`${s.chip} ${s.chipOn}`}>30 min</span>
          <span className={s.chip}>1 hour</span>
        </div>
      </div>
    );
  }
  if (step === 2) {
    return (
      <div className={`${s.stepArt} ${s.stepArtRow}`} role="img" aria-label="Illustration: a QR code next to a checkout link that has just been copied.">
        <svg width="96" height="96" viewBox="0 0 25 25" shapeRendering="crispEdges" className={s.qr} aria-hidden="true">
          {[
            [0, 0],
            [18, 0],
            [0, 18],
          ].map(([x = 0, y = 0]) => (
            <g key={`${x}-${y}`}>
              <rect x={x} y={y} width="7" height="7" fill="#0F172A" />
              <rect x={x + 1} y={y + 1} width="5" height="5" fill="#FFFFFF" />
              <rect x={x + 2} y={y + 2} width="3" height="3" fill="#0F172A" />
            </g>
          ))}
          <path fill="#0F172A" d={QR_DOTS} />
        </svg>
        <div className={s.linkCol}>
          <span className={s.miniLabel}>Checkout link</span>
          <span className={s.linkBox}>…/pay/r8Qw2LmX0aZ1</span>
          <span className={s.copied}>Copied</span>
        </div>
      </div>
    );
  }
  return (
    <div className={`${s.stepArt} ${s.stepArtCenter}`} role="img" aria-label="Illustration: a request changing from Pending to Paid, with its transaction hash.">
      <div className={s.flip}>
        <Tag tone="neutral">Pending</Tag>
        <span style={{ color: "#94A3B8", display: "inline-flex" }}>
          <Arrow size={18} strokeWidth={2.2} />
        </span>
        <Tag tone="good">Paid</Tag>
      </div>
      <div className={s.txBox}>
        <span>Transaction</span>
        <span>7a1c…e90b</span>
      </div>
    </div>
  );
}

export function DashboardArt() {
  return (
    <div
      className={s.dash}
      role="img"
      aria-label="Illustration: an example PayLink overview with totals for the day, a needs-attention count and a list of recent requests."
    >
      <div className={s.dashSide}>
        <span className={s.dashBrand}>
          <LogoMark size={26} />
          PayLink
        </span>
        <span className={`${s.dashItem} ${s.dashItemOn}`}>Overview</span>
        <span className={s.dashItem}>Requests</span>
        <span className={s.dashItem}>Payments</span>
        <span className={s.dashItem}>
          Unmatched<span className={s.dashCount}>3</span>
        </span>
        <span className={s.dashItem}>Wallets</span>
      </div>
      <div className={s.dashMain}>
        <span className={s.dashHello}>Good morning, Ada</span>
        <div className={s.dashStats}>
          <div className={s.dashStat}>
            <div>Collected today</div>
            <div>242.50</div>
            <div>USDC · 5 payments</div>
          </div>
          <div className={s.dashStat}>
            <div>Waiting on customers</div>
            <div>4</div>
            <div>1 underpaid</div>
          </div>
          <div className={s.dashStat}>
            <div>Links paid this week</div>
            <div>86%</div>
            <div>43 of 50</div>
          </div>
          <div className={`${s.dashStat} ${s.dashStatAttn}`}>
            <div>Needs attention</div>
            <div>5</div>
            <div>3 unmatched · 2 refunds</div>
          </div>
        </div>
        <div className={s.dashTableScroll}>
          <div className={s.dashTable}>
            <div className={`${s.dashTr} ${s.dashTh}`}>
              <span>Request</span>
              <span>Amount</span>
              <span>Status</span>
              <span>When</span>
            </div>
            {SAMPLE_ROWS.map((r) => (
              <div key={r.order} className={s.dashTr}>
                <b>{r.order}</b>
                <span className={s.mono}>{r.amount}</span>
                <span>
                  <Tag tone={r.tone}>{r.status}</Tag>
                </span>
                <span className={s.dashWhen}>{r.when}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
