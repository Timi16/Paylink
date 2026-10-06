"use client";

import { useState } from "react";

interface Props {
  value: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
}

/** Copies `value` and confirms in place for two seconds. */
export function CopyButton({ value, label = "Copy", copiedLabel = "Copied", className = "btn btn-secondary btn-sm", style, ariaLabel }: Props) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API unavailable (insecure context): fall back to a hidden textarea.
      const area = document.createElement("textarea");
      area.value = value;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button type="button" onClick={copy} className={className} style={style} aria-label={ariaLabel} aria-live="polite">
      {copied ? copiedLabel : label}
    </button>
  );
}
