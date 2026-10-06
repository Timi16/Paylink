"use client";

import { useRouter } from "next/navigation";
import useSWR, { SWRConfig, useSWRConfig } from "swr";
import { ToastProvider } from "@/components/Toast";
import { api, ApiError, fetcher } from "./api";
import type { Merchant, Page, ChainPayment, Wallet } from "./types";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        fetcher,
        revalidateOnFocus: true,
        shouldRetryOnError: (err: unknown) => !(err instanceof ApiError) || err.status >= 500 || err.status === 0,
        errorRetryCount: 3,
      }}
    >
      <ToastProvider>{children}</ToastProvider>
    </SWRConfig>
  );
}

/** The signed-in merchant. `merchant` is null once we know nobody is signed in. */
export function useMe() {
  const { data, error, isLoading, mutate } = useSWR<{ merchant: Merchant }>("/auth/me", { shouldRetryOnError: false });
  const signedOut = error instanceof ApiError && error.status === 401;
  return {
    merchant: data?.merchant ?? (signedOut ? null : undefined),
    isLoading,
    /** A failure that is not "signed out": the API is unreachable or erroring. */
    error: error && !signedOut ? (error as ApiError) : null,
    mutate,
  };
}

export function useWallets() {
  return useSWR<{ data: Wallet[] }>("/v1/wallets");
}

export function useUnmatchedCount(): number | null {
  const { data } = useSWR<Page<ChainPayment>>("/v1/payments?unmatched=true&limit=100");
  return data ? data.data.length : null;
}

export function useLogout() {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  return async () => {
    await api.post("/auth/logout").catch(() => undefined);
    // Drop every cached response: the next visitor on this browser must see none of it.
    await mutate(() => true, undefined, { revalidate: false });
    router.replace("/login");
  };
}
