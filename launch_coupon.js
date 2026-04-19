// launch_coupon.js — Automatically run a launch price for new products to boost ranking velocity
// Lower price for first 14 days drives early sales → Amazon ranks you higher → organic sales for life

import { Resend } from "resend";
import { updatePrice, hasSpApiCredentials } from "./amazon_sp_api.js";
import { calculateMargin } from "./fee_calculator.js";
import { loadDB, saveDB } from "./products_db.js";

const resend = new Resend(process.env.RESEND_API_KEY);

// Launch discount — 15% off for first 14 days
const LAUNCH_DISCOUNT = 0.15;
const LAUNCH_DURATION_DAYS = 14;
// Never go below this margin during launch (protect profitability)
const MIN_LAUNCH_MARGIN = 0.10; // 10% minimum even during launch

/**
 * Calculate a safe launch price (discounted but still profitable).
 */
function calcLaunchPrice(product) {
  const targetPrice = product.price;
  let launchPrice = parseFloat((targetPrice * (1 - LAUNCH_DISCOUNT)).toFixed(2));

  // Round to .99 pricing
  launchPrice = Math.floor(launchPrice) + 0.99;
  if (launchPrice >= targetPrice) launchPrice = targetPrice - 1.00;

  // Check margin floor
  const { margin } = calculateMargin(
    launchPrice,
    product.estimatedCOGS || product.price * 0.28,
    product.weightLbs || 1.0,
    product.category || ""
  );

  if (margin < MIN_LAUNCH_MARGIN * 100) {
    // Price floor: find lowest price with 10% margin
    // margin = (price - COGS - fees) / price >= 0.10
    // Approximate: price >= COGS / (1 - 0.10 - fee_rate)
    const feesRate = 0.35; // rough combined fee rate
    const floorPrice = Math.ceil(
      ((product.estimatedCOGS || product.price * 0.28) / (1 - MIN_LAUNCH_MARGIN - feesRate)) + 0.01
    );
    launchPrice = Math.max(launchPrice, floorPrice - 0.01);
    console.log(`[Launch] Price floor applied: $${launchPrice.toFixed(2)} (minimum margin protection)`);
  }

  return launchPrice;
}

/**
 * Send notification email when launch price is activated or ended.
 */
async function sendLaunchEmail(product, action, launchPrice, targetPrice) {
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL) return;

  const isStart = action === "start";

  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || "bot@yourdomain.com",
    to: process.env.ALERT_EMAIL,
    subject: isStart
      ? `Launch Price Activated — ${product.title?.slice(0, 40)}`
      : `Launch Complete — Price Restored to $${targetPrice.toFixed(2)}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;color:#222;">
        <div style="background:${isStart ? "#8e44ad" : "#27ae60"};color:white;padding:16px 24px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;">${isStart ? "Launch Price Active" : "Launch Complete"}</h2>
        </div>
        <div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
          <p><strong>Product:</strong> <a href="https://www.amazon.com/dp/${product.asin}" style="color:#0066c0;">${product.title?.slice(0, 80) || product.asin}</a></p>
          ${isStart ? `
            <p><strong>Launch Price:</strong> <span style="font-size:18px;color:#8e44ad;font-weight:bold;">$${launchPrice.toFixed(2)}</span> (was $${targetPrice.toFixed(2)})</p>
            <p><strong>Duration:</strong> ${LAUNCH_DURATION_DAYS} days</p>
            <p><strong>Discount:</strong> ${Math.round(LAUNCH_DISCOUNT * 100)}% off</p>
            <p><strong>Restores to:</strong> $${targetPrice.toFixed(2)} on ${new Date(Date.now() + LAUNCH_DURATION_DAYS * 86400000).toLocaleDateString()}</p>
            <div style="padding:12px;background:#f8f0ff;border-left:4px solid #8e44ad;border-radius:4px;font-size:13px;margin-top:16px;">
              Lower price drives early sales velocity → more reviews → Amazon ranks you higher → organic sales for life.
              The bot will automatically restore your price in ${LAUNCH_DURATION_DAYS} days.
            </div>
          ` : `
            <p><strong>Price restored to:</strong> <span style="font-size:18px;color:#27ae60;font-weight:bold;">$${targetPrice.toFixed(2)}</span></p>
            <p>Launch phase complete. Your ranking is now established — organic sales should continue at full margin.</p>
          `}
        </div>
      </div>
    `,
  });
}

/**
 * Activate launch price for newly listed products.
 * @param {object} product - product entry from DB (must have price, sku, asin)
 * @param {boolean} dryRun
 * @returns {object|null} launch record
 */
export async function activateLaunchPrice(product, dryRun = false) {
  if (!hasSpApiCredentials()) return null;
  if (!product.sku || !product.price) return null;
  if (product.launchPriceActive || product.launchCompleted) return null;

  const launchPrice = calcLaunchPrice(product);
  const targetPrice = product.price;

  if (Math.abs(launchPrice - targetPrice) < 0.50) {
    console.log(`[Launch] ${product.asin} — launch discount too small to be worthwhile`);
    return null;
  }

  console.log(`[Launch] Activating launch price for ${product.asin}: $${targetPrice.toFixed(2)} → $${launchPrice.toFixed(2)}`);

  if (!dryRun) {
    await updatePrice(product.sku, launchPrice);
  }

  const launchRecord = {
    launchPriceActive: true,
    launchPrice,
    launchTargetPrice: targetPrice,
    launchStartedAt: new Date().toISOString(),
    launchEndsAt: new Date(Date.now() + LAUNCH_DURATION_DAYS * 86400000).toISOString(),
  };

  if (!dryRun) {
    const db = loadDB();
    const idx = db.opportunities.findIndex((o) => o.asin === product.asin);
    if (idx !== -1) {
      db.opportunities[idx] = { ...db.opportunities[idx], ...launchRecord };
      saveDB(db);
    }

    try {
      await sendLaunchEmail(product, "start", launchPrice, targetPrice);
    } catch (err) {
      console.error("[Launch] Failed to send launch email:", err.message);
    }
  } else {
    console.log(`[Launch] DRY RUN — would set $${launchPrice.toFixed(2)} for ${LAUNCH_DURATION_DAYS} days`);
  }

  return launchRecord;
}

/**
 * Check all products with active launch prices — restore full price when the window ends.
 * @param {boolean} dryRun
 * @returns {Array} products that had their price restored
 */
export async function manageLaunchPrices(dryRun = false) {
  if (!hasSpApiCredentials()) {
    console.log("[Launch] SP-API credentials not set — skipping launch price management");
    return [];
  }

  console.log("[Launch] Managing launch prices...");

  const db = loadDB();
  const restored = [];
  const newLaunches = [];

  for (const product of db.opportunities || []) {
    // Restore price for expired launch windows
    if (product.launchPriceActive && product.launchEndsAt) {
      const endsAt = new Date(product.launchEndsAt).getTime();
      if (Date.now() >= endsAt) {
        console.log(`[Launch] ${product.asin} — launch complete, restoring price to $${product.launchTargetPrice?.toFixed(2)}`);

        if (!dryRun && product.sku && product.launchTargetPrice) {
          try {
            await updatePrice(product.sku, product.launchTargetPrice);
            await sendLaunchEmail(product, "end", product.launchPrice, product.launchTargetPrice);
          } catch (err) {
            console.error(`[Launch] Failed to restore price for ${product.asin}:`, err.message);
          }
        }

        const db2 = loadDB();
        const idx = db2.opportunities.findIndex((o) => o.asin === product.asin);
        if (idx !== -1) {
          db2.opportunities[idx] = {
            ...db2.opportunities[idx],
            launchPriceActive: false,
            launchCompleted: true,
            price: product.launchTargetPrice || product.price,
            launchCompletedAt: new Date().toISOString(),
          };
          saveDB(db2);
        }

        restored.push({ asin: product.asin, title: product.title, restoredPrice: product.launchTargetPrice });
      } else {
        const daysLeft = Math.ceil((endsAt - Date.now()) / 86400000);
        console.log(`[Launch] ${product.asin} — launch price active ($${product.launchPrice?.toFixed(2)}), ${daysLeft} days left`);
      }
      continue;
    }

    // Auto-activate launch price for newly launched products
    if (
      product.status === "launched" &&
      !product.launchPriceActive &&
      !product.launchCompleted &&
      product.listingSubmittedAt
    ) {
      const daysSinceLaunch = (Date.now() - new Date(product.listingSubmittedAt).getTime()) / 86400000;
      if (daysSinceLaunch <= 1) {
        // Product just launched in the last 24h — start launch price
        try {
          const record = await activateLaunchPrice(product, dryRun);
          if (record) newLaunches.push({ asin: product.asin, title: product.title, ...record });
        } catch (err) {
          console.error(`[Launch] Failed to activate launch price for ${product.asin}:`, err.message);
        }
      }
    }
  }

  console.log(`[Launch] Done — ${newLaunches.length} new launch prices activated, ${restored.length} restored to full price`);
  return { newLaunches, restored };
}
