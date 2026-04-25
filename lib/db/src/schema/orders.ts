import {
  pgTable,
  text,
  uuid,
  timestamp,
  numeric,
  jsonb,
} from "drizzle-orm/pg-core";
import { vendorsTable } from "./vendors";

export type OrderItemJson = {
  name: string;
  quantity: number;
  unitPrice: number;
};

export const ordersTable = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  vendorId: uuid("vendor_id")
    .notNull()
    .references(() => vendorsTable.id, { onDelete: "cascade" }),
  customerPhone: text("customer_phone").notNull(),
  customerName: text("customer_name").notNull(),
  status: text("status").notNull().default("pending"),
  paymentStatus: text("payment_status").notNull().default("pending"),
  total: numeric("total", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  items: jsonb("items").$type<OrderItemJson[]>().notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type OrderRow = typeof ordersTable.$inferSelect;
export type InsertOrder = typeof ordersTable.$inferInsert;
