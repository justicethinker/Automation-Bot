import { db, pool } from "@workspace/db";
import {
  vendorsTable,
  menuItemsTable,
  ordersTable,
  conversationsTable,
  messagesTable,
  customersTable,
  paymentsTable,
} from "@workspace/db";

async function seed() {
  // Skip if any vendors already exist
  const existing = await db.select().from(vendorsTable).limit(1);
  if (existing.length > 0) {
    console.log("Seed skipped: vendors already present.");
    return;
  }

  const [pizza] = await db
    .insert(vendorsTable)
    .values({
      name: "Sunrise Pizza",
      phoneNumber: "+15550100001",
      botNumber: "+15550100001",
      adminNumber: "+15558881111",
      phoneNumberId: "100000000000001",
      plan: "pro",
      currency: "USD",
      bankName: "First National",
      bankAccountNumber: "8842 1190 4421",
      bankAccountHolder: "Sunrise Pizza Co.",
      welcomeMessage:
        "Welcome to Sunrise Pizza. Reply MENU to see our wood-fired list.",
    })
    .returning();

  const [coffee] = await db
    .insert(vendorsTable)
    .values({
      name: "Cedar & Steam Coffee",
      phoneNumber: "+15550100002",
      botNumber: "+15550100002",
      adminNumber: "+15558882222",
      phoneNumberId: "100000000000002",
      plan: "starter",
      currency: "USD",
      bankName: "Pacific Trust",
      bankAccountNumber: "0021 4488 7733",
      bankAccountHolder: "Cedar & Steam LLC",
      welcomeMessage:
        "Hi from Cedar & Steam! Reply MENU for today's drinks.",
    })
    .returning();

  // Menu — Pizza
  const pizzaItems = await db
    .insert(menuItemsTable)
    .values([
      { vendorId: pizza!.id, name: "Margherita", description: "Tomato, fresh mozzarella, basil", price: "12.50", category: "Pizza" },
      { vendorId: pizza!.id, name: "Pepperoni", description: "Spicy cured pepperoni, mozzarella", price: "14.00", category: "Pizza" },
      { vendorId: pizza!.id, name: "Funghi", description: "Wild mushroom, fontina, thyme", price: "15.00", category: "Pizza" },
      { vendorId: pizza!.id, name: "Caesar Salad", description: "Romaine, anchovy, parmesan", price: "9.00", category: "Sides" },
      { vendorId: pizza!.id, name: "Tiramisu", description: "Espresso-soaked ladyfingers", price: "7.50", category: "Dessert" },
    ])
    .returning();

  // Menu — Coffee
  await db.insert(menuItemsTable).values([
    { vendorId: coffee!.id, name: "Espresso", price: "3.50", category: "Coffee" },
    { vendorId: coffee!.id, name: "Cappuccino", price: "4.50", category: "Coffee" },
    { vendorId: coffee!.id, name: "Cold Brew", price: "5.00", category: "Coffee" },
    { vendorId: coffee!.id, name: "Almond Croissant", price: "4.25", category: "Pastry" },
  ]);

  // A confirmed order ready for payment
  const margherita = pizzaItems.find((i) => i.name === "Margherita")!;
  const pepperoni = pizzaItems.find((i) => i.name === "Pepperoni")!;
  const [confirmedOrder] = await db
    .insert(ordersTable)
    .values({
      vendorId: pizza!.id,
      customerPhone: "+15551112222",
      customerName: "Mara Chen",
      status: "confirmed",
      total: ((Number(margherita.price) * 2) + Number(pepperoni.price)).toFixed(2),
      currency: "USD",
      items: [
        { name: margherita.name, quantity: 2, unitPrice: Number(margherita.price) },
        { name: pepperoni.name, quantity: 1, unitPrice: Number(pepperoni.price) },
      ],
    })
    .returning();

  // A pending order
  const [pendingOrder] = await db
    .insert(ordersTable)
    .values({
      vendorId: pizza!.id,
      customerPhone: "+15553334444",
      customerName: "Diego Romero",
      status: "pending",
      total: (Number(margherita.price) * 1).toFixed(2),
      currency: "USD",
      items: [{ name: margherita.name, quantity: 1, unitPrice: Number(margherita.price) }],
    })
    .returning();

  // A paid order with payment record
  const [paidOrder] = await db
    .insert(ordersTable)
    .values({
      vendorId: pizza!.id,
      customerPhone: "+15555556666",
      customerName: "Aisha Kapoor",
      status: "paid",
      total: (Number(pepperoni.price) * 1).toFixed(2),
      currency: "USD",
      items: [{ name: pepperoni.name, quantity: 1, unitPrice: Number(pepperoni.price) }],
    })
    .returning();

  await db.insert(paymentsTable).values({
    vendorId: pizza!.id,
    orderId: paidOrder!.id,
    customerName: paidOrder!.customerName,
    amount: paidOrder!.total,
    currency: paidOrder!.currency,
    method: "bank_transfer",
    status: "confirmed",
    reference: "REF-001",
  });

  // Customers
  await db.insert(customersTable).values([
    { vendorId: pizza!.id, phone: "+15551112222", name: "Mara Chen", totalOrders: 1, totalSpent: confirmedOrder!.total, lastSeenAt: new Date() },
    { vendorId: pizza!.id, phone: "+15553334444", name: "Diego Romero", totalOrders: 1, totalSpent: "0", lastSeenAt: new Date() },
    { vendorId: pizza!.id, phone: "+15555556666", name: "Aisha Kapoor", totalOrders: 3, totalSpent: "42.00", lastSeenAt: new Date() },
  ]);

  // Conversations + messages
  const [convMara] = await db
    .insert(conversationsTable)
    .values({
      vendorId: pizza!.id,
      customerPhone: "+15551112222",
      customerName: "Mara Chen",
      status: "bot",
      lastMessagePreview: "Total: $39.00. Reply *paid* once you have...",
      unreadCount: 0,
    })
    .returning();

  await db.insert(messagesTable).values([
    { conversationId: convMara!.id, direction: "in", sender: "customer", body: "hi" },
    { conversationId: convMara!.id, direction: "out", sender: "bot", body: "Welcome to Sunrise Pizza. Reply MENU to see our wood-fired list." },
    { conversationId: convMara!.id, direction: "in", sender: "customer", body: "menu" },
    { conversationId: convMara!.id, direction: "out", sender: "bot", body: "*Sunrise Pizza — Menu*\n\n*Pizza*\n- Margherita — $12.50\n- Pepperoni — $14.00\n- Funghi — $15.00\n\n*Sides*\n- Caesar Salad — $9.00\n\n*Dessert*\n- Tiramisu — $7.50" },
    { conversationId: convMara!.id, direction: "in", sender: "customer", body: "order Margherita x2, Pepperoni x1" },
    { conversationId: convMara!.id, direction: "out", sender: "bot", body: "*Order received*\n\n- 2× Margherita — $25.00\n- 1× Pepperoni — $14.00\n\nTotal: *$39.00*\n\nThe vendor will confirm shortly." },
  ]);

  const [convAgent] = await db
    .insert(conversationsTable)
    .values({
      vendorId: coffee!.id,
      customerPhone: "+15557778888",
      customerName: "Ben Park",
      status: "human",
      lastMessagePreview: "Connecting you to a human agent now.",
      unreadCount: 2,
    })
    .returning();

  await db.insert(messagesTable).values([
    { conversationId: convAgent!.id, direction: "in", sender: "customer", body: "hi do you sell beans by the pound?" },
    { conversationId: convAgent!.id, direction: "out", sender: "bot", body: "Hi from Cedar & Steam! Reply MENU for today's drinks." },
    { conversationId: convAgent!.id, direction: "in", sender: "customer", body: "no I want whole bean coffee" },
    { conversationId: convAgent!.id, direction: "in", sender: "customer", body: "agent please" },
    { conversationId: convAgent!.id, direction: "out", sender: "bot", body: "Connecting you to a human agent now. Someone will reply here shortly." },
  ]);

  await db.insert(customersTable).values({
    vendorId: coffee!.id, phone: "+15557778888", name: "Ben Park", totalOrders: 0, totalSpent: "0", lastSeenAt: new Date(),
  });

  console.log("Seed complete.");
}

seed()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
