import Link from "next/link";

interface MarkProps {
  size?: number;
  /** Background of the rounded square. */
  fill?: string;
  /** Colour of the check (matches the background on brand marks). */
  check?: string;
}

/** The PayLink mark: a receipt with a check. */
export function LogoMark({ size = 32, fill = "#0F766E", check = "#0F766E" }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill={fill} />
      <path d="M20 18Q20 14 24 14H40Q44 14 44 18V50L40 46L36 50L32 46L28 50L24 46L20 50Z" fill="#FFFFFF" />
      <path d="M26 31L30.5 35.5L38 27" fill="none" stroke={check} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface LogoProps {
  href?: string;
  size?: number;
  fontSize?: number;
  /** "light" = on a light surface; "dark" = on the night hero. */
  on?: "light" | "dark";
  style?: React.CSSProperties;
}

export function Logo({ href = "/", size = 32, fontSize = 19, on = "light", style }: LogoProps) {
  const dark = on === "dark";
  return (
    <Link
      href={href}
      aria-label="PayLink home"
      style={{ display: "flex", alignItems: "center", gap: 10, color: dark ? "#FFFFFF" : "var(--ink)", textDecoration: "none", ...style }}
    >
      <LogoMark size={size} fill={dark ? "#14B8A6" : "#0F766E"} />
      <span style={{ fontSize, fontWeight: 800, letterSpacing: "-0.02em" }}>
        Pay<span style={{ color: dark ? "#5EEAD4" : "var(--teal)" }}>Link</span>
      </span>
    </Link>
  );
}
