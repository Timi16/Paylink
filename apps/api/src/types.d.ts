import type { AuthContext } from "./middleware/auth";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
      idempotencyKey?: string;
    }
  }
}
export {};
