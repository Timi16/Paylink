"use client";

import { useMe } from "@/lib/session";
import { BusinessCard } from "./_components/BusinessCard";
import { DefaultsCard } from "./_components/DefaultsCard";
import { PasswordCard } from "./_components/PasswordCard";
import { Section } from "./_components/Section";
import { SessionsCard } from "./_components/SessionsCard";

export default function SettingsPage() {
  // The app layout only renders pages once the merchant is loaded.
  const { merchant } = useMe();
  if (!merchant) return null;

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h1 className="h1">Settings</h1>
        <span className="sub">Your business details, defaults and sign-in security.</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
        <div style={{ flex: "3 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}>
          <BusinessCard merchant={merchant} />
          <DefaultsCard merchant={merchant} />
          <PasswordCard email={merchant.email} />
        </div>
        <aside style={{ flex: "2 1 340px", minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}>
          <SessionsCard />
          <Section title="Network">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14 }}>
              <span className="muted">Stellar network</span>
              <span style={{ fontWeight: 700 }}>Testnet</span>
            </div>
            <span style={{ fontSize: 13, color: "var(--slate)" }}>Mainnet is off for this account. Nothing here moves real money.</span>
          </Section>
        </aside>
      </div>
    </>
  );
}
