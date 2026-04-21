// suppression_detector.js — Detect suppressed/inactive listings before they cost you sales

import { Resend } from "resend";
import { getListingStatus } from "./amazon_sp_api.js";
import { hasSpApiCredentials } from "./amazon_auth.js";
import { loadDB, saveDB } from "./products_db.js";

const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Send urgent suppression alert email.
 */
async function sendSuppressionAlert(suppressed) {
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL) return;

  const rows = suppressed
    .map((p) => {
      const issueList = (p.issues || [])
        .slice(0, 3)
        .map((i) => `<li style="margin:4px 0;">${i.message || i.code}</li>`)
        .join("");

      return `
      <tr>
        <td style="padding:12px;font-size:13px;border-bottom:1px solid #eee;">
          <a href="https://www.amazon.com/dp/${p.asin}" style="color:#0066c0;font-weight:bold;">${p.title?.slice(0, 55) || p.asin}</a><br>
          <span style="font-size:11px;color:#888;">SKU: ${p.sku}</span>
        </td>
        <td style="padding:12px;font-size:13px;border-bottom:1px solid #eee;text-align:center;">
          <span style="background:#e74c3c;color:white;padding:3px 10px;border-radius:10px;font-size:12px;">${p.status}</span>
        </td>
        <td style="padding:12px;font-size:13px;border-bottom:1px solid #eee;">
          <ul style="margin:0;padding-left:16px;color:#555;">${issueList || "<li>No details — check Seller Central</li>"}</ul>
        </td>
      </tr>
    `;
    })
    .join("");

  await resend.emails.send({
    from: process.env.FROM_EMAIL || "bot@yourdomain.com",
    to: process.env.ALERT_EMAIL,
    subject: `URGENT: ${suppressed.length} Listing${suppressed.length > 1 ? "s" : ""} Suppressed — You're Not Selling`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:700px;color:#222;">
        <div style="background:#c0392b;color:white;padding:16px 24px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;">URGENT — Listing Suppressed</h2>
          <p style="margin:6px 0 0;opacity:0.9;font-size:14px;">You are NOT making sales on these products right now</p>
        </div>
        <div style="border:2px solid #c0392b;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:#f8f8f8;">
                <th style="padding:10px;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">Product</th>
                <th style="padding:10px;text-align:center;font-size:12px;text-transform:uppercase;color:#666;">Status</th>
                <th style="padding:10px;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">Issues</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:20px;padding:14px;background:#fff0f0;border-left:4px solid #e74c3c;border-radius:4px;font-size:13px;">
            <strong>Fix this now:</strong><br>
            1. Go to <a href="https://sellercentral.amazon.com/inventory" style="color:#c0392b;">Seller Central → Manage Inventory</a><br>
            2. Filter by "Suppressed" — Amazon shows you exactly what's missing<br>
            3. Common fixes: add missing attributes, update images (must be 1000px+), fix pricing errors<br>
            4. Most suppressions are fixed within 15 minutes once you add the missing data
          </div>
        </div>
      </div>
    `,
  });
}

/**
 * Check all active listings for suppression or critical issues.
 * Runs frequently so you catch problems within hours, not days.
 * @param {boolean} dryRun
 * @returns {Array} suppressed products
 */
export async function checkListingSuppression(dryRun = false) {
  if (!hasSpApiCredentials()) {
    console.log("[Suppression] SP-API credentials not set — skipping suppression check");
    return [];
  }

  console.log("[Suppression] Checking listing statuses...");

  const db = loadDB();
  const active = (db.opportunities || []).filter(
    (p) => p.sku && ["launched", "validating", "sourcing"].includes(p.status)
  );

  if (active.length === 0) {
    console.log("[Suppression] No active listings to check");
    return [];
  }

  console.log(`[Suppression] Checking ${active.length} listings`);

  const suppressed = [];
  const alertedThisRun = new Set();

  for (const product of active) {
    try {
      const { status, isSuppressed, issues } = await getListingStatus(product.sku);

      const updates = {
        listingStatus: status,
        listingIssues: issues,
        lastSuppressionCheckAt: new Date().toISOString(),
      };

      if (isSuppressed) {
        console.log(`[Suppression] SUPPRESSED: ${product.asin} (SKU: ${product.sku}) — status: ${status}`);
        updates.suppressedAt = product.suppressedAt || new Date().toISOString();

        // Only alert once per suppression event (not every run)
        const wasAlreadySuppressed = product.listingStatus === "SUPPRESSED";
        if (!wasAlreadySuppressed && !alertedThisRun.has(product.asin)) {
          suppressed.push({
            asin: product.asin,
            sku: product.sku,
            title: product.title,
            status,
            issues,
          });
          alertedThisRun.add(product.asin);
        }
      } else {
        console.log(`[Suppression] ${product.asin} — OK (${status})`);
        // Clear old suppression flag if resolved
        if (product.suppressedAt) {
          updates.suppressedAt = null;
          updates.suppressionResolvedAt = new Date().toISOString();
          console.log(`[Suppression] ${product.asin} — suppression resolved`);
        }
      }

      const db2 = loadDB();
      const idx = db2.opportunities.findIndex((o) => o.asin === product.asin);
      if (idx !== -1) {
        db2.opportunities[idx] = { ...db2.opportunities[idx], ...updates };
        saveDB(db2);
      }

      // SP-API rate limit
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`[Suppression] Error checking ${product.asin}:`, err.message);
    }
  }

  if (suppressed.length > 0 && !dryRun) {
    try {
      await sendSuppressionAlert(suppressed);
      console.log(`[Suppression] Urgent alert sent for ${suppressed.length} suppressed listing(s)`);
    } catch (err) {
      console.error("[Suppression] Failed to send alert:", err.message);
    }
  } else if (suppressed.length > 0 && dryRun) {
    console.log(`[Suppression] DRY RUN — ${suppressed.length} suppressed listings detected`);
  }

  console.log(`[Suppression] Done — ${suppressed.length} suppressed, ${active.length - suppressed.length} healthy`);
  return suppressed;
}
