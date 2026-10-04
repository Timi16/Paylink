import { z } from "zod";

export const CreateApiKeyBody = z.object({ name: z.string().trim().min(1).max(64) }).strict();
export type CreateApiKeyBody = z.infer<typeof CreateApiKeyBody>;

export const ApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;
export const ApiKeyListResponse = z.object({ data: z.array(ApiKeySchema) });
export const ApiKeyCreatedResponse = z.object({ apiKey: ApiKeySchema, key: z.string() });
