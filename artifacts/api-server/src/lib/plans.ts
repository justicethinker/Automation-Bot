export type Plan = "starter" | "pro";

export type Feature =
  | "bot"
  | "menu"
  | "orders"
  | "payments"
  | "handover"
  | "analytics"
  | "customer_memory"
  | "broadcasts";

const PRO_ONLY: Feature[] = ["analytics", "customer_memory", "broadcasts"];

export function hasFeature(
  vendor: { plan: string },
  feature: Feature,
): boolean {
  if (PRO_ONLY.includes(feature)) {
    return vendor.plan === "pro";
  }
  return true;
}
