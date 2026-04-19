// repricing.js — Auto-adjust prices based on competitor tracking data

import { updatePrice } from "./amazon_sp_api.js";
import { hasSpApiCredentials } from "./amazon_auth.js";
import { loadDB, saveDB, getTrackedProducts } from "./products_db.js";

// Repricing rules
const MIN_MARGIN_PCT = 20;    // Never price below 20% margin
const MAX_UNDERCUT_PCT = 0.03; // Undercut competitors by max 3%
const MAX_PREMIUM_PCT = 0.05;  // Price above competitors by max 5% if winning buy box

/**
 * Calculate the optimal price given competitor data.
 * @param {object} product - Our product with cost data
 * @param {number} lowestCompetitorPrice
 * @returns {number|null} new price, or null if no change needed
 */
function calculateOptimalPrice(product, lowestCompetitorPrice) {
  if (!lowestCompetitorPrice || lowestCompetitorPrice <= 0) return null;

  const currentPrice = product.currentPrice || product.price || 0;
  if (currentPrice <= 0) return null;

  // Calculate our floor price (minimum to maintain margin)
  const cogs = product.estimatedCOGS || product.price * 0.25;
  const fbaFees = product.fbaFees || 4.0;
  const minPrice = parseFloat(((cogs + fbaFees) / (1 - MIN_MARGIN_PCT / 100)).toFixed(2));

  let targetPrice;

  if (currentPrice > lowestCompetitorPrice * 1.1) {
    // We're priced more than 10% above — undercut slightly to compete
    targetPrice = parseFloat((lowestCompetitorPrice * (1 - MAX_UNDERCUT_PCT)).toFixed(2));
  } else if (currentPrice < lowestCompetitorPrice * 0.95) {
    // We're already the lowest by a lot — raise price up toward competitor to protect margin
    targetPrice = parseFloat((lowestCompetitorPrice * (1 - MAX_UNDERCUT_PCT)).toFixed(2));
    // Only raise, never lower further
    if (targetPrice <= currentPrice) return null;
  } else {
    // Price is competitive — no change needed
    return null;
  }

  // Never go below floor price
  targetPrice = Math.max(targetPrice, minPrice);

  // Round to .99 pricing
  targetPrice = parseFloat((Math.floor(targetPrice) + 0.99).toFixed(2));

  // Only update if price actually changed by more than $0.10
  if (Math.abs(targetPrice - currentPrice) < 0.1) return null;

  return targetPrice;
}

/**
 * Run repricing for all actively tracked products.
 * @param {boolean} dryRun
 * @returns {Array} repricing actions taken
 */
export async function repriceProducts(dryRun = false) {
  if (!hasSpApiCredentials()) {
    console.log("[Repricing] SP-API credentials not set — skipping repricing");
    return [];
  }

  const db = loadDB();
  const tracked = getTrackedProducts(db);

  if (tracked.length === 0) {
    console.log("[Repricing] No tracked products — skipping repricing");
    return [];
  }

  console.log(`[Repricing] Checking prices for ${tracked.length} products...`);

  const actions = [];

  for (const product of tracked) {
    try {
      if (!product.sku) {
        console.log(`[Repricing] No SKU for ${product.asin} — skipping`);
        continue;
      }

      // Use competitor data from last competitor tracking run
      const lowestCompetitorPrice = product.lowestCompetitorPrice || 0;

      if (!lowestCompetitorPrice) {
        console.log(`[Repricing] No competitor price data for ${product.asin} — skipping`);
        continue;
      }

      const newPrice = calculateOptimalPrice(product, lowestCompetitorPrice);

      if (!newPrice) {
        console.log(`[Repricing] ${product.asin} price is optimal at $${product.currentPrice || product.price}`);
        continue;
      }

      const oldPrice = product.currentPrice || product.price;

      if (!dryRun) {
        await updatePrice(product.sku, newPrice);

        // Update price in DB
        product.currentPrice = newPrice;
        product.lastRepricedAt = new Date().toISOString();

        console.log(`[Repricing] ${product.asin}: $${oldPrice} → $${newPrice} (competitor low: $${lowestCompetitorPrice})`);
      } else {
        console.log(`[Repricing] DRY RUN — ${product.asin}: $${oldPrice} → $${newPrice}`);
      }

      actions.push({
        asin: product.asin,
        title: product.title?.slice(0, 50),
        oldPrice,
        newPrice,
        competitorPrice: lowestCompetitorPrice,
      });

      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`[Repricing] Error repricing ${product.asin}:`, err.message);
    }
  }

  if (!dryRun && actions.length > 0) {
    saveDB(db);
  }

  console.log(`[Repricing] Repriced ${actions.length} products`);
  return actions;
}
