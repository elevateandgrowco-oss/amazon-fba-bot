// inventory_reorder.js — Auto-calculate reorder points and email suppliers when stock runs low

import { Resend } from "resend";
import { getFBAInventory } from "./amazon_sp_api.js";
import { hasSpApiCredentials } from "./amazon_auth.js";
import { loadDB, saveDB } from "./products_db.js";

const resend = new Resend(process.env.RESEND_API_KEY);

// Default lead time in days if supplier hasn't been tracked
const DEFAULT_LEAD_TIME_DAYS = 30;

// Safety stock multiplier — order when this many days of stock remain
const SAFETY_STOCK_DAYS = 14;

// Minimum days of data needed before we can calculate velocity
const MIN_VELOCITY_DATA_DAYS = 7;

/**
 * Calculate daily sales velocity from order history stored in DB.
 * Returns units/day.
 */
function calcSalesVelocity(product) {
  const orders = product.recentOrders || [];
  if (orders.length === 0) {
    // Fall back to estimated monthly sales from BSR
    return Math.max(1, Math.round((product.estimatedMonthlySales || 30) / 30));
  }

  // Sum units from orders in the last 30 days
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentUnits = orders
    .filter((o) => new Date(o.purchaseDate).getTime() > cutoff)
    .reduce((sum, o) => sum + (o.quantityOrdered || 1), 0);

  return Math.max(1, recentUnits / 30);
}

/**
 * Build reorder email for a supplier.
 */
function buildReorderEmail(product, units, supplierEmail) {
  const sellerName = process.env.SELLER_NAME || "Our Brand";
  const companyName = process.env.COMPANY_NAME || "Our Company";

  return {
    from: process.env.RESEND_FROM_EMAIL || "bot@yourdomain.com",
    to: supplierEmail,
    subject: `Purchase Order — ${product.title?.slice(0, 50)} (Reorder)`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;color:#222;">
        <h2 style="color:#1a1a2e;">Purchase Order — Inventory Reorder</h2>
        <p>Hi,</p>
        <p>We'd like to place a reorder for the following product:</p>

        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          <tr style="background:#f5f5f5;">
            <td style="padding:10px;font-weight:bold;">Product</td>
            <td style="padding:10px;">${product.title?.slice(0, 100) || "N/A"}</td>
          </tr>
          <tr>
            <td style="padding:10px;font-weight:bold;">ASIN</td>
            <td style="padding:10px;">${product.asin}</td>
          </tr>
          <tr style="background:#f5f5f5;">
            <td style="padding:10px;font-weight:bold;">Units Requested</td>
            <td style="padding:10px;font-size:18px;font-weight:bold;color:#27ae60;">${units} units</td>
          </tr>
          <tr>
            <td style="padding:10px;font-weight:bold;">Target COGS/Unit</td>
            <td style="padding:10px;">$${(product.estimatedCOGS || 0).toFixed(2)}</td>
          </tr>
          <tr style="background:#f5f5f5;">
            <td style="padding:10px;font-weight:bold;">Required By</td>
            <td style="padding:10px;">${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString()}</td>
          </tr>
        </table>

        <p>Please confirm availability, pricing, and expected ship date.</p>
        <p>We ship FBA (Amazon Fulfillment Center) — please include FBA prep labels if available.</p>

        <p>Best regards,<br/><strong>${sellerName}</strong><br/>${companyName}</p>
      </div>
    `,
  };
}

/**
 * Check all launched products, calculate reorder points, and email suppliers if needed.
 * @param {boolean} dryRun
 * @returns {Array} list of reorder actions taken
 */
export async function checkReorderPoints(dryRun = false) {
  if (!hasSpApiCredentials()) {
    console.log("[Reorder] SP-API credentials not set — skipping inventory reorder check");
    return [];
  }

  console.log("[Reorder] Checking inventory levels and reorder points...");

  const db = loadDB();
  const reorderAlertedAsins = new Set(db.reorderAlertedAsins || []);

  // Get live FBA inventory
  let inventory = [];
  try {
    inventory = await getFBAInventory();
  } catch (err) {
    console.error("[Reorder] Failed to fetch FBA inventory:", err.message);
    return [];
  }

  // Build a map: SKU → units in FBA
  const stockBySku = {};
  for (const item of inventory) {
    const sku = item.sellerSku || item.sku;
    const units = item.totalQuantity || item.fulfillableQuantity || 0;
    if (sku) stockBySku[sku] = units;
  }

  const actions = [];

  // Only check products that are launched and have a SKU
  const launched = (db.opportunities || []).filter(
    (p) => p.status === "launched" && p.sku
  );

  console.log(`[Reorder] Checking ${launched.length} launched products`);

  for (const product of launched) {
    try {
      const currentStock = stockBySku[product.sku] ?? null;
      if (currentStock === null) {
        console.log(`[Reorder] No inventory data for SKU ${product.sku} — skipping`);
        continue;
      }

      const dailyVelocity = calcSalesVelocity(product);
      const leadTimeDays = product.supplierLeadTimeDays || DEFAULT_LEAD_TIME_DAYS;
      const reorderPoint = Math.ceil(dailyVelocity * (leadTimeDays + SAFETY_STOCK_DAYS));
      const reorderQty = Math.max(200, Math.ceil(dailyVelocity * 60)); // 60-day supply, min 200

      const daysOfStock = currentStock / dailyVelocity;

      console.log(`[Reorder] ${product.asin}: ${currentStock} units, ${dailyVelocity.toFixed(1)}/day, ${daysOfStock.toFixed(0)} days left, reorder point=${reorderPoint}`);

      // Update product with current stock data
      const updates = {
        currentStock,
        dailyVelocity,
        daysOfStock: Math.round(daysOfStock),
        reorderPoint,
        lastInventoryCheckAt: new Date().toISOString(),
      };

      if (currentStock <= reorderPoint) {
        // Check if we already sent a reorder alert recently (within 7 days)
        const lastAlertKey = `${product.asin}_${new Date().toISOString().slice(0, 10).slice(0, 7)}`; // month-level dedup
        if (reorderAlertedAsins.has(lastAlertKey)) {
          console.log(`[Reorder] ${product.asin} — already sent reorder alert this month`);
          continue;
        }

        console.log(`[Reorder] ${product.asin} — BELOW REORDER POINT (${currentStock} <= ${reorderPoint}) — ordering ${reorderQty} units`);

        // Find supplier email
        const supplierEmail = product.suppliers?.[0]?.email || null;

        if (supplierEmail && !dryRun) {
          try {
            const email = buildReorderEmail(product, reorderQty, supplierEmail);
            await resend.emails.send(email);
            console.log(`[Reorder] Reorder email sent to ${supplierEmail} for ${product.asin}`);
            reorderAlertedAsins.add(lastAlertKey);
          } catch (err) {
            console.error(`[Reorder] Failed to send reorder email for ${product.asin}:`, err.message);
          }
        } else if (dryRun) {
          console.log(`[Reorder] DRY RUN — would order ${reorderQty} units for ${product.asin} from ${supplierEmail || "no supplier"}`);
        } else {
          console.log(`[Reorder] ${product.asin} needs reorder but no supplier email found`);
        }

        actions.push({
          asin: product.asin,
          sku: product.sku,
          title: product.title?.slice(0, 60),
          currentStock,
          reorderPoint,
          reorderQty,
          dailyVelocity,
          daysOfStock: Math.round(daysOfStock),
          supplierEmailed: !!supplierEmail && !dryRun,
        });

        updates.lastReorderAlertAt = new Date().toISOString();
        updates.reorderQtyRequested = reorderQty;
      }

      // Save updated stock data
      const db2 = loadDB();
      const idx = db2.opportunities.findIndex((o) => o.asin === product.asin);
      if (idx !== -1) {
        db2.opportunities[idx] = { ...db2.opportunities[idx], ...updates };
        saveDB(db2);
      }
    } catch (err) {
      console.error(`[Reorder] Error checking ${product.asin}:`, err.message);
    }
  }

  // Save alerted ASINs
  if (!dryRun) {
    const db3 = loadDB();
    db3.reorderAlertedAsins = [...reorderAlertedAsins].slice(-200);
    saveDB(db3);
  }

  console.log(`[Reorder] Done — ${actions.length} products need reorder`);
  return actions;
}
