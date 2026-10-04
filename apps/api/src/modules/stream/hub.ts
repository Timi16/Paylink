import type { PrismaClient } from "@prisma/client";
import type { CheckoutStatus } from "@paylink/shared";
import type { Logger } from "pino";
import {
  CHANNELS,
  type Channel,
  type PaymentDetectedPayload,
  type RequestUpdatedPayload,
  type WalletsChangedPayload,
} from "../../db/notify";
import { checkoutStatus, presentRequest, serializePayment } from "../requests/serialize";
import { serializeWallet } from "../wallets/service";

export type MerchantEvent = {
  type: "request.updated" | "payment.detected" | "wallet.updated";
  data: unknown;
};
type PublicListener = (status: CheckoutStatus) => void;
type MerchantListener = (event: MerchantEvent) => void;

function add<K, V>(map: Map<K, Set<V>>, key: K, value: V): () => void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
  return () => {
    set.delete(value);
    if (set.size === 0 && map.get(key) === set) map.delete(key);
  };
}

/**
 * Fans Postgres notifications out to SSE subscribers held in memory (single API instance).
 * A notification only carries ids; the hub reads the committed row and sends that, so
 * subscribers always get the database's truth.
 */
export class LiveHub {
  private readonly publicSubs = new Map<string, Set<PublicListener>>();
  private readonly merchantSubs = new Map<string, Set<MerchantListener>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
  ) {}

  subscribePublic(publicId: string, fn: PublicListener): () => void {
    return add(this.publicSubs, publicId, fn);
  }

  subscribeMerchant(merchantId: string, fn: MerchantListener): () => void {
    return add(this.merchantSubs, merchantId, fn);
  }

  handleNotification = (channel: Channel, payload: unknown): void => {
    this.dispatch(channel, payload).catch((err: unknown) =>
      this.logger.error({ err, channel }, "live hub: dispatch failed"),
    );
  };

  /** After the LISTEN connection reconnects: notifications may have been lost, so resend. */
  resync = (): void => {
    for (const publicId of this.publicSubs.keys()) {
      this.prisma.paymentRequest
        .findUnique({ where: { publicId } })
        .then((req) => {
          if (req) this.emitPublic(publicId, checkoutStatus(req));
        })
        .catch((err: unknown) => this.logger.warn({ err }, "live hub: resync failed"));
    }
  };

  private emitPublic(publicId: string, status: CheckoutStatus): void {
    for (const fn of this.publicSubs.get(publicId) ?? []) fn(status);
  }

  private emitMerchant(merchantId: string, event: MerchantEvent): void {
    for (const fn of this.merchantSubs.get(merchantId) ?? []) fn(event);
  }

  private async dispatch(channel: Channel, payload: unknown): Promise<void> {
    if (typeof payload !== "object" || payload === null) return;
    if (channel === CHANNELS.requestUpdated) {
      const p = payload as Partial<RequestUpdatedPayload>;
      if (!p.id || !p.publicId || !p.merchantId) return;
      if (!this.publicSubs.has(p.publicId) && !this.merchantSubs.has(p.merchantId)) return;
      const req = await this.prisma.paymentRequest.findUnique({ where: { id: p.id } });
      if (!req) return;
      this.emitPublic(req.publicId, checkoutStatus(req));
      this.emitMerchant(req.merchantId, { type: "request.updated", data: await presentRequest(this.prisma, req) });
    } else if (channel === CHANNELS.paymentDetected) {
      const p = payload as Partial<PaymentDetectedPayload>;
      if (!p.eventId || !p.merchantId || !this.merchantSubs.has(p.merchantId)) return;
      const payment = await this.prisma.chainPayment.findFirst({
        where: { eventId: p.eventId, wallet: { merchantId: p.merchantId } },
        include: { request: { select: { merchantId: true } } },
      });
      if (!payment) return;
      const own = !payment.request || payment.request.merchantId === p.merchantId;
      this.emitMerchant(p.merchantId, { type: "payment.detected", data: serializePayment(payment, { showRequestId: own }) });
    } else if (channel === CHANNELS.walletsChanged) {
      const p = payload as Partial<WalletsChangedPayload>;
      if (!p.walletId || !p.merchantId || !this.merchantSubs.has(p.merchantId)) return;
      const wallet = await this.prisma.wallet.findFirst({
        where: { id: p.walletId, merchantId: p.merchantId },
      });
      if (!wallet) return;
      this.emitMerchant(p.merchantId, {
        type: "wallet.updated",
        data: { ...serializeWallet(wallet), deleted: wallet.deletedAt !== null },
      });
    }
  }
}
