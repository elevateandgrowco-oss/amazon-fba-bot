// return_monitor.js — Track FBA return rates and alert on high-return products

import { Resend } from "resend";
import { createReport, waitForReport, downloadReport } from "./amazon_sp_api.js";
import { hasSpApiCredentials } from "./amazon_auth.js";
import { loadDB, saveDB } from "./products_db.js";

const resend = new Resend(process.env.RESEND_API_KEY);

// Flag products with return rate above this threshold
const HIGH_RETURN_RATE_THRESHOLD = 0.08; // 8%
// Minimum orders needed before we trust the return rate data
const MIN_ORDERS_FOR_RATE = 10;

/**
 * Parse FBA returns report rows into per-ASIN return counts.
 * Returns: Map<asin, { returnCount, reasons: string[] }>
 */
function parseReturnsReport(rows) {
  const byAsin = new Map();

  for (const row of rows) {
    const asin = row["ASIN"] || row["asin"] || "";
    const reason = row["Reason"] || row["return-reason"] || row["reason"] || "";
    if (!asin) continue;

    if (!byAsin.has(asin)) {
      byAsin.set(asin, { returnCount: 0, reasons: [] });
    }

    const entry = byAsin.get(asin);
    entry.returnCount += 1;
    if (reason && !entry.reasons.includes(reason)) {
      entry.reasons.push(reason);
    }
  }

  return byAsin;
}

/**
 * Send high-return-rate alert email.
 */
async function sendReturnAlert(highReturnProducts) {
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL) return;

  const rows = highReturnProducts
    .map(
      (p) => `
      <tr>
        <td style="padding:10px;font-size:13px;">
          <a href="https://www.amazon.com/dp/${p.asin}" style="color:#0066c0;">${p.title?.slice(0, 55) || p.asin}</a>
        </td>
        <td style="padding:10px;font-size:13px;text-align:center;color:#e74c3c;font-weight:bold;">${(p.returnRate * 100).toFixed(1)}%</td>
        <td style="padding:10px;font-size:13px;text-align:center;">${p.returnCount} returns</td>
        <td style="padding:10px;font-size:13px;text-align:center;">${p.orderCount} orders</td>
        <td style="padding:10px;font-size:13px;color:#666;">${p.topReasons.slice(0, 2).join(", ") || "N/A"}</td>
      </tr>
    `
    )
    .join("");

  await resend.emails.send({
    from: process.env.FROM_EMAIL || "bot@yourdomain.com",
    to: process.env.ALERT_EMAIL,
    subject: `High Return Rate Alert — ${highReturnProducts.length} Product${highReturnProducts.length > 1 ? "s" : ""} Need Attention`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:700px;color:#222;">
        <div style="background:#e67e22;color:white;padding:16px 20px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;">High Return Rate Detected</h2>
        </div>
        <div style="border:1px solid #e67e22;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
          <p style="margin-top:0;">The following products have return rates above ${HIGH_RETURN_RATE_THRESHOLD * 100}%. High returns hurt your rankings and can trigger account review:</p>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:#f8f8f8;">
                <th style="padding:8px;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">Product</th>
                <th style="padding:8px;text-align:center;font-size:12px;text-transform:uppercase;color:#666;">Return Rate</th>
                <th style="padding:8px;text-align:center;font-size:12px;text-transform:uppercase;color:#666;">Returns</th>
                <th style="padding:8px;text-align:center;font-size:12px;text-transform:uppercase;color:#666;">Orders</th>
                <th style="padding:8px;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">Top Reasons</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:20px;padding:12px;background:#fff8f0;border-radius:6px;font-size:13px;">
            <strong>What to do:</strong><br>
            • Review return reasons — often a product defect, misleading photos, or size/dimension issue<br>
            • Update your listing photos and description to set accurate expectations<br>
            • Contact your supplier about quality control improvements<br>
            • Above 10% return rate, Amazon may flag your account
          </div>
        </div>
      </div>
    `,
  });
}

/**
 * Fetch FBA returns data, calculate per-product return rates, and alert on high rates.
 * @param {boolean} dryRun
 * @returns {Array} products with high return rates
 */
export async function checkReturnRates(dryRun = false) {
  if (!hasSpApiCredentials()) {
    console.log("[Returns] SP-API credentials not set — skipping return rate check");
    return [];
  }

  console.log("[Returns] Fetching FBA returns data...");

  const db = loadDB();
  const launched = (db.opportunities || []).filter(
    (p) => p.status === "launched"
  );

  if (launched.length === 0) {
    console.log("[Returns] No launched products to check");
    return [];
  }

  let returnsByAsin = new Map();

  try {
    // Request FBA customer returns report (last 30 days)
    const reportId = await createReport("GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA", 30);
    console.log(`[Returns] Report requested: ${reportId} — waiting for completion...`);

    const { status, reportDocumentId } = await waitForReport(reportId, 180000);

    if (status !== "DONE" || !reportDocumentId) {
      console.error(`[Returns] Report failed or timed out (status: ${status})`);
      return [];
    }

    const rows = await downloadReport(reportDocumentId);
    console.log(`[Returns] Downloaded ${rows.length} return records`);
    returnsByAsin = parseReturnsReport(rows);
  } catch (err) {
    console.error("[Returns] Failed to fetch returns report:", err.message);
    return [];
  }

  const highReturnProducts = [];

  for (const product of launched) {
    try {
      const returnData = returnsByAsin.get(product.asin) || { returnCount: 0, reasons: [] };
      const orderCount = product.recentOrderCount || product.estimatedMonthlySales || 0;

      // Need minimum orders for a meaningful return rate
      if (orderCount < MIN_ORDERS_FOR_RATE) continue;

      const returnRate = returnData.returnCount / orderCount;

      const updates = {
        returnCount: returnData.returnCount,
        returnRate: parseFloat(returnRate.toFixed(4)),
        topReturnReasons: returnData.reasons.slice(0, 5),
        lastReturnCheckAt: new Date().toISOString(),
      };

      // Save to DB
      const db2 = loadDB();
      const idx = db2.opportunities.findIndex((o) => o.asin === product.asin);
      if (idx !== -1) {
        db2.opportunities[idx] = { ...db2.opportunities[idx], ...updates };
        saveDB(db2);
      }

      if (returnRate >= HIGH_RETURN_RATE_THRESHOLD) {
        console.log(`[Returns] HIGH RETURN RATE: ${product.asin} — ${(returnRate * 100).toFixed(1)}% (${returnData.returnCount}/${orderCount})`);
        highReturnProducts.push({
          asin: product.asin,
          title: product.title,
          returnRate,
          returnCount: returnData.returnCount,
          orderCount,
          topReasons: returnData.reasons,
        });
      } else {
        console.log(`[Returns] ${product.asin} — ${(returnRate * 100).toFixed(1)}% return rate (OK)`);
      }
    } catch (err) {
      console.error(`[Returns] Error processing ${product.asin}:`, err.message);
    }
  }

  if (highReturnProducts.length > 0 && !dryRun) {
    try {
      await sendReturnAlert(highReturnProducts);
      console.log(`[Returns] Alert sent for ${highReturnProducts.length} high-return product(s)`);
    } catch (err) {
      console.error("[Returns] Failed to send return alert:", err.message);
    }
  } else if (highReturnProducts.length > 0 && dryRun) {
    console.log(`[Returns] DRY RUN — ${highReturnProducts.length} products have high return rates`);
  }

  console.log(`[Returns] Done — ${highReturnProducts.length} high-return products found`);
  return highReturnProducts;
}
