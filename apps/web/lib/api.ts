import type { ErrorCode } from "@paylink/shared";
import { API_URL } from "./config";

/** An error answered by the API in the shared shape, or a network failure (code "NETWORK"). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "NETWORK",
    message: string,
    readonly details: { path?: string; message?: string }[] = [],
    /** Seconds, from Retry-After. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The message for one form field, from validation details. */
  field(path: string): string | undefined {
    return this.details.find((d) => d.path === path)?.message;
  }
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      // The session is an httpOnly cookie on the API's origin. Public checkout routes are
      // open to any origin and take no cookie; browsers refuse credentials against them.
      credentials: path.startsWith("/public/") ? "omit" : "include",
      headers: { ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...opts.headers },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Can't reach PayLink right now. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // fall through: handled as an unexpected response below
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: ErrorCode; message?: string; details?: ApiError["details"] } } | null)?.error;
    const retry = res.headers.get("Retry-After");
    throw new ApiError(
      res.status,
      err?.code ?? "INTERNAL",
      err?.message ?? "Something went wrong. Try again.",
      err?.details ?? [],
      retry ? Number.parseInt(retry, 10) : null,
    );
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("POST", path, { ...opts, body }),
  delete: <T = void>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, opts),
};

/** SWR fetcher: the key is the API path. */
export const fetcher = <T>(path: string) => api.get<T>(path);

/** Query string from an object, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : "";
}

/** Plain-language message for an error from the API. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "RATE_LIMITED") {
      return err.retryAfter ? `Too many attempts. Try again in ${waitText(err.retryAfter)}.` : "Too many attempts. Try again shortly.";
    }
    return err.message;
  }
  return "Something went wrong. Try again.";
}

function waitText(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
