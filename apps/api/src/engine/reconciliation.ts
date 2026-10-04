import type { Ingestion } from "./ingestion";

export const RECONCILE_INTERVAL_MS = 120_000;

/** Every 2 minutes: re-scan the last 60 processed ledgers for anything that was missed. */
export function reconcile(ingestion: Ingestion): Promise<number> {
  return ingestion.reconcile();
}
