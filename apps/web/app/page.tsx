import type { Metadata } from "next";
import Link from "next/link";
import { Logo, LogoMark } from "@/components/Logo";
import { API_URL } from "@/lib/config";
import { CodeTabs } from "./_landing/CodeTabs";
import { DASH_POINTS, FAQS, FEATURES, NETWORK_FACTS, STEPS_COPY } from "./_landing/content";
import { Arrow, Check, DashboardArt, HeroArt, StepArt } from "./_landing/Mockups";
import s from "./_landing/landing.module.css";

export const metadata: Metadata = {
  title: { absolute: "PayLink — get paid in USDC on Stellar Testnet" },
  description:
    "Create a USDC payment request, share one link, and watch it flip to Paid with the transaction hash. Payments go straight to your own Stellar wallet. Currently in beta on Stellar Testnet.",
};

const DOCS_URL = `${API_URL}/docs`;

export default function LandingPage() {
  return (
    <div className={s.root}>
      <section className={s.hero}>
        <div aria-hidden="true" className={s.heroBg} />
        <div className={s.wrap}>
          <header className={s.header}>
            <Logo on="dark" size={34} fontSize={21} />
            <nav aria-label="Main" className={s.nav}>
              <a className={s.navLink} href="#how">How it works</a>
              <a className={s.navLink} href="#features">Features</a>
              <a className={s.navLink} href="#developers">Developers</a>
              <a className={s.navLink} href="#faq">FAQ</a>
            </nav>
            <div className={s.headerActions}>
              <Link className={s.navLink} href="/login">Sign in</Link>
              <Link className={`${s.btnWhite} ${s.sm}`} href="/signup">
                Get started
                <Arrow size={14} />
              </Link>
            </div>
          </header>

          <main className={s.heroRow}>
            <div className={s.heroCopy}>
              <span className={s.badge}>
                <span className={s.badgeDot} />
                Built on Stellar
              </span>
              <h1 className={s.h1}>Payment links that know the moment you&apos;re paid.</h1>
              <p className={s.lead}>
                Create a USDC request, share one link, and watch it flip to Paid with the transaction hash. Your money goes straight to
                your own wallet.
              </p>
              <div className={s.ctaRow}>
                <Link className={`${s.btnWhite} ${s.lg}`} href="/signup">
                  Create a payment link
                  <Arrow />
                </Link>
                <a className={`${s.btnGhost} ${s.lg}`} href="#how">See how it works</a>
              </div>
              <div className={s.heroFacts}>
                <span>Settles in about 5 seconds</span>
                <span>Non-custodial</span>
                <span>Works with any Stellar wallet</span>
              </div>
            </div>
            <HeroArt />
          </main>
        </div>
      </section>

      <section className={s.rails} aria-label="Built on open rails">
        <div className={`${s.wrap} ${s.railsRow}`}>
          <span className={s.railsLabel}>BUILT ON OPEN RAILS</span>
          <ul className={s.railsList}>
            <li>Stellar</li>
            <li>USDC</li>
            <li>Freighter</li>
            <li>SEP-7 QR</li>
            <li>Stellar Expert</li>
          </ul>
        </div>
      </section>

      <section id="how" className={s.section}>
        <div className={`${s.wrap} ${s.col48}`}>
          <div className={s.intro}>
            <span className={s.eyebrow}>How it works</span>
            <h2 className={s.h2}>From link to Paid in three steps.</h2>
            <p className={s.introP}>
              No card terminals, no chasing screenshots of bank transfers. PayLink watches Stellar for you and only marks a request Paid
              when the right money arrives.
            </p>
          </div>
          <div className={s.steps}>
            {STEPS_COPY.map((copy, i) => {
              const n = (i + 1) as 1 | 2 | 3;
              return (
                <div key={n} className={s.step}>
                  <span className={s.stepNo}>0{n}</span>
                  <StepArt step={n} />
                  <h3 className={s.h3}>{copy.title}</h3>
                  <p className={s.stepP}>{copy.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section id="features" className={`${s.section} ${s.tinted}`}>
        <div className={`${s.wrap} ${s.col48}`}>
          <div className={s.intro}>
            <span className={s.eyebrow}>Features</span>
            <h2 className={s.h2}>Built for the payments that actually happen.</h2>
            <p className={s.introP}>
              Customers forget memos, send a little short, or pay after the link expires. PayLink handles all of it, out loud.
            </p>
          </div>
          <div className={s.features}>
            {FEATURES.map((f) => (
              <div key={f.title} className={s.feature}>
                <span className={s.featureIcon}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d={f.icon} />
                  </svg>
                </span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className={`${s.sectionTall} ${s.dark}`}>
        <div className={`${s.wrap} ${s.col48}`}>
          <div className={s.darkHead}>
            <div className={s.intro}>
              <span className={`${s.eyebrow} ${s.eyebrowDark}`}>Dashboard</span>
              <h2 className={s.h2}>Your whole day of payments, on one screen.</h2>
            </div>
            <Link className={`${s.btnGhost} ${s.md}`} href="/dashboard">
              Explore the dashboard
              <Arrow />
            </Link>
          </div>
          <DashboardArt />
          <div className={s.points}>
            {DASH_POINTS.map((p) => (
              <div key={p.title} className={s.point}>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="developers" className={s.sectionTall}>
        <div className={`${s.wrap} ${s.devRow}`}>
          <div className={s.devCopy}>
            <span className={s.eyebrow}>Developers</span>
            <h2 className={s.h2sm}>One API call. A checkout your customers trust.</h2>
            <p className={s.introP}>
              Create requests from your own site or app and get a hosted checkout link back. Retries are safe with idempotency keys.
            </p>
            <ul className={s.checks}>
              <li><Check />REST API with idempotency keys</li>
              <li><Check />Live status stream for your own UI</li>
              <li><Check />Full OpenAPI reference</li>
            </ul>
            <div className={s.devLinks}>
              <Link className={s.arrowLink} href="/api-keys">
                Get an API key
                <Arrow />
              </Link>
              <a className={s.arrowLink} href={DOCS_URL}>
                Read the API reference
                <Arrow />
              </a>
            </div>
          </div>
          <CodeTabs />
        </div>
      </section>

      <section className={s.facts} aria-label="How payments settle">
        <div className={`${s.wrap} ${s.factsGrid}`}>
          {NETWORK_FACTS.map((f) => (
            <div key={f.figure} className={s.fact}>
              <strong>{f.figure}</strong>
              <span>{f.body}</span>
            </div>
          ))}
        </div>
      </section>

      <section id="faq" className={s.sectionTall}>
        <div className={`${s.wrapNarrow} ${s.faqCol}`}>
          <h2 className={`${s.h2sm} ${s.faqTitle}`}>Questions, answered</h2>
          <div className={s.faq}>
            {FAQS.map((f, i) => (
              <details key={f.q} name="landing-faq" open={i === 0} className={s.faqItem}>
                <summary className={s.faqQ}>
                  {f.q}
                  <span className={s.faqSign} aria-hidden="true" />
                </summary>
                <p className={s.faqA}>{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className={s.cta}>
        <div aria-hidden="true" className={s.ctaBg} />
        <div className={`${s.wrap} ${s.ctaRowWide}`}>
          <div className={s.ctaCopy}>
            <h2 className={s.ctaH2}>Start getting paid in USDC today.</h2>
            <p>No card, no setup fee. Your first link takes about five minutes.</p>
          </div>
          <div className={s.ctaRow}>
            <Link className={`${s.btnWhite} ${s.xl}`} href="/signup">Create your account</Link>
            <Link className={`${s.btnGhost} ${s.xl}`} href="/login">Sign in</Link>
          </div>
        </div>
      </section>

      <footer className={s.foot}>
        <div className={`${s.wrap} ${s.footCol}`}>
          <div className={s.footTop}>
            <div className={s.footBrand}>
              <span className={s.footLogo}>
                <LogoMark size={30} />
                PayLink
              </span>
              <p>Payment requests and verified checkout on Stellar.</p>
            </div>
            <nav aria-label="Footer" className={s.footLinks}>
              <div className={s.footGroup}>
                <h3>Product</h3>
                <ul>
                  <li><a href="#how">How it works</a></li>
                  <li><a href="#features">Features</a></li>
                  <li><Link href="/dashboard">Dashboard</Link></li>
                </ul>
              </div>
              <div className={s.footGroup}>
                <h3>Developers</h3>
                <ul>
                  <li><a href="#developers">API</a></li>
                  <li><a href={DOCS_URL}>API reference</a></li>
                  <li><Link href="/api-keys">API keys</Link></li>
                  <li><a href="https://status.stellar.org" target="_blank" rel="noreferrer">Stellar status</a></li>
                </ul>
              </div>
              <div className={s.footGroup}>
                <h3>Account</h3>
                <ul>
                  <li><Link href="/signup">Sign up</Link></li>
                  <li><Link href="/login">Sign in</Link></li>
                  <li><a href="#faq">FAQ</a></li>
                </ul>
              </div>
            </nav>
          </div>
          <div className={s.footBottom}>
            <span>© 2026 PayLink</span>
            <span>Currently in beta on Stellar Testnet</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
