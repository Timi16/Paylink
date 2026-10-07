"use client";

import Link from "next/link";
import useSWR from "swr";
import { CopyButton } from "@/components/CopyButton";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toast";
import { errorMessage } from "@/lib/api";
import { shortAddress, timeAgo } from "@/lib/format";
import { useNow, usePollWhenOffline } from "@/lib/live";
import { useMe } from "@/lib/session";
import type { Page, PaymentRequest, RequestStats, Wallet } from "@/lib/types";
import { AddWalletForm } from "../wallets/_components/AddWalletForm";
import { USDC_ISSUER, useVerifyWallet, VerifyProgress, walletName } from "../wallets/_components/useVerifyWallet";

type StepState = "done" | "active" | "locked";

const CARD: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: "18px 20px", display: "flex", gap: 16, alignItems: "center" };
const CARD_ACTIVE: React.CSSProperties = { background: "var(--surface)", border: "2px solid var(--teal)", borderRadius: 14, padding: 20, display: "flex", gap: 16 };
const BADGE: React.CSSProperties = { width: 36, height: 36, flexShrink: 0, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800 };

function Badge({ n, state }: { n: number; state: StepState }) {
  if (state === "done") {
    return (
      <span style={{ ...BADGE, background: "var(--teal)", color: "#FFFFFF" }}>
        <Icon name="check" size={18} strokeWidth={2.5} />
        <span className="sr-only">Done:</span>
      </span>
    );
  }
  if (state === "active") return <span style={{ ...BADGE, background: "var(--teal-tint)", color: "var(--teal-deep)" }}>{n}</span>;
  return <span style={{ ...BADGE, border: "2px solid var(--border-input)", color: "var(--slate)" }}>{n}</span>;
}

/** A finished or not-yet-reachable step: one compact row. */
function Row({ n, state, title, sub, after, action }: { n: number; state: "done" | "locked"; title: string; sub: React.ReactNode; after?: number; action?: React.ReactNode }) {
  return (
    <li style={CARD}>
      <Badge n={n} state={state} />
      <div style={{ display: "flex", flexDirection: "column", gap: 2, flexGrow: 1, minWidth: 0 }}>
        <span style={{ fontWeight: 700 }}>{title}</span>
        <span style={{ fontSize: 14, color: "var(--slate)" }}>{sub}</span>
      </div>
      {state === "locked" && after ? <span style={{ fontSize: 13, color: "var(--slate)", flexShrink: 0 }}>After step {after}</span> : action}
    </li>
  );
}

/** The step to do now: the highlighted card. */
function Active({ n, title, sub, children }: { n: number; title: string; sub: string; children: React.ReactNode }) {
  return (
    <li style={CARD_ACTIVE} aria-current="step">
      <Badge n={n} state="active" />
      <div style={{ display: "flex", flexDirection: "column", gap: 12, flexGrow: 1, minWidth: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontWeight: 700, fontSize: 17 }}>{title}</span>
          <span style={{ fontSize: 14, color: "var(--slate)", maxWidth: 560 }}>{sub}</span>
        </div>
        {children}
      </div>
    </li>
  );
}

const STEP3_SUB = "Pick an amount and how long the link stays open.";
const STEP4_SUB = "Send it on WhatsApp, print the QR, or open it on a second phone to test.";

export default function GetStartedPage() {
  const toast = useToast();
  const now = useNow();
  const poll = usePollWhenOffline();
  const { merchant } = useMe();
  const walletsQ = useSWR<{ data: Wallet[] }>("/v1/wallets", { refreshInterval: poll });
  const requestsQ = useSWR<Page<PaymentRequest>>("/v1/payment-requests?limit=1", { refreshInterval: poll });
  const statsQ = useSWR<RequestStats>("/v1/payment-requests/stats", { refreshInterval: poll });
  const { state: verifyState, verify, busy: verifyBusy } = useVerifyWallet();

  const loading = !walletsQ.data || !requestsQ.data || !statsQ.data;
  const loadError = (!walletsQ.data && walletsQ.error) || (!requestsQ.data && requestsQ.error) || (!statsQ.data && statsQ.error) || null;

  const wallets = walletsQ.data?.data ?? [];
  // The wallet these steps are about: the default, else a verified one, else the first added.
  const wallet = wallets.find((w) => w.id === merchant?.defaultWalletId) ?? wallets.find((w) => w.verified) ?? wallets[0] ?? null;
  const latest = requestsQ.data?.data[0] ?? null;
  const paidCount = (statsQ.data?.byStatus.PAID ?? 0) + (statsQ.data?.byStatus.OVERPAID ?? 0);

  const done = [wallet !== null, wallet?.verified === true, latest !== null, paidCount > 0];
  const doneCount = done.filter(Boolean).length;
  const firstTodo = done.indexOf(false); // -1 when everything is done
  const stateOf = (i: number): StepState => (done[i] ? "done" : i === firstTodo ? "active" : "locked");
  const allDone = firstTodo === -1;

  const onVerify = async () => {
    if (!wallet) return;
    const verified = await verify(wallet);
    if (verified) toast("Wallet verified");
  };

  const verifying = wallet && verifyState.walletId === wallet.id ? verifyState.phase : null;
  const verifyError = wallet && verifyState.walletId === wallet.id ? verifyState.error : null;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: "1 1 520px", maxWidth: 760, minWidth: 0 }}>
          <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em" }}>Let&apos;s get you paid</h1>
          <span style={{ fontSize: 15, color: "var(--slate)" }}>Four steps, about five minutes. Everything runs on free Testnet money.</span>
          {loading ? null : (
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
              <div
                role="progressbar"
                aria-label="Setup progress"
                aria-valuemin={0}
                aria-valuemax={4}
                aria-valuenow={doneCount}
                aria-valuetext={`${doneCount} of 4 done`}
                style={{ flexGrow: 1, height: 8, borderRadius: 999, background: "var(--border)", overflow: "hidden" }}
              >
                <div style={{ height: 8, background: "var(--teal)", width: `${doneCount * 25}%` }} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--teal-deep)", whiteSpace: "nowrap" }}>{doneCount} of 4 done</span>
            </div>
          )}
        </div>
        <Link href="/dashboard" style={{ fontSize: 14, fontWeight: 700, color: "var(--slate)" }}>
          {allDone && !loading ? "Go to your overview" : "Skip for now"}
        </Link>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
        {loadError ? (
          <div className="card empty" role="alert" style={{ flex: "2 1 520px", minWidth: 0 }}>
            <strong>We couldn&apos;t load your setup</strong>
            <span>{errorMessage(loadError)}</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ marginTop: 8 }}
              onClick={() => {
                void walletsQ.mutate();
                void requestsQ.mutate();
                void statsQ.mutate();
              }}
            >
              Try again
            </button>
          </div>
        ) : loading ? (
          <div style={{ flex: "2 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }} aria-busy="true" aria-label="Loading your setup">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} style={CARD}>
                <span className="skeleton" style={{ width: 36, height: 36, borderRadius: "50%", flexShrink: 0 }} />
                <div style={{ display: "flex", flexDirection: "column", gap: 6, flexGrow: 1 }}>
                  <span className="skeleton" style={{ width: 180, maxWidth: "100%", height: 16 }} />
                  <span className="skeleton" style={{ width: 280, maxWidth: "100%", height: 14 }} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <ol style={{ flex: "2 1 520px", minWidth: 0, margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 14 }}>
            {/* 1. Add a wallet */}
            {wallet ? (
              <Row
                n={1}
                state="done"
                title="Add your wallet"
                sub={
                  <>
                    {wallet.label ? `${wallet.label} · ` : null}
                    <span className="mono" title={wallet.address}>
                      {shortAddress(wallet.address)}
                    </span>
                  </>
                }
                action={
                  <Link href="/wallets" style={{ fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
                    Change
                  </Link>
                }
              />
            ) : (
              <Active n={1} title="Add your wallet" sub="Paste the public address of the wallet you want to be paid into. PayLink never holds your funds or your keys.">
                <AddWalletForm existing={wallets} labelPlaceholder="e.g. Main wallet" onAdded={(w) => toast(`${walletName(w)} added`)} />
              </Active>
            )}

            {/* 2. Prove it is yours */}
            {stateOf(1) === "done" && wallet ? (
              <Row n={2} state="done" title="Wallet verified" sub={wallet.verifiedAt ? `Signed in Freighter ${timeAgo(wallet.verifiedAt, now)}` : "Signed in Freighter"} />
            ) : stateOf(1) === "active" ? (
              <Active
                n={2}
                title="Prove the wallet is yours"
                sub="Sign a one-time message in Freighter. It doesn't move money or cost a fee, and it stops anyone else from pointing customers at your wallet."
              >
                {verifyError ? (
                  <div role="alert" className="notice">
                    {verifyError}
                  </div>
                ) : null}
                {verifying ? <VerifyProgress phase={verifying} /> : null}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                  <button type="button" className="btn btn-primary" onClick={onVerify} disabled={verifyBusy} aria-busy={verifyBusy}>
                    Verify with Freighter
                  </button>
                  <span style={{ fontSize: 13, color: "var(--slate)" }}>Set Freighter to Testnet and select this account first.</span>
                </div>
              </Active>
            ) : (
              <Row n={2} state="locked" after={1} title="Prove the wallet is yours" sub="Sign a one-time message in Freighter. It doesn't move money or cost a fee." />
            )}

            {/* 3. First request */}
            {stateOf(2) === "done" ? (
              <Row
                n={3}
                state="done"
                title="Create your first request"
                sub={latest ? `Latest request created ${timeAgo(latest.createdAt, now)}` : STEP3_SUB}
                action={
                  <Link href="/requests" style={{ fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
                    View requests
                  </Link>
                }
              />
            ) : stateOf(2) === "active" ? (
              <Active n={3} title="Create your first request" sub={STEP3_SUB}>
                <Link href="/requests/new" className="btn btn-primary" style={{ alignSelf: "flex-start" }}>
                  Create a request
                </Link>
              </Active>
            ) : (
              <Row n={3} state="locked" after={2} title="Create your first request" sub={STEP3_SUB} />
            )}

            {/* 4. Get paid */}
            {stateOf(3) === "done" ? (
              <Row
                n={4}
                state="done"
                title="Share the link and get paid"
                sub={`${paidCount} request${paidCount === 1 ? "" : "s"} paid`}
                action={
                  <Link href="/payments" style={{ fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
                    View payments
                  </Link>
                }
              />
            ) : stateOf(3) === "active" && latest ? (
              <Active n={4} title="Share the link and get paid" sub={STEP4_SUB}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                  <Link href={`/requests/${latest.id}`} className="btn btn-primary">
                    Open your request
                  </Link>
                  <span style={{ fontSize: 13, color: "var(--slate)" }}>This step ticks itself off when a payment settles a request.</span>
                </div>
              </Active>
            ) : (
              <Row n={4} state="locked" after={3} title="Share the link and get paid" sub={STEP4_SUB} />
            )}
          </ol>
        )}

        <aside className="card" style={{ flex: "1 1 300px", minWidth: 0, padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <span style={{ fontWeight: 700 }}>New to Stellar Testnet?</span>
          <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 10, fontSize: 14, color: "var(--slate-strong)" }}>
            <li>
              Fund your wallet with free test XLM from{" "}
              <a href="https://lab.stellar.org/account/fund" target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
                Friendbot
              </a>
              .
            </li>
            <li>
              Add a USDC trustline. Issuer{" "}
              <span className="mono" title={USDC_ISSUER} style={{ fontSize: 13 }}>
                {shortAddress(USDC_ISSUER)}
              </span>
              . <CopyButton value={USDC_ISSUER} label="Copy issuer" className="btn-link" style={{ fontSize: 13 }} ariaLabel="Copy the USDC issuer address" />
            </li>
            <li>
              Get test USDC from{" "}
              <a href="https://faucet.circle.com" target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
                Circle&apos;s faucet
              </a>
              .
            </li>
          </ol>
          <div style={{ background: "var(--row)", borderRadius: 10, padding: "12px 14px", fontSize: 13, color: "var(--slate)" }}>
            Tip: pay your own link from a second wallet. You&apos;ll watch it flip to Paid live.
          </div>
        </aside>
      </div>
    </>
  );
}
