import { Router } from "express";
import { CreateApiKeyBody, IdParamsSchema } from "@paylink/shared";
import { authOf } from "../../middleware/auth";
import { parse } from "../../middleware/validate";
import { serializeApiKey, type ApiKeyService } from "./service";

/** Session-only: mounted behind sessionOnly. */
export function apiKeyRoutes(service: ApiKeyService): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const keys = await service.list(authOf(req).merchantId);
    res.json({ data: keys.map(serializeApiKey) });
  });

  router.post("/", async (req, res) => {
    const { name } = parse(CreateApiKeyBody, req.body);
    const { apiKey, key } = await service.create(authOf(req).merchantId, name);
    res.status(201).json({ apiKey: serializeApiKey(apiKey), key });
  });

  router.delete("/:id", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    await service.revoke(authOf(req).merchantId, id);
    res.status(204).end();
  });

  return router;
}
