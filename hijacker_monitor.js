// hijacker_monitor.js — Detect unauthorized sellers on your listings and buy box loss

import { Resend } from "resend";
import { getItemOffers, hasSpApiCredentials } from "./amazon_sp_api.js";
import { loadDB, saveDB } from "./products_db.js";

const resend = new Resend(process.env.RESEND_API_KEY);

const OUR_SELLER_ID = process.env.SP_API_SELLER_ID;

/**
 * Send an urgent email alert when a hijacker is detected or buy box is lost.
 */
async function sendHijackerAlert(alerts) {
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL) return;

  const rows = alerts
    .map(
      (a) => `
      <tr style="background:${a.type === "hijacker" ? "#fff3f3" : "#fffbf0"};">
        <td style="padding:10px;font-size:13px;">
          <a href="https://www.amazon.com/dp/${a.asin}" style="color:#0066c0;">${a.title?.slice(0, 55) || a.asin}</a>
        </td>
        <td style="padding:10px;font-size:13px;text-align:center;">
          <span style="background:${a.type === "hijacker" ? "#e74c3c" : "#f39c12"};color:white;padding:3px 10px;border-radius:10px;font-size:12px;">
            ${a.type === "hijacker" ? "HIJACKER" : "BUY BOX LOST"}
          </span>
        </td>
        <td style="padding:10px;font-size:13px;text-align:center;">${a.competitorCount} seller${a.competitorCount !== 1 ? "s" : ""}</td>
        <td style="padding:10px;font-size:13px;text-align:center;">$${a.lowestPrice?.toFixed(2) || "?"}</td>
        <td style="padding:10px;font-size:13px;color:#888;">${a.action}</td>
      </tr>
    `
    )
    .join("");

  await resend.emails.send({
    from: process.env.FROM_EMAIL || "bot@yourdomain.com",
    to: process.env.ALERT_EMAIL,
    subject: `ACTION REQUIRED: ${alerts.length} Amazon Listing Alert${alerts.length > 1 ? "s" : ""}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:700px;color:#222;">
        <div style="background:#e74c3c;color:white;padding:16px 20px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;">Amazon Listing Alert — Action Required</h2>
        </div>
        <div style="border:1px solid #e74c3c;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
          <p style="margin-top:0;">Your FBA bot detected ${alerts.length} listing issue${alerts.length > 1 ? "s" : ""} that need immediate attention:</p>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:#f8f8f8;">
                <th style="padding:8px;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">Product</th>
                <th style="padding:8px;text-align:center;font-size:12px;text-transform:uppercase;color:#666;">Issue</th>
                <th style="padding:8px;text-align:center;font-size:12px;text-transform:uppercase;color:#666;">Sellers</th>
                <th style="padding:8px;text-align:center;font-size:12px;text-transform:uppercase;color:#666;">Lowest Price</th>
                <th style="padding:8px;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">Recommended Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:20px;padding:12px;background:#fff3f3;border-radius:6px;font-size:13px;">
            <strong>What to do:</strong><br>
            For hijackers: Go to Seller Central → Brands → Report a Violation. File an IP complaint immediately.<br>
            For buy box loss: Check if your price is competitive, verify inventory levels, and review your seller metrics.
          </div>
        </div>
      </div>
    `,
  });
}

/**
 * Check all launched products for hijackers and buy box loss.
 * @param {boolean} dryRun
 * @returns {Array} list of alerts
 */
export async function checkHijackers(dryRun = false) {
  if (!hasSpApiCredentials()) {
    console.log("[Hijacker] SP-API credentials not set — skipping hijacker check");
    return [];
  }

  if (!OUR_SELLER_ID) {
    console.log("[Hijacker] SP_API_SELLER_ID not set — cannot identify our offers");
    return [];
  }

  console.log("[Hijacker] Scanning listings for hijackers and buy box loss...");

  const db = loadDB();
  const launched = (db.opportunities || []).filter(
    (p) => p.status === "launched" || p.status === "sourcing" || p.status === "validating"
  );

  console.log(`[Hijacker] Checking ${launched.length} products`);

  const alerts = [];

  for (const product of launched) {
    try {
      const { offers, buyBoxSellerId, lowestPrice, totalOfferCount } = await getItemOffers(product.asin);

      const weHaveBuyBox = buyBoxSellerId === OUR_SELLER_ID;
      const otherSellers = offers.filter((o) => o.sellerId !== OUR_SELLER_ID);
      const hasHijackers = otherSellers.length > 0;

      // Update product record
      const updates = {
        lastHijackerCheckAt: new Date().toISOString(),
        currentOfferCount: totalOfferCount,
        weHaveBuyBox,
        lowestCompetitorPrice: lowestPrice,
      };

      let alert = null;

      if (hasHijackers) {
        console.log(`[Hijacker] HIJACKER DETECTED on ${product.asin} — ${otherSellers.length} unauthorized seller(s)`);
        alert = {
          asin: product.asin,
          title: product.title,
          type: "hijacker",
          competitorCount: otherSellers.length,
          lowestPrice,
          weHaveBuyBox,
          action: "File IP violation in Seller Central immediately",
          detectedAt: new Date().toISOString(),
        };
        updates.hijackerDetectedAt = new Date().toISOString();
        updates.hijackerCount = otherSellers.length;
      } else if (!weHaveBuyBox && offers.length > 0) {
        console.log(`[Hijacker] BUY BOX LOST on ${product.asin} — winner: ${buyBoxSellerId}`);
        alert = {
          asin: product.asin,
          title: product.title,
          type: "buybox_lost",
          competitorCount: totalOfferCount,
          lowestPrice,
          weHaveBuyBox: false,
          action: "Check price competitiveness and inventory levels",
          detectedAt: new Date().toISOString(),
        };
        updates.buyBoxLostAt = new Date().toISOString();
      } else {
        console.log(`[Hijacker] ${product.asin} — OK (${totalOfferCount} offer(s), we have buy box)`);
      }

      if (alert) {
        alerts.push(alert);
      }

      // Save updated data
      const db2 = loadDB();
      const idx = db2.opportunities.findIndex((o) => o.asin === product.asin);
      if (idx !== -1) {
        db2.opportunities[idx] = { ...db2.opportunities[idx], ...updates };
        saveDB(db2);
      }

      // Rate limit — SP-API pricing endpoints are rate limited
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.error(`[Hijacker] Error checking ${product.asin}:`, err.message);
    }
  }

  if (alerts.length > 0 && !dryRun) {
    try {
      await sendHijackerAlert(alerts);
      console.log(`[Hijacker] Alert email sent for ${alerts.length} issue(s)`);
    } catch (err) {
      console.error("[Hijacker] Failed to send alert email:", err.message);
    }
  } else if (alerts.length > 0 && dryRun) {
    console.log(`[Hijacker] DRY RUN — would alert on ${alerts.length} issue(s)`);
  }

  console.log(`[Hijacker] Scan complete — ${alerts.length} issues found`);
  return alerts;
}
