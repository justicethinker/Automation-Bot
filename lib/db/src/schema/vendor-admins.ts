import {
  pgTable,
  text,
  uuid,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { vendorsTable } from "./vendors";

export const adminRoleEnum = pgEnum("admin_role", ["owner", "staff"]);

export const vendorAdminsTable = pgTable("vendor_admins", {
  id: uuid("id").primaryKey().defaultRandom(),
  vendorId: uuid("vendor_id")
    .notNull()
    .references(() => vendorsTable.id, { onDelete: "cascade" }),
  phone: text("phone").notNull(),
  name: text("name"),
  role: adminRoleEnum("role").notNull().default("staff"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type VendorAdminRow = typeof vendorAdminsTable.$inferSelect;
export type InsertVendorAdmin = typeof vendorAdminsTable.$inferInsert;
