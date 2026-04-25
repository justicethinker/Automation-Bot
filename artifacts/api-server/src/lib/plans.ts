export type Plan = "starter" | "pro";

export type Feature =
  | "bot"
  | "menu"
  | "orders"
  | "payments"
  | "handover"
  | "analytics"
  | "customer_memory"
  | "broadcasts"
  | "promotions"
  | "follow_ups";

const PRO_ONLY: Feature[] = [
  "analytics",
  "customer_memory",
  "broadcasts",
  "promotions",
  "follow_ups",
];

export function hasFeature(
  vendorOrPlan: { plan: string } | string,
  feature: Feature,
): boolean {
  const plan =
    typeof vendorOrPlan === "string" ? vendorOrPlan : vendorOrPlan.plan;
  if (PRO_ONLY.includes(feature)) {
    return plan === "pro";
  }
  return true;
}
