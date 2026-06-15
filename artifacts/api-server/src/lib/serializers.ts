import type {
  VendorRow,
  MenuItemRow,
  OrderRow,
  ConversationRow,
  MessageRow,
  CustomerRow,
  PaymentRow,
  PromotionRow,
  BroadcastRow,
} from "@workspace/db";

export function toVendor(row: VendorRow) {
  return {
    id: row.id,
    name: row.name,
    phoneNumber: row.phoneNumber,
    adminNumber: row.adminNumber,
    phoneNumberId: row.phoneNumberId,
    botNumber: row.botNumber,
    plan: row.plan as "starter" | "pro",
    botEnabled: row.botEnabled,
    bankName: row.bankName,
    bankAccountNumber: row.bankAccountNumber,
    bankAccountHolder: row.bankAccountHolder,
    currency: row.currency,
    welcomeMessage: row.welcomeMessage,
    followUpsEnabled: row.followUpsEnabled,
    requiresDeliveryAddress: row.requiresDeliveryAddress,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toPromotion(row: PromotionRow) {
  return {
    id: row.id,
    vendorId: row.vendorId,
    title: row.title,
    description: row.description,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toBroadcast(row: BroadcastRow) {
  return {
    id: row.id,
    vendorId: row.vendorId,
    message: row.message,
    recipientCount: row.recipientCount,
    sentAt: row.sentAt.toISOString(),
  };
}

export function toMenuItem(row: MenuItemRow) {
  return {
    id: row.id,
    vendorId: row.vendorId,
    name: row.name,
    description: row.description,
    price: Number(row.price),
    category: row.category,
    available: row.available,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toOrder(row: OrderRow, vendorName?: string) {
  return {
    id: row.id,
    vendorId: row.vendorId,
    vendorName: vendorName ?? null,
    customerPhone: row.customerPhone,
    customerName: row.customerName,
    status: row.status as
      | "pending"
      | "confirmed"
      | "paid"
      | "rejected"
      | "completed"
      | "cancelled",
    paymentStatus: row.paymentStatus as "pending" | "paid",
    total: Number(row.total),
    currency: row.currency,
    items: row.items,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toConversation(row: ConversationRow, vendorName?: string) {
  return {
    id: row.id,
    vendorId: row.vendorId,
    vendorName: vendorName ?? null,
    customerPhone: row.customerPhone,
    customerName: row.customerName,
    status: row.status as "bot" | "human" | "closed",
    lastMessagePreview: row.lastMessagePreview,
    lastMessageAt: row.lastMessageAt.toISOString(),
    unreadCount: row.unreadCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toMessage(row: MessageRow) {
  return {
    id: row.id,
    conversationId: row.conversationId,
    direction: row.direction as "in" | "out",
    sender: row.sender as "customer" | "bot" | "vendor" | "system",
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toCustomer(row: CustomerRow) {
  return {
    id: row.id,
    vendorId: row.vendorId,
    phone: row.phone,
    name: row.name,
    notes: row.notes,
    totalOrders: row.totalOrders,
    totalSpent: Number(row.totalSpent),
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toPayment(row: PaymentRow) {
  return {
    id: row.id,
    vendorId: row.vendorId,
    orderId: row.orderId,
    customerName: row.customerName,
    amount: Number(row.amount),
    currency: row.currency,
    method: row.method as "bank_transfer" | "payment_link" | "cash",
    status: row.status as "pending" | "confirmed" | "failed",
    reference: row.reference,
    createdAt: row.createdAt.toISOString(),
  };
}
