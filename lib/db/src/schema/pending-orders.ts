import {
  pgTable,
  text,
  uuid,
  timestamp,
  numeric,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { vendorsTable } from "./vendors";
import { menuItemsTable } from "./menuItems";

export const pendingOrdersTable = pgTable(
  "pending_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendorsTable.id, { onDelete: "cascade" }),
    customerPhone: text("customer_phone").notNull(),
    menuItemId: uuid("menu_item_id")
      .notNull()
      .references(() => menuItemsTable.id, { onDelete: "cascade" }),
    itemName: text("item_name").notNull(),
    quantity: integer("quantity").notNull(),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
    total: numeric("total", { precision: 12, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => {
    return {
      // Index for vendor+customer lookups (NOT unique - multiple items per customer)
      vendorCustomerIdx: index("pending_orders_vendor_customer_idx")
        .on(table.vendorId, table.customerPhone),
      // Index for cleanup queries
      expiresAtIdx: index("pending_orders_expires_at_idx").on(table.expiresAt),
      // Index for lookups
      createdAtIdx: index("pending_orders_created_at_idx").on(table.createdAt),
    };
  },
);

export type PendingOrderRow = typeof pendingOrdersTable.$inferSelect;
export type InsertPendingOrder = typeof pendingOrdersTable.$inferInsert;
