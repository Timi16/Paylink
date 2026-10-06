"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { AppShell } from "@/components/AppShell";
import { LiveProvider } from "@/lib/live";
import { Providers, useMe } from "@/lib/session";

function Guard({ children }: { children: React.ReactNode }) {
  const { merchant, error, mutate } = useMe();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (merchant === null) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [merchant, pathname, router]);

  if (error) {
    return (
      <div className="empty" style={{ minHeight: "100vh", justifyContent: "center" }}>
        <strong>We can&apos;t reach PayLink right now</strong>
        <span>Your data is safe. Check your connection and try again.</span>
        <button type="button" className="btn btn-primary" onClick={() => mutate()} style={{ marginTop: 8 }}>
          Try again
        </button>
      </div>
    );
  }
  if (!merchant) return <div style={{ minHeight: "100vh" }} aria-busy="true" />;
  return (
    <LiveProvider>
      <AppShell merchant={merchant}>{children}</AppShell>
    </LiveProvider>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <Guard>{children}</Guard>
    </Providers>
  );
}
