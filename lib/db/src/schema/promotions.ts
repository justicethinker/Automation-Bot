import {
  pgTable,
  text,
  uuid,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { vendorsTable } from "./vendors";

export const promotionsTable = pgTable("promotions", {
  id: uuid("id").primaryKey().defaultRandom(),
  vendorId: uuid("vendor_id")
    .notNull()
    .references(() => vendorsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PromotionRow = typeof promotionsTable.$inferSelect;
export type InsertPromotion = typeof promotionsTable.$inferInsert;
