import { Router } from "express";
import { AddWalletBody, IdParamsSchema, VerifyWalletBody } from "@paylink/shared";
import { authOf } from "../../middleware/auth";
import { parse } from "../../middleware/validate";
import { serializeWallet, type WalletService } from "./service";

/** Session-only: mounted behind sessionOnly. */
export function walletRoutes(service: WalletService): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const wallets = await service.list(authOf(req).merchantId);
    res.json({ data: wallets.map(serializeWallet) });
  });

  router.post("/", async (req, res) => {
    const body = parse(AddWalletBody, req.body);
    const wallet = await service.add(authOf(req).merchantId, body);
    res.status(201).json({ wallet: serializeWallet(wallet) });
  });

  router.post("/:id/refresh", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    const wallet = await service.refresh(authOf(req).merchantId, id);
    res.json({ wallet: serializeWallet(wallet) });
  });

  router.post("/:id/challenge", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json(await service.createChallenge(authOf(req).merchantId, id));
  });

  router.post("/:id/verify", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    const body = parse(VerifyWalletBody, req.body);
    const wallet = await service.verify(authOf(req).merchantId, id, body);
    res.json({ wallet: serializeWallet(wallet) });
  });

  router.delete("/:id", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    await service.remove(authOf(req).merchantId, id);
    res.status(204).end();
  });

  return router;
}
