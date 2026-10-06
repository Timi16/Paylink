import { Logo } from "./Logo";

/** The night-sky left panel of the sign-up and sign-in screens. */
export function AuthHero({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="auth-hero">
      <Logo on="dark" size={36} fontSize={22} />
      <h1>{title}</h1>
      {children}
      <span style={{ marginTop: "auto", fontSize: 13, color: "var(--slate-soft)" }}>Stellar Testnet · no real money moves</span>
    </section>
  );
}
