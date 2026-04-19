// pnl_tracker.js — Real profit & loss per product: revenue - COGS - FBA fees - PPC spend - storage

import { Resend } from "resend";
import { getSalesData, hasSpApiCredentials } from "./amazon_sp_api.js";
import { getCampaignMetrics, hasAdsCredentials } from "./ppc_manager.js";
import { calculateFBAFees } from "./fee_calculator.js";
import { loadDB, saveDB } from "./products_db.js";

const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Calculate real P&L for all launched products over the last 30 days.
 * @returns {Array} per-product P&L with totals
 */
async function calculatePnL() {
  const db = loadDB();
  const launched = (db.opportunities || []).filter(
    (p) => p.status === "launched" && p.asin
  );

  if (launched.length === 0) return [];

  // Fetch real sales data from SP-API
  let salesData = [];
  if (hasSpApiCredentials()) {
    try {
      salesData = await getSalesData(30);
    } catch (err) {
      console.error("[PnL] Failed to fetch sales data:", err.message);
    }
  }

  // Group sales by ASIN
  const salesByAsin = {};
  for (const sale of salesData) {
    if (!salesByAsin[sale.asin]) {
      salesByAsin[sale.asin] = { revenue: 0, unitsSold: 0, orders: 0 };
    }
    salesByAsin[sale.asin].revenue += sale.revenue;
    salesByAsin[sale.asin].unitsSold += sale.qty;
    salesByAsin[sale.asin].orders += 1;
  }

  // Fetch PPC spend per campaign
  const ppcSpendByAsin = {};
  if (hasAdsCredentials()) {
    for (const product of launched) {
      const campaignIds = [product.launchCampaignId, product.validationCampaignId].filter(Boolean);
      let totalSpend = 0;
      for (const campaignId of campaignIds) {
        try {
          const metrics = await getCampaignMetrics(campaignId);
          if (metrics) totalSpend += metrics.spend || 0;
        } catch {}
      }
      if (totalSpend > 0) ppcSpendByAsin[product.asin] = totalSpend;
    }
  }

  const results = [];

  for (const product of launched) {
    const sales = salesByAsin[product.asin] || { revenue: 0, unitsSold: 0, orders: 0 };
    const ppcSpend = ppcSpendByAsin[product.asin] || 0;

    const revenue = sales.revenue;
    const unitsSold = sales.unitsSold;

    // COGS — use actual if tracked, else estimate
    const cogsPerUnit = product.actualCOGS || product.estimatedCOGS || (product.price * 0.28);
    const totalCOGS = cogsPerUnit * unitsSold;

    // FBA fees — use actual if tracked, else recalculate
    const weightLbs = product.weightLbs || 1.0;
    const { referralFee, fulfillmentFee, storageFee } = calculateFBAFees(
      product.price || 0,
      weightLbs,
      product.category || ""
    );
    const totalFBAFees = (referralFee + fulfillmentFee + storageFee) * unitsSold;

    // Amazon referral fee (already included in FBA fees above for FBA products)
    const grossProfit = revenue - totalCOGS - totalFBAFees - ppcSpend;
    const netMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
    const roiOnCOGS = totalCOGS > 0 ? (grossProfit / totalCOGS) * 100 : 0;
    const acos = ppcSpend > 0 && revenue > 0 ? (ppcSpend / revenue) * 100 : 0;

    const productPnL = {
      asin: product.asin,
      title: product.title?.slice(0, 60),
      period: "last_30_days",
      revenue: parseFloat(revenue.toFixed(2)),
      unitsSold,
      orders: sales.orders,
      totalCOGS: parseFloat(totalCOGS.toFixed(2)),
      totalFBAFees: parseFloat(totalFBAFees.toFixed(2)),
      ppcSpend: parseFloat(ppcSpend.toFixed(2)),
      grossProfit: parseFloat(grossProfit.toFixed(2)),
      netMargin: parseFloat(netMargin.toFixed(1)),
      roiOnCOGS: parseFloat(roiOnCOGS.toFixed(1)),
      acos: parseFloat(acos.toFixed(1)),
      profitPerUnit: unitsSold > 0 ? parseFloat((grossProfit / unitsSold).toFixed(2)) : 0,
      calculatedAt: new Date().toISOString(),
    };

    results.push(productPnL);

    // Save to DB
    const db2 = loadDB();
    const idx = db2.opportunities.findIndex((o) => o.asin === product.asin);
    if (idx !== -1) {
      db2.opportunities[idx] = {
        ...db2.opportunities[idx],
        pnl: productPnL,
        recentOrderCount: sales.orders,
      };
      saveDB(db2);
    }
  }

  return results.sort((a, b) => b.grossProfit - a.grossProfit);
}

/**
 * Send weekly P&L summary email.
 */
async function sendPnLReport(results) {
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL) return;

  const totalRevenue = results.reduce((s, p) => s + p.revenue, 0);
  const totalProfit = results.reduce((s, p) => s + p.grossProfit, 0);
  const totalPPCSpend = results.reduce((s, p) => s + p.ppcSpend, 0);
  const totalUnits = results.reduce((s, p) => s + p.unitsSold, 0);

  const rows = results
    .map((p) => {
      const profitColor = p.grossProfit >= 0 ? "#27ae60" : "#e74c3c";
      return `
      <tr>
        <td style="padding:10px;font-size:13px;">
          <a href="https://www.amazon.com/dp/${p.asin}" style="color:#0066c0;">${p.title || p.asin}</a>
        </td>
        <td style="padding:10px;font-size:13px;text-align:right;">$${p.revenue.toFixed(2)}</td>
        <td style="padding:10px;font-size:13px;text-align:right;">$${p.totalCOGS.toFixed(2)}</td>
        <td style="padding:10px;font-size:13px;text-align:right;">$${p.totalFBAFees.toFixed(2)}</td>
        <td style="padding:10px;font-size:13px;text-align:right;">$${p.ppcSpend.toFixed(2)}</td>
        <td style="padding:10px;font-size:13px;text-align:right;font-weight:bold;color:${profitColor};">$${p.grossProfit.toFixed(2)}</td>
        <td style="padding:10px;font-size:13px;text-align:center;color:${profitColor};">${p.netMargin.toFixed(1)}%</td>
        <td style="padding:10px;font-size:13px;text-align:center;">${p.unitsSold}</td>
      </tr>
    `;
    })
    .join("");

  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || "bot@yourdomain.com",
    to: process.env.ALERT_EMAIL,
    subject: `Weekly P&L Report — $${totalProfit.toFixed(2)} profit on $${totalRevenue.toFixed(2)} revenue`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:800px;color:#222;">
        <div style="background:#1a1a2e;color:white;padding:16px 24px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;">Weekly P&L Report (Last 30 Days)</h2>
        </div>
        <div style="border:1px solid #ddd;border-top:none;border-radius:0 0 8px 8px;overflow:hidden;">

          <!-- Summary Stats -->
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0;border-bottom:1px solid #eee;">
            <div style="padding:16px;text-align:center;border-right:1px solid #eee;">
              <div style="font-size:26px;font-weight:700;color:#2980b9;">$${totalRevenue.toFixed(0)}</div>
              <div style="font-size:12px;color:#888;margin-top:4px;text-transform:uppercase;">Revenue</div>
            </div>
            <div style="padding:16px;text-align:center;border-right:1px solid #eee;">
              <div style="font-size:26px;font-weight:700;color:${totalProfit >= 0 ? "#27ae60" : "#e74c3c"};">$${totalProfit.toFixed(0)}</div>
              <div style="font-size:12px;color:#888;margin-top:4px;text-transform:uppercase;">Net Profit</div>
            </div>
            <div style="padding:16px;text-align:center;border-right:1px solid #eee;">
              <div style="font-size:26px;font-weight:700;color:#e67e22;">$${totalPPCSpend.toFixed(0)}</div>
              <div style="font-size:12px;color:#888;margin-top:4px;text-transform:uppercase;">Ad Spend</div>
            </div>
            <div style="padding:16px;text-align:center;">
              <div style="font-size:26px;font-weight:700;color:#8e44ad;">${totalUnits}</div>
              <div style="font-size:12px;color:#888;margin-top:4px;text-transform:uppercase;">Units Sold</div>
            </div>
          </div>

          <!-- Per-Product Table -->
          <div style="padding:20px;">
            <table style="width:100%;border-collapse:collapse;">
              <thead>
                <tr style="background:#f8f8f8;">
                  <th style="padding:8px;text-align:left;font-size:11px;text-transform:uppercase;color:#666;">Product</th>
                  <th style="padding:8px;text-align:right;font-size:11px;text-transform:uppercase;color:#666;">Revenue</th>
                  <th style="padding:8px;text-align:right;font-size:11px;text-transform:uppercase;color:#666;">COGS</th>
                  <th style="padding:8px;text-align:right;font-size:11px;text-transform:uppercase;color:#666;">FBA Fees</th>
                  <th style="padding:8px;text-align:right;font-size:11px;text-transform:uppercase;color:#666;">PPC</th>
                  <th style="padding:8px;text-align:right;font-size:11px;text-transform:uppercase;color:#666;">Profit</th>
                  <th style="padding:8px;text-align:center;font-size:11px;text-transform:uppercase;color:#666;">Margin</th>
                  <th style="padding:8px;text-align:center;font-size:11px;text-transform:uppercase;color:#666;">Units</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
              <tfoot>
                <tr style="background:#f0f0f0;font-weight:bold;">
                  <td style="padding:10px;font-size:13px;">TOTAL</td>
                  <td style="padding:10px;font-size:13px;text-align:right;">$${totalRevenue.toFixed(2)}</td>
                  <td style="padding:10px;font-size:13px;text-align:right;">$${results.reduce((s, p) => s + p.totalCOGS, 0).toFixed(2)}</td>
                  <td style="padding:10px;font-size:13px;text-align:right;">$${results.reduce((s, p) => s + p.totalFBAFees, 0).toFixed(2)}</td>
                  <td style="padding:10px;font-size:13px;text-align:right;">$${totalPPCSpend.toFixed(2)}</td>
                  <td style="padding:10px;font-size:13px;text-align:right;color:${totalProfit >= 0 ? "#27ae60" : "#e74c3c"};">$${totalProfit.toFixed(2)}</td>
                  <td style="padding:10px;font-size:13px;text-align:center;">${totalRevenue > 0 ? ((totalProfit / totalRevenue) * 100).toFixed(1) : 0}%</td>
                  <td style="padding:10px;font-size:13px;text-align:center;">${totalUnits}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>
    `,
  });
}

/**
 * Run P&L calculation and send weekly report.
 * @param {boolean} dryRun
 * @returns {Array} per-product P&L results
 */
export async function runPnLReport(dryRun = false) {
  console.log("[PnL] Calculating profit & loss for all products...");

  const results = await calculatePnL();

  if (results.length === 0) {
    console.log("[PnL] No launched products with data — skipping report");
    return [];
  }

  const totalProfit = results.reduce((s, p) => s + p.grossProfit, 0);
  const totalRevenue = results.reduce((s, p) => s + p.revenue, 0);
  console.log(`[PnL] Total: $${totalRevenue.toFixed(2)} revenue, $${totalProfit.toFixed(2)} net profit across ${results.length} products`);

  if (!dryRun) {
    try {
      await sendPnLReport(results);
      console.log("[PnL] P&L report email sent");
    } catch (err) {
      console.error("[PnL] Failed to send P&L report:", err.message);
    }
  } else {
    console.log("[PnL] DRY RUN — skipping P&L email");
  }

  return results;
}
