import { z } from "zod";

const Email = z.string().trim().toLowerCase().email().max(254);
// Upper bound keeps argon2 from being used as a CPU-exhaustion vector.
const NewPassword = z.string().min(10, "Password must be at least 10 characters").max(200);

export const SignupBody = z
  .object({
    email: Email,
    password: NewPassword,
    businessName: z.string().trim().min(1).max(100),
  })
  .strict();
export type SignupBody = z.infer<typeof SignupBody>;

export const LoginBody = z
  .object({ email: Email, password: z.string().min(1).max(200) })
  .strict();
export type LoginBody = z.infer<typeof LoginBody>;

export const ChangePasswordBody = z
  .object({ currentPassword: z.string().min(1).max(200), newPassword: NewPassword })
  .strict();
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;

export const MerchantSchema = z.object({
  id: z.string(),
  email: z.string(),
  businessName: z.string(),
  createdAt: z.string(),
});
export type Merchant = z.infer<typeof MerchantSchema>;
export const MerchantResponse = z.object({ merchant: MerchantSchema });
