import { ICON_PATHS, type IconName } from "@/lib/status";

const EXTRA = {
  plus: "M12 5v14M5 12h14",
  overview: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  requests: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  payments: "M4 8h15l-3-3M20 16H5l3 3",
  unmatched: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 8v5M12 16v.01",
  wallets: "M5 6h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM3 10h18M16 14.5h2",
  keys: "M8 11a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM11 12l8-8M16 7l2 2",
  settings: "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11",
  mail: "M4 6h16v12H4zM4 7l8 6 8-6",
  copy: "M9 9h10v10H9zM5 15V5h10",
  external: "M14 5h5v5M19 5l-8 8M11 7H6v11h11v-5",
  back: "M15 6l-6 6 6 6",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM16.5 16.5L21 21",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
  shield: "M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z",
  qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2",
} as const;

export type AnyIcon = IconName | keyof typeof EXTRA;

const PATHS: Record<AnyIcon, string> = { ...ICON_PATHS, ...EXTRA };

interface IconProps {
  name: AnyIcon;
  size?: number;
  strokeWidth?: number;
  style?: React.CSSProperties;
}

/** Inline stroke icon, coloured by the surrounding text. Decorative: pair it with a label. */
export function Icon({ name, size = 18, strokeWidth = 2, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, ...style }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
