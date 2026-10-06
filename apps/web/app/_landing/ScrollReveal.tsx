"use client";

import { useEffect } from "react";

/**
 * Reveals the landing page's blocks as they scroll into view. Only elements that start below
 * the fold are hidden (so nothing visible ever blinks), siblings are staggered, and with
 * reduced motion or no IntersectionObserver everything simply stays visible.
 */
export function ScrollReveal({ targets }: { targets: (string | undefined)[] }) {
  useEffect(() => {
    if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const elements = targets.flatMap((cls) => (cls ? [...document.querySelectorAll<HTMLElement>(`.${CSS.escape(cls)}`)] : []));
    const pending = elements.filter((el) => el.getBoundingClientRect().top > window.innerHeight * 0.92);
    for (const el of pending) {
      const index = el.parentElement ? [...el.parentElement.children].indexOf(el) : 0;
      el.style.setProperty("--reveal-delay", `${Math.min(index, 5) * 80}ms`);
      el.dataset.reveal = "pending";
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.reveal = "in";
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    for (const el of pending) observer.observe(el);
    return () => {
      observer.disconnect();
      for (const el of pending) delete el.dataset.reveal;
    };
  }, [targets]);
  return null;
}
