import {
  pgTable,
  text,
  uuid,
  integer,
  timestamp,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";
import { vendorsTable } from "./vendors";

export const conversationStatusEnum = pgEnum("conversation_status", ["bot", "human", "closed"]);

export const conversationsTable = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  vendorId: uuid("vendor_id")
    .notNull()
    .references(() => vendorsTable.id, { onDelete: "cascade" }),
  customerPhone: text("customer_phone").notNull(),
  customerName: text("customer_name").notNull(),
  status: conversationStatusEnum("status").notNull().default("bot"),
  lastMessagePreview: text("last_message_preview").notNull().default(""),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  unreadCount: integer("unread_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => ({
  uniqueVendorCustomer: uniqueIndex("unique_vendor_customer_idx")
    .on(table.vendorId, table.customerPhone),
}));

export type ConversationRow = typeof conversationsTable.$inferSelect;
export type InsertConversation = typeof conversationsTable.$inferInsert;
