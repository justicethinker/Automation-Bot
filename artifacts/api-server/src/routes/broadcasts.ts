import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  broadcastsTable,
  vendorsTable,
  customersTable,
  ordersTable,
  conversationsTable,
} from "@workspace/db";
import { and, eq, desc, gte, sql } from "drizzle-orm";
import {
  SendVendorBroadcastBody,
  ListVendorBroadcastsParams,
  SendVendorBroadcastParams,
  RunVendorFollowUpsParams,
} from "@workspace/api-zod";
import { toBroadcast } from "../lib/serializers";
import { hasFeature } from "../lib/plans";
import { sendWhatsAppMessage } from "../lib/whatsapp";

const router: IRouter = Router();

router.get("/vendors/:vendorId/broadcasts", async (req, res) => {
  const params = ListVendorBroadcastsParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });
  const rows = await db
    .select()
    .from(broadcastsTable)
    .where(eq(broadcastsTable.vendorId, params.data.vendorId))
    .orderBy(desc(broadcastsTable.sentAt))
    .limit(50);
  res.json(rows.map(toBroadcast));
});

router.post("/vendors/:vendorId/broadcasts", async (req, res) => {
  const params = SendVendorBroadcastParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });
  const body = SendVendorBroadcastBody.safeParse(req.body);
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
  if (!hasFeature(vendor, "broadcasts")) {
    return res.status(403).json({ error: "pro_feature" });
  }

  const sinceDays = body.data.sinceDays ?? 30;
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  const recipients = await db
    .select({ phone: customersTable.phone })
    .from(customersTable)
    .where(
      and(
        eq(customersTable.vendorId, vendor.id),
        gte(customersTable.lastSeenAt, since),
      ),
    );

  for (const r of recipients) {
    await sendWhatsAppMessage({
      phoneNumberId: vendor.phoneNumberId,
      to: r.phone,
      text: body.data.message,
    });
  }

  const [created] = await db
    .insert(broadcastsTable)
    .values({
      vendorId: vendor.id,
      message: body.data.message,
      recipientCount: recipients.length,
    })
    .returning();
  res.status(201).json(toBroadcast(created!));
});

// Find customers with confirmed-but-unpaid orders > 24h old, send a polite
// reminder, log it as a broadcast for visibility. Pro only.
router.post("/vendors/:vendorId/follow-ups/run", async (req, res) => {
  const params = RunVendorFollowUpsParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "invalid_params" });

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.id, params.data.vendorId))
    .limit(1);
  if (!vendor) return res.status(404).json({ error: "vendor_not_found" });
  if (!hasFeature(vendor, "follow_ups")) {
    return res.status(403).json({ error: "pro_feature" });
  }

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const stalled = await db
    .select({
      phone: ordersTable.customerPhone,
      name: ordersTable.customerName,
      total: ordersTable.total,
      shortId: sql<string>`substring(${ordersTable.id}::text, 1, 8)`,
    })
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.vendorId, vendor.id),
        eq(ordersTable.status, "confirmed"),
        eq(ordersTable.paymentStatus, "pending"),
        sql`${ordersTable.createdAt} < ${cutoff}`,
      ),
    );

  // De-dupe by phone (one reminder per customer per run)
  const seen = new Set<string>();
  const targets = stalled.filter((s) => {
    if (seen.has(s.phone)) return false;
    seen.add(s.phone);
    return true;
  });

  for (const t of targets) {
    const text =
      `Hi ${t.name}, this is a reminder about your order #${t.shortId} ` +
      `at ${vendor.name} (total ${vendor.currency} ${Number(t.total).toFixed(2)}). ` +
      `Reply *paid* once you've completed payment, or *agent* if you need help.`;
    await sendWhatsAppMessage({
      phoneNumberId: vendor.phoneNumberId,
      to: t.phone,
      text,
    });

    // Surface the reminder in the customer's conversation log too.
    const [conv] = await db
      .select()
      .from(conversationsTable)
      .where(
        and(
          eq(conversationsTable.vendorId, vendor.id),
          eq(conversationsTable.customerPhone, t.phone),
        ),
      )
      .limit(1);
    if (conv) {
      await db
        .update(conversationsTable)
        .set({
          lastMessagePreview: text.slice(0, 80),
          lastMessageAt: new Date(),
        })
        .where(eq(conversationsTable.id, conv.id));
    }
  }

  let broadcastId: string | null = null;
  if (targets.length > 0) {
    const [b] = await db
      .insert(broadcastsTable)
      .values({
        vendorId: vendor.id,
        message: `[Auto follow-up] Reminded ${targets.length} customer${targets.length === 1 ? "" : "s"} with stalled orders.`,
        recipientCount: targets.length,
      })
      .returning();
    broadcastId = b!.id;
  }

  res.json({ reminded: targets.length, broadcastId });
});

export default router;
