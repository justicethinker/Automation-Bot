import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  vendorsTable,
  menuItemsTable,
  ordersTable,
  customersTable,
  conversationsTable,
  vendorAdminsTable,
} from "@workspace/db";
import { and, eq, inArray, sql, desc } from "drizzle-orm";
import {
  CreateVendorBody,
  GetVendorParams,
  UpdateVendorBody,
  UpdateVendorParams,
  DeleteVendorParams,
} from "@workspace/api-zod";
import { toVendor } from "../lib/serializers";

const router: IRouter = Router();

router.get("/vendors", async (_req, res) => {
  const rows = await db.select().from(vendorsTable).orderBy(desc(vendorsTable.createdAt));
  res.json(rows.map(toVendor));
});

router.post("/vendors", async (req, res) => {
  const parsed = CreateVendorBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", details: parsed.error.issues });
  }
  const data = parsed.data;
  try {
    const [created] = await db
      .insert(vendorsTable)
      .values({
        name: data.name,
        phoneNumber: data.phoneNumber,
        adminNumber: data.adminNumber ?? null,
        phoneNumberId: data.phoneNumberId ?? null,
        botNumber: data.botNumber ?? null,
        plan: data.plan,
        currency: data.currency ?? "USD",
        bankName: data.bankName ?? null,
        bankAccountNumber: data.bankAccountNumber ?? null,
        bankAccountHolder: data.bankAccountHolder ?? null,
        welcomeMessage: data.welcomeMessage ?? null,
        requiresDeliveryAddress: data.requiresDeliveryAddress ?? false,
      })
      .returning();
    return res.status(201).json(toVendor(created!));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "unknown_error";
    if (message.includes("duplicate") || message.includes("unique")) {
      return res.status(409).json({ error: "phone_already_used" });
    }
    req.log.error({ err }, "Failed to create vendor");
    return res.status(500).json({ error: "internal_error" });
  }
});

router.get("/vendors/:vendorId", async (req, res) => {
  const params = GetVendorParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });
  const vendor = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.id, params.data.vendorId))
    .limit(1);
  if (!vendor[0]) return res.status(404).json({ error: "not_found" });

  const v = vendor[0];

  const orderStats = await db
    .select({
      status: ordersTable.status,
      count: sql<number>`count(*)::int`,
      revenue: sql<number>`coalesce(sum(${ordersTable.total})::float, 0)`,
    })
    .from(ordersTable)
    .where(eq(ordersTable.vendorId, v.id))
    .groupBy(ordersTable.status);

  let totalOrders = 0;
  let pendingOrders = 0;
  let confirmedOrders = 0;
  let paidOrders = 0;
  let revenue = 0;
  for (const r of orderStats) {
    totalOrders += Number(r.count);
    if (r.status === "pending") pendingOrders = Number(r.count);
    if (r.status === "confirmed") confirmedOrders = Number(r.count);
    if (r.status === "paid" || r.status === "completed") {
      paidOrders += Number(r.count);
      revenue += Number(r.revenue);
    }
  }

  const [{ menuItems }] = await db
    .select({ menuItems: sql<number>`count(*)::int` })
    .from(menuItemsTable)
    .where(eq(menuItemsTable.vendorId, v.id));

  const [{ customers }] = await db
    .select({ customers: sql<number>`count(*)::int` })
    .from(customersTable)
    .where(eq(customersTable.vendorId, v.id));

  const [{ openConversations }] = await db
    .select({ openConversations: sql<number>`count(*)::int` })
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.vendorId, v.id),
        inArray(conversationsTable.status, ["bot", "human"]),
      ),
    );

  return res.json({
    ...toVendor(v),
    stats: {
      totalOrders,
      pendingOrders,
      confirmedOrders,
      paidOrders,
      revenue,
      menuItems: Number(menuItems),
      customers: Number(customers),
      openConversations: Number(openConversations),
    },
  });
});

router.patch("/vendors/:vendorId", async (req, res) => {
  const params = UpdateVendorParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });
  const body = UpdateVendorBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_body", details: body.error.issues });

  const updates: Record<string, unknown> = {};
  for (const k of [
    "name",
    "phoneNumber",
    "adminNumber",
    "phoneNumberId",
    "botNumber",
    "plan",
    "botEnabled",
    "followUpsEnabled",
    "bankName",
    "bankAccountNumber",
    "bankAccountHolder",
    "currency",
    "welcomeMessage",
    "requiresDeliveryAddress",
  ] as const) {
    if (body.data[k] !== undefined) updates[k] = body.data[k];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "no_fields" });
  }
  const [updated] = await db
    .update(vendorsTable)
    .set(updates)
    .where(eq(vendorsTable.id, params.data.vendorId))
    .returning();
  if (!updated) return res.status(404).json({ error: "not_found" });
  return res.json(toVendor(updated));
});

router.delete("/vendors/:vendorId", async (req, res) => {
  const params = DeleteVendorParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });
  await db.delete(vendorsTable).where(eq(vendorsTable.id, params.data.vendorId));
  return res.status(204).end();
});

const VendorAdminBody = z.object({
  phone: z.string().min(6),
  name: z.string().optional(),
  role: z.enum(["owner", "staff"]).optional(),
});

router.get("/vendors/:vendorId/admins", async (req, res) => {
  const params = GetVendorParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });
  const admins = await db
    .select()
    .from(vendorAdminsTable)
    .where(eq(vendorAdminsTable.vendorId, params.data.vendorId));
  return res.json(admins.map((admin) => ({
    id: admin.id,
    vendorId: admin.vendorId,
    phone: admin.phone,
    name: admin.name,
    role: admin.role,
    createdAt: admin.createdAt.toISOString(),
  })));
});

router.post("/vendors/:vendorId/admins", async (req, res) => {
  const params = GetVendorParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });
  const bodyResult = VendorAdminBody.safeParse(req.body);
  if (!bodyResult.success) return res.status(400).json({ error: "invalid_body", details: bodyResult.error.issues });

  const [created] = await db
    .insert(vendorAdminsTable)
    .values({
      vendorId: params.data.vendorId,
      phone: bodyResult.data.phone,
      name: bodyResult.data.name ?? null,
      role: bodyResult.data.role ?? "staff",
    })
    .returning();

  return res.status(201).json({
    id: created!.id,
    vendorId: created!.vendorId,
    phone: created!.phone,
    name: created!.name,
    role: created!.role,
    createdAt: created!.createdAt.toISOString(),
  });
});

router.delete("/vendors/:vendorId/admins/:adminId", async (req, res) => {
  const params = z.object({
    vendorId: z.string(),
    adminId: z.string(),
  }).safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });

  await db
    .delete(vendorAdminsTable)
    .where(
      and(
        eq(vendorAdminsTable.vendorId, params.data.vendorId),
        eq(vendorAdminsTable.id, params.data.adminId),
      ),
    );
  return res.status(204).end();
});

export default router;
