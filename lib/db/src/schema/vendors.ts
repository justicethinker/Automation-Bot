import {
  pgTable,
  text,
  uuid,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

export const vendorsTable = pgTable("vendors", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  phoneNumber: text("phone_number").notNull().unique(),
  adminNumber: text("admin_number"),
  phoneNumberId: text("phone_number_id").unique(),
  botNumber: text("bot_number"),
  plan: text("plan").notNull().default("starter"),
  botEnabled: boolean("bot_enabled").notNull().default(true),
  bankName: text("bank_name"),
  bankAccountNumber: text("bank_account_number"),
  bankAccountHolder: text("bank_account_holder"),
  currency: text("currency").notNull().default("USD"),
  welcomeMessage: text("welcome_message"),
  followUpsEnabled: boolean("follow_ups_enabled").notNull().default(false),
  requiresDeliveryAddress: boolean("requires_delivery_address").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type VendorRow = typeof vendorsTable.$inferSelect;
export type InsertVendor = typeof vendorsTable.$inferInsert;
