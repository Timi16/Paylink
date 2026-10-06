"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { initials } from "@/lib/format";
import { useLogout, useUnmatchedCount, useWallets } from "@/lib/session";
import type { Merchant } from "@/lib/types";
import { Icon, type AnyIcon } from "./Icon";
import { Logo } from "./Logo";

const NAV: { href: string; label: string; icon: AnyIcon }[] = [
  { href: "/dashboard", label: "Overview", icon: "overview" },
  { href: "/requests", label: "Requests", icon: "requests" },
  { href: "/payments", label: "Payments", icon: "payments" },
  { href: "/unmatched", label: "Unmatched", icon: "unmatched" },
  { href: "/wallets", label: "Wallets", icon: "wallets" },
  { href: "/api-keys", label: "API keys", icon: "keys" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

export function AppShell({ merchant, children }: { merchant: Merchant; children: React.ReactNode }) {
  const pathname = usePathname();
  const logout = useLogout();
  const unmatched = useUnmatchedCount();
  const { data: wallets } = useWallets();
  const verified = wallets?.data.some((w) => w.verified);
  const merchantNote = wallets === undefined ? " " : verified ? "Verified merchant" : "Wallet not verified yet";

  return (
    <div className="shell">
      <nav aria-label="Main" className="shell-nav">
        <Logo href="/dashboard" style={{ padding: "4px 10px 18px" }} />
        <div
          className="nav-merchant"
          style={{ margin: "0 2px 14px", padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10, display: "flex", alignItems: "center", gap: 10 }}
        >
          <div
            style={{ width: 32, height: 32, flexShrink: 0, borderRadius: 8, background: "var(--teal-tint)", color: "var(--teal-deep)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13 }}
          >
            {initials(merchant.businessName)}
          </div>
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <span style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{merchant.businessName}</span>
            <span style={{ fontSize: 12, color: "var(--slate)" }}>{merchantNote}</span>
          </div>
        </div>
        {NAV.map((item) => {
          const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link key={item.href} href={item.href} className="nav-link" aria-current={current ? "page" : undefined}>
              <Icon name={item.icon} />
              {item.label}
              {item.href === "/unmatched" && unmatched ? (
                <span className="nav-badge" aria-label={`${unmatched} unmatched payments`}>
                  {unmatched >= 100 ? "99+" : unmatched}
                </span>
              ) : null}
            </Link>
          );
        })}
        <div className="nav-foot" style={{ marginTop: "auto", padding: "16px 10px 4px", borderTop: "1px solid var(--border-soft)", display: "flex", flexDirection: "column", gap: 12 }}>
          <span className="tag-testnet" style={{ alignSelf: "flex-start" }}>
            Stellar Testnet
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              className="nav-foot-user"
              style={{ width: 32, height: 32, flexShrink: 0, borderRadius: "50%", background: "var(--ink)", color: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}
            >
              {initials(merchant.email)}
            </div>
            <span className="nav-foot-user" style={{ fontSize: 12, color: "var(--slate)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {merchant.email}
            </span>
            <button type="button" onClick={logout} aria-label="Log out" style={{ marginLeft: "auto", color: "var(--slate)", display: "inline-flex", border: "none", background: "transparent", padding: 6 }}>
              <Icon name="logout" />
            </button>
          </div>
        </div>
      </nav>
      {/* Keyed by route so each page plays its arrival once. */}
      <main key={pathname} className="shell-main">
        {children}
      </main>
    </div>
  );
}
