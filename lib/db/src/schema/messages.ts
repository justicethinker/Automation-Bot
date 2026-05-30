import {
  pgTable,
  text,
  uuid,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { conversationsTable } from "./conversations";

export const messagesTable = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversationsTable.id, { onDelete: "cascade" }),
  direction: text("direction").notNull(),
  sender: text("sender").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => ({
  conversationCreatedIdx: index("conversation_created_idx")
    .on(table.conversationId, table.createdAt),
}));

export type MessageRow = typeof messagesTable.$inferSelect;
export type InsertMessage = typeof messagesTable.$inferInsert;
