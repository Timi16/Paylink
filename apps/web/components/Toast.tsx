"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type Show = (message: string) => void;
const ToastContext = createContext<Show>(() => undefined);

/** One short confirmation at the bottom of the screen, gone after four seconds. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback<Show>((text) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(text);
    timer.current = setTimeout(() => setMessage(null), 4000);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" role="status" style={{ position: "fixed", left: 0, right: 0, bottom: 24, display: "flex", justifyContent: "center", pointerEvents: "none", zIndex: 50 }}>
        {message ? (
          <div key={message} className="toast" style={{ background: "var(--ink)", color: "#FFFFFF", padding: "12px 18px", borderRadius: 12, fontSize: 14, fontWeight: 600, maxWidth: "calc(100% - 32px)", boxShadow: "0 10px 30px rgba(15,23,42,0.25)" }}>
            {message}
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
