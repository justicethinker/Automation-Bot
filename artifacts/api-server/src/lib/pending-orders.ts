import { db, pendingOrdersTable } from "@workspace/db";
import { eq, and, lt } from "drizzle-orm";
import { logger } from "./logger";

// Sentinel UUID used to identify the clarification metadata row
const CLARIFICATION_SENTINEL_ID = "00000000-0000-0000-0000-000000000000";

export type PendingResolvedItem = {
  menuItemId: string;
  itemName: string;
  quantity: number;
  unitPrice: number;
  total: number;
};

export type PendingClarification = {
  originalText: string;
  quantity: number;
  candidates: Array<{ itemId: string; itemName: string; confidence: number }>;
  remaining: Array<{ text: string; quantity: number }>;
};

export type PendingOrder = {
  vendorId: string;
  customerPhone: string;
  resolvedItems: PendingResolvedItem[];
  pendingClarification: PendingClarification | null;
  total: number;
  expiresAt: Date;
};

/**
 * Store a pending order as multiple rows — one per item.
 * If pendingClarification is present, store it as a sentinel row.
 */
export async function setPendingOrder(
  vendorId: string,
  customerPhone: string,
  resolvedItems: PendingResolvedItem[],
  pendingClarification: PendingClarification | null,
  total: number,
): Promise<PendingOrder | null> {
  try {
    // Delete all existing rows for this customer+vendor
    await db
      .delete(pendingOrdersTable)
      .where(
        and(
          eq(pendingOrdersTable.vendorId, vendorId),
          eq(pendingOrdersTable.customerPhone, customerPhone),
        ),
      );

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const now = new Date();

    const rows = [];

    // Insert one row per resolved item
    for (const item of resolvedItems) {
      rows.push({
        vendorId,
        customerPhone,
        menuItemId: item.menuItemId,
        itemName: item.itemName,
        quantity: item.quantity,
        unitPrice: item.unitPrice.toString(),
        total: item.total.toString(),
        createdAt: now,
        expiresAt,
      });
    }

    // Insert clarification as a sentinel row if present
    if (pendingClarification) {
      rows.push({
        vendorId,
        customerPhone,
        menuItemId: CLARIFICATION_SENTINEL_ID,
        itemName: JSON.stringify(pendingClarification),
        quantity: 0,
        unitPrice: "0",
        total: total.toString(),
        createdAt: now,
        expiresAt,
      });
    }

    // If nothing to insert (empty order), return null
    if (rows.length === 0) return null;

    await db.insert(pendingOrdersTable).values(rows);

    return {
      vendorId,
      customerPhone,
      resolvedItems,
      pendingClarification,
      total,
      expiresAt,
    };
  } catch (err) {
    logger.error({ err, vendorId, customerPhone }, "Failed to set pending order");
    return null;
  }
}

/**
 * Retrieve a pending order by grouping all rows for this customer+vendor.
 */
export async function getPendingOrder(
  vendorId: string,
  customerPhone: string,
): Promise<{ status: "found" | "expired" | "not_found"; order?: PendingOrder }> {
  try {
    const rows = await db
      .select()
      .from(pendingOrdersTable)
      .where(
        and(
          eq(pendingOrdersTable.vendorId, vendorId),
          eq(pendingOrdersTable.customerPhone, customerPhone),
        ),
      );

    if (rows.length === 0) return { status: "not_found" };

    // Check expiry on first row
    if (new Date() > rows[0]!.expiresAt) {
      await clearPendingOrder(vendorId, customerPhone);
      return { status: "expired" };
    }

    const resolvedItems: PendingResolvedItem[] = [];
    let pendingClarification: PendingClarification | null = null;
    let total = 0;

    for (const row of rows) {
      if (row.menuItemId === CLARIFICATION_SENTINEL_ID) {
        try {
          pendingClarification = JSON.parse(row.itemName) as PendingClarification;
          total = Number(row.total);
        } catch {
          logger.warn({ vendorId, customerPhone }, "Failed to parse clarification sentinel row");
        }
      } else {
        resolvedItems.push({
          menuItemId: row.menuItemId,
          itemName: row.itemName,
          quantity: row.quantity,
          unitPrice: Number(row.unitPrice),
          total: Number(row.total),
        });
        total += Number(row.total);
      }
    }

    // If clarification row set total, use that (it holds the running total)
    // Otherwise sum from items
    const finalTotal = pendingClarification
      ? rows.find(r => r.menuItemId === CLARIFICATION_SENTINEL_ID)
        ? Number(rows.find(r => r.menuItemId === CLARIFICATION_SENTINEL_ID)!.total)
        : total
      : total;

    return {
      status: "found",
      order: {
        vendorId,
        customerPhone,
        resolvedItems,
        pendingClarification,
        total: finalTotal,
        expiresAt: rows[0]!.expiresAt,
      },
    };
  } catch (err) {
    logger.error({ err, vendorId, customerPhone }, "Failed to get pending order");
    return { status: "not_found" };
  }
}

/**
 * Clear all pending order rows for a customer
 */
export async function clearPendingOrder(
  vendorId: string,
  customerPhone: string,
): Promise<void> {
  try {
    await db
      .delete(pendingOrdersTable)
      .where(
        and(
          eq(pendingOrdersTable.vendorId, vendorId),
          eq(pendingOrdersTable.customerPhone, customerPhone),
        ),
      );
  } catch (err) {
    logger.error({ err, vendorId, customerPhone }, "Failed to clear pending order");
  }
}

export async function cleanupExpiredPendingOrders(vendorId: string): Promise<number> {
  try {
    const result = await db
      .delete(pendingOrdersTable)
      .where(
        and(
          eq(pendingOrdersTable.vendorId, vendorId),
          lt(pendingOrdersTable.expiresAt, new Date()),
        ),
      )
      .returning();
    return result.length;
  } catch (err) {
    logger.error({ err, vendorId }, "Failed to cleanup expired pending orders");
    return 0;
  }
}

export async function cleanupAllExpiredPendingOrders(): Promise<number> {
  try {
    const result = await db
      .delete(pendingOrdersTable)
      .where(lt(pendingOrdersTable.expiresAt, new Date()))
      .returning();
    if (result.length > 0) {
      logger.info({ count: result.length }, "Global cleanup: expired pending orders removed");
    }
    return result.length;
  } catch (err) {
    logger.error({ err }, "Failed to cleanup all expired pending orders");
    return 0;
  }
}

export function scheduleExpiredPendingOrdersCleanup(intervalMs = 3600000): NodeJS.Timer {
  return setInterval(async () => {
    try {
      await cleanupAllExpiredPendingOrders();
    } catch (err) {
      logger.error({ err }, "Scheduled pending orders cleanup failed");
    }
  }, intervalMs);
}
