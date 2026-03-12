import { Router, type Request, type Response, type NextFunction } from "express";
import { ALLOWED_ASSETS } from "../config/assets";

const router = Router();

/**
 * Handles GET /api/assets and returns the list of allowed trading assets.
 * This exposes ALLOWED_ASSETS in an array format suitable for frontend dropdowns.
 *
 * @param _req - The incoming HTTP request (unused for this endpoint).
 * @param res - The HTTP response used to send the asset list.
 * @param _next - Express next function (unused; included for consistency).
 */
async function handleGetAssets(
  _req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  const assets = Object.entries(ALLOWED_ASSETS).map(([key, value]) => ({
    key,
    lotSize: value.lotSize,
    basePrice: value.basePrice,
    expiryDay: value.expiryDay,
  }));

  res.json(assets);
}

router.get("/", handleGetAssets);

export default router;

