import Fuse from "fuse.js";
import { MenuItemRow } from "@workspace/db";
import { logger } from "./logger";

export type MenuMatchResult =
  | { kind: "exact"; item: MenuItemRow }
  | { kind: "unique"; item: MenuItemRow; confidence: number }
  | { kind: "ambiguous"; options: MenuItemRow[]; confidence: number }
  | { kind: "none"; suggestions: MenuItemRow[] };

/**
 * Fuse.js instance cache with TTL
 */
interface FuseCache {
  fuse: Fuse<MenuItemRow>;
  expiresAt: number;
}

const fuseCache = new Map<string, FuseCache>();
const FUSE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getFuseInstance(vendorId: string, menuItems: MenuItemRow[]): Fuse<MenuItemRow> {
  const cached = fuseCache.get(vendorId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.fuse;
  }
  const fuse = new Fuse(menuItems, {
    keys: ["name"],
    threshold: 0.4,
    includeScore: true,
  });
  fuseCache.set(vendorId, { fuse, expiresAt: Date.now() + FUSE_CACHE_TTL_MS });
  return fuse;
}

/**
 * Invalidate the Fuse cache for a vendor when their menu changes
 */
export function invalidateFuseCache(vendorId: string): void {
  fuseCache.delete(vendorId);
}

/**
 * Find best menu item match with disambiguation
 * 
 * Returns:
 * - "exact" if exact match found
 * - "unique" if fuzzy match is confident (>70%)
 * - "ambiguous" if multiple close matches exist
 * - "none" if no match found
 */
export function findBestMenuMatch(
  itemName: string,
  menuItems: MenuItemRow[],
  vendorId: string,
  threshold: number = 0.6,
): MenuMatchResult {
  if (menuItems.length === 0) {
    return { kind: "none", suggestions: [] };
  }

  const itemLower = itemName.toLowerCase().trim();

  // Exact match (case-insensitive)
  const exact = menuItems.find((m) => m.name.toLowerCase() === itemLower);
  if (exact) {
    logger.debug({ itemName, matchedItem: exact.name }, "Exact menu match");
    return { kind: "exact", item: exact };
  }

  // Substring match (high confidence)
  const substring = menuItems.find((m) =>
    m.name.toLowerCase().includes(itemLower),
  );
  if (substring) {
    logger.debug({ itemName, matchedItem: substring.name }, "Substring menu match");
    return { kind: "unique", item: substring, confidence: 0.85 };
  }

  // Fuzzy match using Fuse.js with cached instance
  const fuse = getFuseInstance(vendorId, menuItems);

  const results = fuse.search(itemName);

  if (results.length === 0) {
    logger.debug({ itemName }, "No menu match found");
    return {
      kind: "none",
      suggestions: [],
    };
  }

  const similarity = (score: number | null | undefined) => Math.max(0, 1 - (score ?? 1));
  const topResult = results[0];
  const topScore = similarity(topResult.score);

  if (topScore < 0.4) {
    logger.debug({ itemName, bestScore: topScore }, "No menu match with sufficient confidence");
    return { kind: "none", suggestions: [] };
  }

  const closeMatches = results
    .map((result) => ({ item: result.item, similarity: similarity(result.score) }))
    .filter((result) => result.similarity >= 0.4)
    .slice(0, 5);

  if (topScore >= 0.7 && closeMatches.length === 1) {
    logger.debug(
      { itemName, matchedItem: topResult.item.name, confidence: topScore },
      "Best fuzzy menu match",
    );
    return { kind: "unique", item: topResult.item, confidence: topScore };
  }

  const ambiguousOptions = closeMatches
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3)
    .map((result) => result.item);

  if (closeMatches.length > 1 || topScore < 0.7) {
    logger.debug(
      {
        itemName,
        topMatches: ambiguousOptions.map((m) => m.name),
        confidence: topScore,
      },
      "Ambiguous menu match",
    );
    return {
      kind: "ambiguous",
      options: ambiguousOptions,
      confidence: topScore,
    };
  }

  logger.debug(
    { itemName, matchedItem: topResult.item.name, confidence: topScore },
    "Best fuzzy menu match",
  );
  return { kind: "unique", item: topResult.item, confidence: topScore };
}
