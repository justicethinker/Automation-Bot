import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  vendorsTable,
  menuItemsTable,
  ordersTable,
  customersTable,
  conversationsTable,
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
      })
      .returning();
    res.status(201).json(toVendor(created!));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "unknown_error";
    if (message.includes("duplicate") || message.includes("unique")) {
      return res.status(409).json({ error: "phone_already_used" });
    }
    req.log.error({ err }, "Failed to create vendor");
    res.status(500).json({ error: "internal_error" });
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

  res.json({
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
    "bankName",
    "bankAccountNumber",
    "bankAccountHolder",
    "currency",
    "welcomeMessage",
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
  res.json(toVendor(updated));
});

router.delete("/vendors/:vendorId", async (req, res) => {
  const params = DeleteVendorParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });
  await db.delete(vendorsTable).where(eq(vendorsTable.id, params.data.vendorId));
  res.status(204).end();
});

export default router;
