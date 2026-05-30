import {
  pgTable,
  text,
  uuid,
  timestamp,
  boolean,
  index,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";
import { vendorsTable } from "./vendors";

export const messageDeliveryTable = pgTable(
  "message_delivery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendorsTable.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    to: text("to").notNull(),
    textPreview: text("text_preview"),
    delivered: boolean("delivered").notNull().default(false),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    attemptCount: integer("attempt_count").notNull().default(1),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => {
    return {
      // Index for lookups by message ID
      messageIdIdx: index("message_delivery_message_id_idx").on(table.messageId),
      // Index for cleaning up old undelivered messages
      createdAtIdx: index("message_delivery_created_at_idx").on(table.createdAt),
      // Index for status queries
      deliveredIdx: index("message_delivery_delivered_idx").on(table.delivered),
      // Composite index for vendor + status
      vendorDeliveredIdx: index("message_delivery_vendor_delivered_idx")
        .on(table.vendorId, table.delivered),
    };
  },
);

export type MessageDeliveryRow = typeof messageDeliveryTable.$inferSelect;
export type InsertMessageDelivery = typeof messageDeliveryTable.$inferInsert;
