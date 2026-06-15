import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  vendorsTable,
  ordersTable,
  conversationsTable,
  messagesTable,
  paymentsTable,
  customersTable,
} from "@workspace/db";
import { and, eq, gte, sql, inArray, desc } from "drizzle-orm";
import { GetVendorAnalyticsParams } from "@workspace/api-zod";
import { hasFeature } from "../lib/plans";

const router: IRouter = Router();

// NOTE: This is a platform-admin endpoint. Access is gated by the global API_SECRET_KEY.
// It intentionally returns cross-vendor aggregate data for the platform operator.
router.get("/dashboard/summary", async (_req, res) => {
  const vendors = await db.select().from(vendorsTable);
  const totalVendors = vendors.length;
  const starterVendors = vendors.filter((v) => v.plan === "starter").length;
  const proVendors = vendors.filter((v) => v.plan === "pro").length;

  const orderRows = await db
    .select({
      status: ordersTable.status,
      count: sql<number>`count(*)::int`,
      revenue: sql<number>`coalesce(sum(${ordersTable.total})::float, 0)`,
    })
    .from(ordersTable)
    .groupBy(ordersTable.status);

  let totalOrders = 0;
  let pendingOrders = 0;
  let revenue = 0;
  const ordersByStatus: { status: string; count: number }[] = [];
  for (const r of orderRows) {
    totalOrders += Number(r.count);
    ordersByStatus.push({ status: r.status, count: Number(r.count) });
    if (r.status === "pending") pendingOrders = Number(r.count);
    if (r.status === "paid" || r.status === "completed") revenue += Number(r.revenue);
  }

  const [{ openConversations }] = await db
    .select({ openConversations: sql<number>`count(*)::int` })
    .from(conversationsTable)
    .where(inArray(conversationsTable.status, ["bot", "human"]));

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [{ messagesToday }] = await db
    .select({ messagesToday: sql<number>`count(*)::int` })
    .from(messagesTable)
    .where(gte(messagesTable.createdAt, todayStart));

  const revenueByVendorRows = await db
    .select({
      vendorId: ordersTable.vendorId,
      vendorName: vendorsTable.name,
      revenue: sql<number>`coalesce(sum(${ordersTable.total})::float, 0)`,
    })
    .from(ordersTable)
    .innerJoin(vendorsTable, eq(vendorsTable.id, ordersTable.vendorId))
    .where(inArray(ordersTable.status, ["paid", "completed"]))
    .groupBy(ordersTable.vendorId, vendorsTable.name)
    .orderBy(desc(sql`coalesce(sum(${ordersTable.total})::float, 0)`))
    .limit(8);

  res.json({
    totalVendors,
    starterVendors,
    proVendors,
    totalOrders,
    pendingOrders,
    revenue,
    openConversations: Number(openConversations),
    messagesToday: Number(messagesToday),
    ordersByStatus,
    revenueByVendor: revenueByVendorRows.map((r) => ({
      vendorId: r.vendorId,
      vendorName: r.vendorName,
      revenue: Number(r.revenue),
    })),
  });
});

router.get("/dashboard/activity", async (_req, res) => {
  // Combine recent orders, payments, and handovers. Keep it cheap.
  const recentOrders = await db
    .select({
      id: ordersTable.id,
      vendorName: vendorsTable.name,
      customerName: ordersTable.customerName,
      status: ordersTable.status,
      createdAt: ordersTable.createdAt,
      total: ordersTable.total,
      currency: ordersTable.currency,
    })
    .from(ordersTable)
    .innerJoin(vendorsTable, eq(vendorsTable.id, ordersTable.vendorId))
    .orderBy(desc(ordersTable.createdAt))
    .limit(10);

  const recentPayments = await db
    .select({
      id: paymentsTable.id,
      vendorName: vendorsTable.name,
      customerName: paymentsTable.customerName,
      amount: paymentsTable.amount,
      currency: paymentsTable.currency,
      createdAt: paymentsTable.createdAt,
    })
    .from(paymentsTable)
    .innerJoin(vendorsTable, eq(vendorsTable.id, paymentsTable.vendorId))
    .orderBy(desc(paymentsTable.createdAt))
    .limit(5);

  const recentHandovers = await db
    .select({
      id: conversationsTable.id,
      vendorName: vendorsTable.name,
      customerName: conversationsTable.customerName,
      lastMessageAt: conversationsTable.lastMessageAt,
    })
    .from(conversationsTable)
    .innerJoin(vendorsTable, eq(vendorsTable.id, conversationsTable.vendorId))
    .where(eq(conversationsTable.status, "human"))
    .orderBy(desc(conversationsTable.lastMessageAt))
    .limit(5);

  type Item = {
    id: string;
    type: string;
    description: string;
    vendorName: string;
    createdAt: string;
  };
  const items: Item[] = [];
  for (const o of recentOrders) {
    items.push({
      id: `o-${o.id}`,
      type: "order",
      description: `${o.customerName} placed an order (${o.status})`,
      vendorName: o.vendorName,
      createdAt: o.createdAt.toISOString(),
    });
  }
  for (const p of recentPayments) {
    items.push({
      id: `p-${p.id}`,
      type: "payment",
      description: `${p.customerName} paid ${p.currency} ${Number(p.amount).toFixed(2)}`,
      vendorName: p.vendorName,
      createdAt: p.createdAt.toISOString(),
    });
  }
  for (const h of recentHandovers) {
    items.push({
      id: `h-${h.id}`,
      type: "handover",
      description: `${h.customerName} requested a human agent`,
      vendorName: h.vendorName,
      createdAt: h.lastMessageAt.toISOString(),
    });
  }
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return res.json(items.slice(0, 12));
});

router.get("/vendors/:vendorId/analytics", async (req, res) => {
  const params = GetVendorAnalyticsParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });

  // Analytics is a Pro-only feature
  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.id, params.data.vendorId))
    .limit(1);
  if (!vendor) return res.status(404).json({ error: "vendor_not_found" });
  if (!hasFeature(vendor, "analytics")) {
    return res.status(403).json({ error: "pro_feature", message: "Analytics requires a Pro plan." });
  }

  const since = new Date();
  since.setDate(since.getDate() - 13);
  since.setHours(0, 0, 0, 0);

  const dailyRows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${ordersTable.createdAt}), 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
      revenue: sql<number>`coalesce(sum(case when ${ordersTable.status} in ('paid','completed') then ${ordersTable.total} else 0 end)::float, 0)`,
    })
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.vendorId, params.data.vendorId),
        gte(ordersTable.createdAt, since),
      ),
    )
    .groupBy(sql`date_trunc('day', ${ordersTable.createdAt})`)
    .orderBy(sql`date_trunc('day', ${ordersTable.createdAt})`);

  // Build full 14-day window with zero-filled gaps
  const dailyOrders: { date: string; count: number }[] = [];
  const dailyRevenue: { date: string; amount: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(since);
    d.setDate(since.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const found = dailyRows.find((r) => r.day === key);
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    dailyOrders.push({ date: label, count: found ? Number(found.count) : 0 });
    dailyRevenue.push({ date: label, amount: found ? Number(found.revenue) : 0 });
  }

  const allOrders = await db
    .select({ items: ordersTable.items, total: ordersTable.total })
    .from(ordersTable)
    .where(eq(ordersTable.vendorId, params.data.vendorId));

  const itemAgg = new Map<string, { quantity: number; revenue: number }>();
  for (const o of allOrders) {
    for (const it of o.items) {
      const cur = itemAgg.get(it.name) ?? { quantity: 0, revenue: 0 };
      cur.quantity += it.quantity;
      cur.revenue += it.unitPrice * it.quantity;
      itemAgg.set(it.name, cur);
    }
  }
  const topItems = [...itemAgg.entries()]
    .map(([name, v]) => ({ name, quantity: v.quantity, revenue: v.revenue }))
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 8);

  const customers = await db
    .select({ totalOrders: customersTable.totalOrders })
    .from(customersTable)
    .where(eq(customersTable.vendorId, params.data.vendorId));
  const totalCustomers = customers.length;
  const repeat = customers.filter((c) => c.totalOrders > 1).length;
  const repeatCustomerRate = totalCustomers > 0 ? repeat / totalCustomers : 0;

  return res.json({ dailyOrders, dailyRevenue, topItems, repeatCustomerRate });
});

export default router;
