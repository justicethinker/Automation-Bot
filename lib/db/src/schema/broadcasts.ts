import {
  pgTable,
  text,
  uuid,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { vendorsTable } from "./vendors";

export const broadcastsTable = pgTable("broadcasts", {
  id: uuid("id").primaryKey().defaultRandom(),
  vendorId: uuid("vendor_id")
    .notNull()
    .references(() => vendorsTable.id, { onDelete: "cascade" }),
  message: text("message").notNull(),
  recipientCount: integer("recipient_count").notNull().default(0),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BroadcastRow = typeof broadcastsTable.$inferSelect;
export type InsertBroadcast = typeof broadcastsTable.$inferInsert;
