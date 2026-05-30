import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { menuItemsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { invalidateFuseCache } from "../lib/fuzzy-match";
import {
  CreateMenuItemBody,
  CreateMenuItemParams,
  UpdateMenuItemBody,
  UpdateMenuItemParams,
  DeleteMenuItemParams,
  GetVendorMenuParams,
} from "@workspace/api-zod";
import { toMenuItem } from "../lib/serializers";

const router: IRouter = Router();

router.get("/vendors/:vendorId/menu", async (req, res) => {
  const params = GetVendorMenuParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });
  const rows = await db
    .select()
    .from(menuItemsTable)
    .where(eq(menuItemsTable.vendorId, params.data.vendorId))
    .orderBy(asc(menuItemsTable.category), asc(menuItemsTable.name));
  return res.json(rows.map(toMenuItem));
});

router.post("/vendors/:vendorId/menu", async (req, res) => {
  const params = CreateMenuItemParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });
  const body = CreateMenuItemBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_body", details: body.error.issues });
  const [created] = await db
    .insert(menuItemsTable)
    .values({
      vendorId: params.data.vendorId,
      name: body.data.name,
      description: body.data.description ?? null,
      price: body.data.price.toFixed(2),
      category: body.data.category ?? null,
      available: body.data.available ?? true,
    })
    .returning();
  // Invalidate fuzzy match cache for this vendor
  invalidateFuseCache(params.data.vendorId);
  return res.status(201).json(toMenuItem(created!));
});

router.patch("/menu/:itemId", async (req, res) => {
  const params = UpdateMenuItemParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });
  const body = UpdateMenuItemBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_body", details: body.error.issues });

  const updates: Record<string, unknown> = {};
  if (body.data.name !== undefined) updates.name = body.data.name;
  if (body.data.description !== undefined) updates.description = body.data.description;
  if (body.data.price !== undefined) updates.price = body.data.price.toFixed(2);
  if (body.data.category !== undefined) updates.category = body.data.category;
  if (body.data.available !== undefined) updates.available = body.data.available;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "no_fields" });
  }
  const [updated] = await db
    .update(menuItemsTable)
    .set(updates)
    .where(eq(menuItemsTable.id, params.data.itemId))
    .returning();
  if (!updated) return res.status(404).json({ error: "not_found" });
  // Invalidate fuzzy match cache for this vendor
  invalidateFuseCache(updated.vendorId);
  return res.json(toMenuItem(updated));
});

router.delete("/menu/:itemId", async (req, res) => {
  const params = DeleteMenuItemParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });
  // Fetch the item to get vendorId before deleting
  const [item] = await db
    .select()
    .from(menuItemsTable)
    .where(eq(menuItemsTable.id, params.data.itemId));
  await db.delete(menuItemsTable).where(eq(menuItemsTable.id, params.data.itemId));
  // Invalidate fuzzy match cache if item existed
  if (item) invalidateFuseCache(item.vendorId);
  return res.status(204).end();
});

export default router;
