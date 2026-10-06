"use client";

import { useEffect, useId, useRef } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** Buttons, right-aligned. */
  footer?: React.ReactNode;
  width?: number;
}

/** Modal dialog on the native <dialog>: focus is trapped and Escape closes it. */
export function Dialog({ open, onClose, title, children, footer, width = 460 }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on the backdrop
      }}
      style={{ width: "calc(100% - 32px)", maxWidth: width, border: "1px solid var(--border)", borderRadius: 18, padding: 0, color: "var(--ink)", background: "var(--surface)" }}
    >
      {open ? (
        <div style={{ padding: 28, display: "flex", flexDirection: "column", gap: 16 }}>
          <h2 id={titleId} style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em" }}>
            {title}
          </h2>
          {children}
          {footer ? <div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 10, marginTop: 4 }}>{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
