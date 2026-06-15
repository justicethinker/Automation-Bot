import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { promotionsTable, vendorsTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import {
  CreateVendorPromotionBody,
  UpdateVendorPromotionBody,
  ListVendorPromotionsParams,
  CreateVendorPromotionParams,
  UpdateVendorPromotionParams,
  DeleteVendorPromotionParams,
} from "@workspace/api-zod";
import { toPromotion } from "../lib/serializers";
import { hasFeature } from "../lib/plans";

const router: IRouter = Router();

router.get("/vendors/:vendorId/promotions", async (req, res) => {
  const params = ListVendorPromotionsParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });

  // Promotions are a Pro-only feature
  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.id, params.data.vendorId))
    .limit(1);
  if (!vendor) return res.status(404).json({ error: "vendor_not_found" });
  if (!hasFeature(vendor, "promotions")) {
    return res.status(403).json({ error: "pro_feature", message: "Promotions requires a Pro plan." });
  }
  const rows = await db
    .select()
    .from(promotionsTable)
    .where(eq(promotionsTable.vendorId, params.data.vendorId))
    .orderBy(desc(promotionsTable.createdAt));
  return res.json(rows.map(toPromotion));
});

router.post("/vendors/:vendorId/promotions", async (req, res) => {
  const params = CreateVendorPromotionParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });
  const body = CreateVendorPromotionBody.safeParse(req.body);
  if (!body.success) {
    return res
      .status(400)
      .json({ error: "invalid_body", details: body.error.issues });
  }

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.id, params.data.vendorId))
    .limit(1);
  if (!vendor) return res.status(404).json({ error: "vendor_not_found" });
  if (!hasFeature(vendor, "promotions")) {
    return res.status(403).json({ error: "pro_feature" });
  }

  const [created] = await db
    .insert(promotionsTable)
    .values({
      vendorId: vendor.id,
      title: body.data.title,
      description: body.data.description ?? null,
      active: body.data.active ?? true,
    })
    .returning();
  return res.status(201).json(toPromotion(created!));
});

router.patch("/vendors/:vendorId/promotions/:promotionId", async (req, res) => {
  const params = UpdateVendorPromotionParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });
  const body = UpdateVendorPromotionBody.safeParse(req.body);
  if (!body.success) {
    return res
      .status(400)
      .json({ error: "invalid_body", details: body.error.issues });
  }
  const updates: Record<string, unknown> = {};
  if (body.data.title !== undefined) updates.title = body.data.title;
  if (body.data.description !== undefined)
    updates.description = body.data.description;
  if (body.data.active !== undefined) updates.active = body.data.active;
  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: "no_fields" });

  const [updated] = await db
    .update(promotionsTable)
    .set(updates)
    .where(
      and(
        eq(promotionsTable.id, params.data.promotionId),
        eq(promotionsTable.vendorId, params.data.vendorId),
      ),
    )
    .returning();
  if (!updated) return res.status(404).json({ error: "not_found" });
  return res.json(toPromotion(updated));
});

router.delete(
  "/vendors/:vendorId/promotions/:promotionId",
  async (req, res) => {
    const params = DeleteVendorPromotionParams.safeParse(req.params);
    if (!params.success)
      return res.status(400).json({ error: "invalid_params" });
    await db
      .delete(promotionsTable)
      .where(
        and(
          eq(promotionsTable.id, params.data.promotionId),
          eq(promotionsTable.vendorId, params.data.vendorId),
        ),
      );
    return res.status(204).end();
  },
);

export default router;
