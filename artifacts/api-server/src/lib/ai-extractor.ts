import { GoogleGenerativeAI } from "@google/generative-ai";
import { logger } from "./logger";

// Lazily initialize Gemini only if API key is present
let gemini: GoogleGenerativeAI | null = null;

function getGeminiClient(): GoogleGenerativeAI | null {
  if (!process.env.GEMINI_API_KEY) {
    return null;
  }
  if (!gemini) {
    gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return gemini;
}

export type ExtractedOrder = {
  item: string;
  quantity: number;
};

export type ExtractedAdminIntent = {
  intent: string;
  entities: Record<string, unknown>;
};

function parseJsonResponse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }
    throw new Error("Invalid JSON");
  }
}

async function runGemini(
  prompt: string,
  timeoutMs = 10000,
): Promise<string | null> {
  const client = getGeminiClient();
  if (!client) {
    logger.debug("GEMINI_API_KEY not set, skipping AI extraction");
    return null;
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error("AI extraction timeout: exceeded 10 seconds"));
    }, timeoutMs);
  });

  try {
    const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
    const response = await Promise.race([
      model.generateContent({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
      }),
      timeoutPromise,
    ]);
    return response.response.text();
  } catch (err) {
    if (err instanceof Error && err.message.includes("timeout")) {
      logger.warn("AI extraction timeout, falling back");
    } else {
      logger.warn({ err }, "AI extraction failed");
    }
    return null;
  }
}

/**
 * Attempts to extract order details using Gemini AI.
 * Returns null if the API is unavailable, times out, fails, or returns invalid JSON.
 */
export async function aiExtractOrder(
  text: string,
  menuItems?: Array<{ name: string; price: string }>,
  recentHistory?: Array<{ role: "customer" | "bot"; text: string }>,
): Promise<ExtractedOrder[] | null> {
  const menuContext = menuItems && menuItems.length > 0
    ? `\n\nAvailable menu items:\n${menuItems.map((m) => `- ${m.name} (${m.price})`).join("\n")}\n\nOnly extract items that closely match items from this menu.`
    : "";
  const historyContext = recentHistory && recentHistory.length > 0
    ? `\n\nRecent conversation for context:\n${recentHistory.map((m) => `${m.role === "customer" ? "Customer" : "Bot"}: ${m.text}`).join("\n")}\n\nNow extract items from the LATEST message below.`
    : "";
  const prompt = `Extract food order details from this customer message. Return ONLY valid JSON. Use this exact shape:\n{\n  "items": [\n    { "item": "<product name exactly as on menu>", "quantity": <integer> }\n  ]\n}\nIf you cannot extract any order items, return null.${menuContext}${historyContext}\n\nCustomer message: ${text}`;

  const content = await runGemini(prompt);
  if (!content) return null;

  logger.debug({ aiResponse: content }, "AI order extraction response");

  try {
    const parsed = parseJsonResponse(content);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as any).items)
    ) {
      logger.debug({ parsed }, "AI order response missing items array");
      return null;
    }

    const items = (parsed as any).items;
    const result: ExtractedOrder[] = [];

    for (const raw of items) {
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof raw.item !== "string" ||
        raw.item.trim() === ""
      ) {
        return null;
      }
      const quantity = Number(raw.quantity ?? 1);
      if (!Number.isInteger(quantity) || quantity < 1) {
        return null;
      }
      result.push({ item: raw.item.trim(), quantity });
    }

    return result.length > 0 ? result : null;
  } catch (err) {
    logger.warn({ err }, "AI order extraction invalid JSON");
    return null;
  }
}

/**
 * Attempts to extract admin intent and entities using Gemini AI.
 * Returns null if the API is unavailable, times out, fails, or returns invalid JSON.
 */
export async function aiExtractAdminIntent(
  text: string,
  recentHistory?: Array<{ role: "admin" | "bot"; text: string }>,
): Promise<ExtractedAdminIntent | null> {
  const historyContext = recentHistory && recentHistory.length > 0
    ? `\n\nRecent conversation for context:\n${recentHistory.map((m) => `${m.role === "admin" ? "Vendor" : "Bot"}: ${m.text}`).join("\n")}\n\nNow analyze the LATEST message below.`
    : "";
  const prompt = `Analyze this vendor message and return ONLY valid JSON in the form {"intent":"<intent>","entities":{...}}. Allowed intents: add_menu_item, remove_menu_item, update_price, mark_unavailable, mark_available, show_menu, confirm_order, reject_order, confirm_payment, switch_human, switch_bot. Use entity names such as itemName, price, orderId, customerPhone. If the intent is unclear, return {"intent":"unknown","entities":{}}. Do not include any extra text.${historyContext}\n\nMessage: ${text}`;

  const content = await runGemini(prompt);
  if (!content) return null;

  logger.debug({ aiResponse: content }, "AI admin intent response");

  try {
    const parsed = parseJsonResponse(content);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as any).intent !== "string" ||
      typeof (parsed as any).entities !== "object"
    ) {
      logger.debug({ parsed }, "AI admin intent response invalid shape");
      return null;
    }

    return {
      intent: (parsed as any).intent,
      entities: (parsed as any).entities,
    };
  } catch (err) {
    logger.warn({ err }, "AI admin intent invalid JSON");
    return null;
  }
}

export type CustomerIntent = {
  intent: "order" | "menu" | "status" | "price_inquiry" | "timing_inquiry" | "help" | "unknown";
  confidence: number;  // 0-1
};

/**
 * Detect customer intent from ambiguous messages
 * Helps the bot interpret messages like "how much is the rice?" or "when will my food arrive?"
 */
export async function detectCustomerIntent(
  text: string,
  menuItems?: Array<{ name: string; price: string }>,
): Promise<CustomerIntent | null> {
  const menuContext = menuItems && menuItems.length > 0
    ? `\n\nAvailable menu items:\n${menuItems.map((m) => `- ${m.name} (${m.price})`).join("\n")}`
    : "";
  
  const prompt = `Analyze this customer message and return ONLY valid JSON in the form {"intent":"<intent>","confidence":<0-1>}. 
Possible intents: "order" (wants to order items), "menu" (wants to see/ask about menu), "status" (asking about order status), "price_inquiry" (asking about prices), "timing_inquiry" (asking delivery/preparation time), "help" (needs help), "unknown" (unclear).${menuContext}

Return JSON like: {"intent":"menu","confidence":0.95}

Message: ${text}`;

  const content = await runGemini(prompt);
  if (!content) return null;

  try {
    const parsed = parseJsonResponse(content) as any;
    if (!parsed || typeof parsed.intent !== "string" || typeof parsed.confidence !== "number") {
      return null;
    }

    return {
      intent: parsed.intent as CustomerIntent["intent"],
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
    };
  } catch (err) {
    logger.warn({ err }, "Customer intent detection failed");
    return null;
  }
}
