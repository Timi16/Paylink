// The API's shapes, straight from the shared package, plus the few list/summary envelopes.
import type { ChainPayment, PaymentRequest, RequestEvent } from "@paylink/shared";

export type {
  ApiKey,
  ChainPayment,
  ChallengeResponse,
  Checkout,
  CheckoutStatus,
  Merchant,
  PaymentOutcome,
  PaymentRequest,
  RequestEvent,
  RequestStats,
  RequestStatus,
  Session,
  Summary,
  Trustline,
  Wallet,
} from "@paylink/shared";

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface RequestDetail {
  request: PaymentRequest;
  payments: ChainPayment[];
  events: RequestEvent[];
}

export interface AssetRef {
  code: string;
  issuer: string | null;
}

export interface AssetAmount {
  asset: AssetRef;
  amount: string;
  amountStroops: string;
}
