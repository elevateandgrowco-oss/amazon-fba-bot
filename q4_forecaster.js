// q4_forecaster.js — Predict inventory needs for peak seasons so you never run out at the worst time

import { Resend } from "resend";
import { loadDB } from "./products_db.js";

const resend = new Resend(process.env.RESEND_API_KEY);

// Category-specific Q4 demand multipliers (relative to average month)
// Based on real Amazon seller data patterns
const Q4_MULTIPLIERS = {
  "Toys & Games":             4.5,
  "Home & Kitchen":           2.5,
  "Sports & Outdoors":        1.8,
  "Health & Household":       2.0,
  "Beauty & Personal Care":   2.2,
  "Office Products":          1.6,
  "Pet Supplies":             1.9,
  "Tools & Home Improvement": 2.0,
  "default":                  2.0,
};

// Seasonal peaks beyond Q4
const SEASONAL_EVENTS = [
  {
    name: "Valentine's Day",
    month: 2, // Feb
    orderByMonth: 1, // order by Jan
    multiplier: 1.8,
    categories: ["Beauty & Personal Care", "Toys & Games", "Home & Kitchen"],
  },
  {
    name: "Mother's Day",
    month: 5, // May
    orderByMonth: 3, // order by March
    multiplier: 2.0,
    categories: ["Beauty & Personal Care", "Home & Kitchen", "Health & Household"],
  },
  {
    name: "Prime Day",
    month: 7, // July
    orderByMonth: 5, // order by May
    multiplier: 2.5,
    categories: ["default"], // all categories
  },
  {
    name: "Q4 Holiday Season",
    month: 11, // Nov–Dec
    orderByMonth: 9, // order by September (FBA check-in by mid-Oct)
    multiplier: null, // uses category-specific Q4_MULTIPLIERS
    categories: ["default"],
    isMajor: true,
  },
  {
    name: "Back to School",
    month: 8, // Aug–Sep
    orderByMonth: 6, // order by June
    multiplier: 1.6,
    categories: ["Office Products", "Toys & Games", "Sports & Outdoors"],
  },
];

/**
 * Get the next upcoming seasonal event for a product category.
 */
function getUpcomingEvents(category) {
  const now = new Date();
  const currentMonth = now.getMonth() + 1; // 1-12

  return SEASONAL_EVENTS
    .filter((e) => {
      const appliesToCategory =
        e.categories.includes("default") || e.categories.includes(category);
      if (!appliesToCategory) return false;

      // Check if the order-by month is upcoming (within next 3 months)
      let monthsUntilOrderBy = e.orderByMonth - currentMonth;
      if (monthsUntilOrderBy < 0) monthsUntilOrderBy += 12;
      return monthsUntilOrderBy <= 3;
    })
    .map((e) => {
      const multiplier = e.multiplier || Q4_MULTIPLIERS[category] || Q4_MULTIPLIERS["default"];
      let monthsUntilOrderBy = e.orderByMonth - currentMonth;
      if (monthsUntilOrderBy < 0) monthsUntilOrderBy += 12;

      return { ...e, multiplier, monthsUntilOrderBy };
    })
    .sort((a, b) => a.monthsUntilOrderBy - b.monthsUntilOrderBy);
}

/**
 * Calculate how many units to order for a peak season.
 */
function calcSeasonalOrder(product, event) {
  const dailyVelocity = product.dailyVelocity || Math.max(1, (product.estimatedMonthlySales || 30) / 30);
  const currentStock = product.currentStock || 0;

  // Peak season typically lasts 6-8 weeks for major events, 3-4 for minor
  const peakDays = event.isMajor ? 60 : 28;
  const leadTimeDays = product.supplierLeadTimeDays || 30;
  const safetyBuffer = 14; // 2 weeks buffer

  const peakDailyVelocity = dailyVelocity * event.multiplier;
  const unitsNeededForPeak = Math.ceil(peakDailyVelocity * peakDays);
  const unitsNeededForLeadTime = Math.ceil(dailyVelocity * (leadTimeDays + safetyBuffer));

  const totalNeeded = unitsNeededForPeak + unitsNeededForLeadTime;
  const orderQty = Math.max(0, totalNeeded - currentStock);

  return {
    currentStock,
    unitsNeededForPeak,
    peakDailyVelocity: parseFloat(peakDailyVelocity.toFixed(1)),
    orderQty: Math.max(200, Math.ceil(orderQty / 50) * 50), // round up to nearest 50, min 200
    totalNeeded,
    estimatedRevenueDuringPeak: parseFloat((peakDailyVelocity * peakDays * (product.price || 0)).toFixed(2)),
  };
}

/**
 * Send seasonal forecast email.
 */
async function sendForecastEmail(forecasts) {
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL || forecasts.length === 0) return;

  const rows = forecasts.flatMap((f) =>
    f.events.map((e) => `
      <tr>
        <td style="padding:10px;font-size:13px;">
          <a href="https://www.amazon.com/dp/${f.asin}" style="color:#0066c0;">${f.title?.slice(0, 45) || f.asin}</a>
        </td>
        <td style="padding:10px;font-size:13px;font-weight:bold;color:${e.event.isMajor ? "#e74c3c" : "#f39c12"};">
          ${e.event.name}
        </td>
        <td style="padding:10px;font-size:13px;text-align:center;">Order by <strong>${new Date(new Date().setMonth(e.event.orderByMonth - 1)).toLocaleString("default", { month: "long" })}</strong></td>
        <td style="padding:10px;font-size:13px;text-align:center;font-weight:bold;color:#27ae60;">${e.orderQty.toLocaleString()} units</td>
        <td style="padding:10px;font-size:13px;text-align:center;">${e.event.multiplier.toFixed(1)}x</td>
        <td style="padding:10px;font-size:13px;text-align:center;color:#27ae60;">$${e.estimatedRevenueDuringPeak.toLocaleString()}</td>
      </tr>
    `)
  ).join("");

  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || "bot@yourdomain.com",
    to: process.env.ALERT_EMAIL,
    subject: `Seasonal Inventory Forecast — Action Required Before Peak Season`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:800px;color:#222;">
        <div style="background:#1a1a2e;color:white;padding:16px 24px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;">Seasonal Inventory Forecast</h2>
          <p style="margin:6px 0 0;opacity:0.9;font-size:14px;">Order now to avoid stockouts during peak sales periods</p>
        </div>
        <div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:#f8f8f8;">
                <th style="padding:8px;text-align:left;font-size:11px;text-transform:uppercase;color:#666;">Product</th>
                <th style="padding:8px;text-align:left;font-size:11px;text-transform:uppercase;color:#666;">Event</th>
                <th style="padding:8px;text-align:center;font-size:11px;text-transform:uppercase;color:#666;">Deadline</th>
                <th style="padding:8px;text-align:center;font-size:11px;text-transform:uppercase;color:#666;">Order Qty</th>
                <th style="padding:8px;text-align:center;font-size:11px;text-transform:uppercase;color:#666;">Demand Spike</th>
                <th style="padding:8px;text-align:center;font-size:11px;text-transform:uppercase;color:#666;">Est. Revenue</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:20px;padding:14px;background:#f0fff4;border-left:4px solid #27ae60;border-radius:4px;font-size:13px;">
            <strong>Q4 Reminder:</strong> Amazon FBA check-in deadline for Q4 is typically mid-October.
            Inventory must be AT Amazon's warehouse before then — account for your supplier's lead time.
            Running out of stock during Black Friday week can cost you your ranking permanently.
          </div>
        </div>
      </div>
    `,
  });
}

/**
 * Generate seasonal inventory forecasts for all launched products.
 * Runs monthly and whenever a major peak is approaching.
 * @param {boolean} dryRun
 * @returns {Array} forecasts with recommended order quantities
 */
export async function runSeasonalForecast(dryRun = false) {
  console.log("[Forecast] Running seasonal inventory forecast...");

  const db = loadDB();
  const launched = (db.opportunities || []).filter(
    (p) => p.status === "launched" && p.asin
  );

  if (launched.length === 0) {
    console.log("[Forecast] No launched products to forecast");
    return [];
  }

  const forecasts = [];

  for (const product of launched) {
    const events = getUpcomingEvents(product.category || "default");

    if (events.length === 0) {
      console.log(`[Forecast] ${product.asin} — no upcoming events in next 3 months`);
      continue;
    }

    const productForecasts = events.map((event) => {
      const { currentStock, orderQty, peakDailyVelocity, estimatedRevenueDuringPeak, totalNeeded } =
        calcSeasonalOrder(product, event);

      console.log(
        `[Forecast] ${product.asin} — ${event.name}: need ${orderQty} units by ${
          new Date(new Date().setMonth(event.orderByMonth - 1)).toLocaleString("default", { month: "long" })
        } (${event.multiplier}x demand)`
      );

      return {
        event,
        orderQty,
        peakDailyVelocity,
        estimatedRevenueDuringPeak,
        currentStock,
        totalNeeded,
      };
    });

    if (productForecasts.length > 0) {
      forecasts.push({
        asin: product.asin,
        title: product.title,
        category: product.category,
        events: productForecasts,
      });
    }
  }

  if (forecasts.length > 0 && !dryRun) {
    try {
      await sendForecastEmail(forecasts);
      console.log(`[Forecast] Forecast email sent for ${forecasts.length} product(s)`);
    } catch (err) {
      console.error("[Forecast] Failed to send forecast email:", err.message);
    }
  } else if (forecasts.length > 0 && dryRun) {
    console.log(`[Forecast] DRY RUN — ${forecasts.length} products have upcoming seasonal forecasts`);
  }

  console.log(`[Forecast] Done — forecasted ${forecasts.length} products across ${forecasts.reduce((s, f) => s + f.events.length, 0)} events`);
  return forecasts;
}
