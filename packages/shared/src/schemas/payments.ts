import { z } from "zod";
import { IdSchema, PaginationQuery, PAYMENT_OUTCOMES } from "./common";
import { PaymentSchema, RequestSchema } from "./requests";

export const ListPaymentsQuery = z
  .object({
    walletId: IdSchema.optional(),
    outcome: z.enum(PAYMENT_OUTCOMES).optional(),
    unmatched: z.enum(["true", "false"]).optional(),
    /** Ledger close time range. */
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    ...PaginationQuery,
  })
  .strict();
export type ListPaymentsQuery = z.infer<typeof ListPaymentsQuery>;

export const EventIdParamsSchema = z
  .object({ eventId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_:.-]+$/, "Invalid event id") })
  .strict();

export const AssignPaymentBody = z.object({ requestId: IdSchema }).strict();
export type AssignPaymentBody = z.infer<typeof AssignPaymentBody>;

export const PaymentListResponse = z.object({
  data: z.array(PaymentSchema),
  nextCursor: z.string().nullable(),
});
export const PaymentResponse = z.object({ payment: PaymentSchema });
export const AssignResponse = z.object({ payment: PaymentSchema, request: RequestSchema });
