import type { AssetCode } from "@paylink/shared";
import { env } from "../config/env";

export interface AssetRef {
  code: string;
  /** null = native XLM */
  issuer: string | null;
}

/** The only assets a request can ask for, with the issuer PayLink trusts for each. */
export function resolveAsset(code: AssetCode): AssetRef {
  return code === "XLM" ? { code: "XLM", issuer: null } : { code: "USDC", issuer: env.USDC_ISSUER };
}
