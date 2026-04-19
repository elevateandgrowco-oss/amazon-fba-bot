// email_alerts.js — Resend email notifications for FBA bot events

import { Resend } from "resend";

const DRY_RUN = process.env.DRY_RUN === "true";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "FBA Bot <noreply@yourdomain.com>";
const ALERT_EMAIL = process.env.ALERT_EMAIL;

function getResend() {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not set");
  return new Resend(RESEND_API_KEY);
}

/**
 * Internal send helper — handles dry run and error logging.
 */
async function sendEmail({ subject, html, text }) {
  if (!ALERT_EMAIL) {
    console.warn("[Email] ALERT_EMAIL not set — skipping email");
    return { skipped: true, reason: "ALERT_EMAIL not set" };
  }

  if (DRY_RUN) {
    console.log(`[Email] DRY RUN — would send: "${subject}" to ${ALERT_EMAIL}`);
    return { skipped: true, reason: "dry run" };
  }

  try {
    const resend = getResend();
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: ALERT_EMAIL,
      subject,
      html,
    });
    console.log(`[Email] Sent: "${subject}" → ${ALERT_EMAIL}`);
    return result;
  } catch (err) {
    console.error(`[Email] Failed to send "${subject}":`, err.message);
    return { error: err.message };
  }
}

/**
 * Format a dollar amount.
 */
function usd(n) {
  return `$${(n || 0).toFixed(2)}`;
}

// ─── Opportunity Alert ────────────────────────────────────────────────────────

/**
 * Send a single "order this product" action email for the best validated opportunity.
 * @param {Array} products - Array of product objects — only the top 1 is shown
 */
export async function sendOpportunityAlert(products) {
  if (!products || products.length === 0) return;

  // Pick single best product by opportunity score
  const p = [...products].sort((a, b) => b.opportunityScore - a.opportunityScore)[0];

  const supplier = p.suppliers?.[0];
  const listing = p.listing;
  const orderQty = 200;
  const totalCost = supplier ? `~${usd((p.estimatedCOGS || p.price * 0.25) * orderQty)}` : "TBD";
  const monthlyProfit = usd((p.estimatedProfit || 0) * (p.estimatedMonthlySales || 100));

  const supplierSection = supplier
    ? `
    <div style="background:#f0fff4;border:1px solid #c0e8c0;border-radius:8px;padding:20px;margin-bottom:20px;">
      <h2 style="margin:0 0 12px;font-size:16px;color:#1a1a2e;">Step 2 — Order from Supplier</h2>
      <table style="font-size:14px;color:#333;width:100%;">
        <tr><td style="padding:4px 12px 4px 0;"><strong>Supplier:</strong></td><td>${escapeHtml(supplier.name || "")}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><strong>Price Range:</strong></td><td>${escapeHtml(supplier.priceRange || "")}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><strong>Min Order:</strong></td><td>${supplier.moq || 100} units</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><strong>Recommended Order:</strong></td><td>${orderQty} units</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><strong>Total Inventory Cost:</strong></td><td><strong>${totalCost}</strong></td></tr>
        ${supplier.url ? `<tr><td colspan="2" style="padding-top:10px;"><a href="${escapeHtml(supplier.url)}" style="background:#27ae60;color:white;padding:8px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Contact Supplier on Alibaba →</a></td></tr>` : ""}
      </table>
    </div>`
    : `<div style="background:#fffbf0;border:1px solid #f0dca0;border-radius:8px;padding:16px;margin-bottom:20px;font-size:14px;">No supplier found yet — search Alibaba for: <strong>${escapeHtml(p.title?.split(/[,|(]/)[0].trim() || "")}</strong></div>`;

  const listingSection = listing
    ? `
    <div style="background:#f8f9ff;border:1px solid #d0d8f8;border-radius:8px;padding:20px;margin-bottom:20px;">
      <h2 style="margin:0 0 12px;font-size:16px;color:#1a1a2e;">Step 3 — Your Amazon Listing (ready to paste)</h2>
      <p style="font-size:13px;color:#555;margin:0 0 12px;">This listing has already been submitted to your Amazon account automatically. No action needed.</p>
      <div style="background:white;border:1px solid #e0e0e0;border-radius:6px;padding:16px;font-size:13px;color:#333;">
        <p style="margin:0 0 8px;"><strong>Title:</strong> ${escapeHtml(listing.title || p.title || "")}</p>
        ${listing.bulletPoints?.length > 0 ? `<p style="margin:0 0 4px;"><strong>Bullet Points:</strong></p><ul style="margin:0 0 8px;padding-left:20px;">${listing.bulletPoints.map(b => `<li style="margin-bottom:4px;">${escapeHtml(b)}</li>`).join("")}</ul>` : ""}
        ${listing.keywords?.length > 0 ? `<p style="margin:0;"><strong>Keywords:</strong> ${escapeHtml(Array.isArray(listing.keywords) ? listing.keywords.join(", ") : listing.keywords)}</p>` : ""}
      </div>
    </div>`
    : "";

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">

      <!-- Header -->
      <div style="background:#1a1a2e;color:white;padding:24px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:24px;">Order This Product</h1>
        <p style="margin:8px 0 0;opacity:0.8;font-size:14px;">Your bot found a validated opportunity. Here's everything you need.</p>
      </div>

      <div style="padding:24px;background:#fff;border:1px solid #e0e0e0;border-top:0;border-radius:0 0 8px 8px;">

        <!-- Product -->
        <div style="background:#f9f9f9;border:1px solid #e0e0e0;border-radius:8px;padding:20px;margin-bottom:20px;">
          <h2 style="margin:0 0 4px;font-size:18px;color:#1a1a2e;">${escapeHtml(p.title?.slice(0, 80) || "Unknown Product")}</h2>
          <a href="https://www.amazon.com/dp/${p.asin}" style="color:#0066c0;font-size:13px;">View on Amazon →</a>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:14px;">
            <div style="background:white;border:1px solid #e0e0e0;border-radius:6px;padding:10px 16px;text-align:center;flex:1;min-width:100px;">
              <div style="font-size:22px;font-weight:700;color:#27ae60;">${monthlyProfit}</div>
              <div style="font-size:11px;color:#777;text-transform:uppercase;">Est. Monthly Profit</div>
            </div>
            <div style="background:white;border:1px solid #e0e0e0;border-radius:6px;padding:10px 16px;text-align:center;flex:1;min-width:100px;">
              <div style="font-size:22px;font-weight:700;color:#2980b9;">${p.margin || 0}%</div>
              <div style="font-size:11px;color:#777;text-transform:uppercase;">Margin</div>
            </div>
            <div style="background:white;border:1px solid #e0e0e0;border-radius:6px;padding:10px 16px;text-align:center;flex:1;min-width:100px;">
              <div style="font-size:22px;font-weight:700;color:#8e44ad;">${p.opportunityScore}/100</div>
              <div style="font-size:11px;color:#777;text-transform:uppercase;">Bot Score</div>
            </div>
            <div style="background:white;border:1px solid #e0e0e0;border-radius:6px;padding:10px 16px;text-align:center;flex:1;min-width:100px;">
              <div style="font-size:22px;font-weight:700;color:#f39c12;">${usd(p.price)}</div>
              <div style="font-size:11px;color:#777;text-transform:uppercase;">Sell Price</div>
            </div>
          </div>
        </div>

        <!-- Step 1 -->
        <div style="background:#f0f8ff;border:1px solid #c0d8f0;border-radius:8px;padding:20px;margin-bottom:20px;">
          <h2 style="margin:0 0 8px;font-size:16px;color:#1a1a2e;">Step 1 — Done ✅</h2>
          <p style="margin:0;font-size:14px;color:#555;">Listing has been submitted to your Amazon Seller Central automatically. PPC validation campaign is running.</p>
        </div>

        <!-- Step 2 — Supplier -->
        ${supplierSection}

        <!-- Step 3 — Listing -->
        ${listingSection}

        <!-- Step 4 -->
        <div style="background:#fff8f0;border:1px solid #f0d0a0;border-radius:8px;padding:20px;margin-bottom:20px;">
          <h2 style="margin:0 0 8px;font-size:16px;color:#1a1a2e;">Step 4 — Ship to Amazon</h2>
          <p style="margin:0;font-size:14px;color:#555;">Tell your supplier to ship directly to an Amazon FBA warehouse, or use a prep center (MyFBAPrep, ShipBob) to receive and forward the inventory. You never touch a box.</p>
        </div>

        <hr style="border:0;border-top:1px solid #eee;margin:20px 0;">
        <p style="font-size:12px;color:#888;margin:0;">Sent by your Amazon FBA Bot — ${new Date().toLocaleString()}</p>
      </div>
    </div>
  `;

  return sendEmail({
    subject: `Order This Product — ${escapeHtml(p.title?.slice(0, 50) || "New FBA Opportunity")}`,
    html,
  });
}

// ─── Competitor Alert ─────────────────────────────────────────────────────────

/**
 * Send alert for competitor changes (price drops, OOS, trending).
 * @param {Array} alerts - Array of alert objects from competitor_tracker
 */
export async function sendCompetitorAlert(alerts) {
  if (!alerts || alerts.length === 0) return;

  const alertTypeIcon = {
    price_drop: "Price Drop",
    competitor_oos: "Out of Stock",
    trending_up: "Trending Up",
    review_spike: "Review Spike",
  };

  const alertTypeColor = {
    price_drop: "#e74c3c",
    competitor_oos: "#27ae60",
    trending_up: "#2980b9",
    review_spike: "#f39c12",
  };

  const alertRows = alerts
    .map((a) => {
      const label = alertTypeIcon[a.type] || a.type;
      const color = alertTypeColor[a.type] || "#666";
      return `
      <tr>
        <td style="padding:10px;border-bottom:1px solid #eee;">
          <span style="background:${color};color:white;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:bold;">${label}</span>
        </td>
        <td style="padding:10px;border-bottom:1px solid #eee;font-size:13px;">
          ${escapeHtml(a.title?.slice(0, 60) || a.asin)}<br>
          <span style="color:#555;">${escapeHtml(a.message)}</span>
        </td>
        <td style="padding:10px;border-bottom:1px solid #eee;font-size:12px;">
          <a href="https://www.amazon.com/dp/${a.asin}" style="color:#0066c0;">View</a>
        </td>
      </tr>
    `;
    })
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">
      <div style="background:#2c3e50;color:white;padding:24px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:22px;">Competitor Alerts</h1>
        <p style="margin:8px 0 0;opacity:0.8;font-size:14px;">${alerts.length} alert${alerts.length !== 1 ? "s" : ""} detected</p>
      </div>
      <div style="padding:24px;background:#fff;border:1px solid #e0e0e0;border-top:0;border-radius:0 0 8px 8px;">
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="background:#f5f5f5;">
              <th style="padding:10px;text-align:left;font-size:12px;color:#555;">TYPE</th>
              <th style="padding:10px;text-align:left;font-size:12px;color:#555;">PRODUCT / EVENT</th>
              <th style="padding:10px;text-align:left;font-size:12px;color:#555;">LINK</th>
            </tr>
          </thead>
          <tbody>${alertRows}</tbody>
        </table>
        <p style="font-size:12px;color:#888;margin-top:24px;">Sent by Amazon FBA Bot</p>
      </div>
    </div>
  `;

  return sendEmail({
    subject: `FBA Bot: ${alerts.length} Competitor Alert${alerts.length !== 1 ? "s" : ""}`,
    html,
  });
}

// ─── Review Alert ─────────────────────────────────────────────────────────────

/**
 * Send alert for new negative reviews on tracked products.
 * @param {Array} alerts - Array of negative review alert objects
 */
export async function sendReviewAlert(alerts) {
  if (!alerts || alerts.length === 0) return;

  const reviewCards = alerts
    .map(
      (a) => `
    <div style="background:#fff8f8;border:1px solid #f5c6c6;border-radius:6px;padding:16px;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
        <strong style="font-size:14px;color:#1a1a2e;">${escapeHtml(a.title?.slice(0, 60) || a.asin)}</strong>
        <span style="background:#e74c3c;color:white;padding:2px 8px;border-radius:12px;font-size:12px;white-space:nowrap;margin-left:8px;">${a.reviewRating} Star${a.reviewRating !== 1 ? "s" : ""}</span>
      </div>
      <p style="margin:0 0 6px;font-size:14px;font-weight:bold;color:#c0392b;">"${escapeHtml(a.reviewTitle || "")}"</p>
      ${a.reviewBody ? `<p style="margin:0;font-size:13px;color:#555;">${escapeHtml(a.reviewBody.slice(0, 300))}${a.reviewBody.length > 300 ? "..." : ""}</p>` : ""}
      <div style="margin-top:8px;font-size:12px;color:#888;">${a.reviewDate || ""}</div>
      <a href="https://www.amazon.com/dp/${a.asin}" style="display:inline-block;margin-top:6px;color:#0066c0;font-size:12px;">View Product →</a>
    </div>
  `
    )
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">
      <div style="background:#c0392b;color:white;padding:24px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:22px;">Negative Review Alert</h1>
        <p style="margin:8px 0 0;opacity:0.9;font-size:14px;">${alerts.length} new negative review${alerts.length !== 1 ? "s" : ""} on tracked products</p>
      </div>
      <div style="padding:24px;background:#fff;border:1px solid #e0e0e0;border-top:0;border-radius:0 0 8px 8px;">
        ${reviewCards}
        <p style="font-size:12px;color:#888;margin-top:24px;">Sent by Amazon FBA Bot</p>
      </div>
    </div>
  `;

  return sendEmail({
    subject: `FBA Bot: ${alerts.length} New Negative Review${alerts.length !== 1 ? "s" : ""}`,
    html,
  });
}

// ─── Weekly Digest ────────────────────────────────────────────────────────────

/**
 * Send Sunday morning weekly digest.
 * @param {object} db - Full database
 */
export async function sendWeeklyDigest(db) {
  const total = db.opportunities.length;
  const tracked = db.opportunities.filter((o) => o.status !== "passed").length;
  const launched = db.opportunities.filter((o) => o.status === "launched").length;

  const byStatus = db.opportunities.reduce((acc, o) => {
    acc[o.status] = (acc[o.status] || 0) + 1;
    return acc;
  }, {});

  // Top performers by opportunity score
  const topByScore = [...db.opportunities]
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
    .slice(0, 5);

  // Best margin products
  const bestMargin = [...db.opportunities]
    .filter((o) => o.margin > 0)
    .sort((a, b) => b.margin - a.margin)
    .slice(0, 5);

  const topScoreRows = topByScore
    .map(
      (p) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px;">${escapeHtml(p.title?.slice(0, 55) || p.asin)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px;text-align:center;">${p.opportunityScore}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px;text-align:center;">${usd(p.price)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px;text-align:center;">${p.margin}%</td>
      <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px;text-align:center;">
        <a href="https://www.amazon.com/dp/${p.asin}" style="color:#0066c0;">View</a>
      </td>
    </tr>
  `
    )
    .join("");

  const bestMarginRows = bestMargin
    .map(
      (p) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px;">${escapeHtml(p.title?.slice(0, 55) || p.asin)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px;text-align:center;">${p.margin}%</td>
      <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px;text-align:center;">${usd(p.estimatedProfit)}/unit</td>
      <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px;text-align:center;">${usd(p.estimatedMonthlyRevenue)}/mo</td>
    </tr>
  `
    )
    .join("");

  const statusSummary = Object.entries(byStatus)
    .map(([status, count]) => `<span style="background:#eee;padding:2px 10px;border-radius:12px;font-size:13px;margin-right:6px;">${status}: <strong>${count}</strong></span>`)
    .join(" ");

  const weekLabel = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">
      <div style="background:#1a1a2e;color:white;padding:24px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:22px;">Weekly FBA Bot Digest</h1>
        <p style="margin:8px 0 0;opacity:0.8;font-size:14px;">Week ending ${weekLabel}</p>
      </div>
      <div style="padding:24px;background:#fff;border:1px solid #e0e0e0;border-top:0;border-radius:0 0 8px 8px;">

        <!-- Stats Row -->
        <div style="display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap;">
          <div style="flex:1;min-width:120px;background:#f0f8ff;border:1px solid #c0d8f0;border-radius:8px;padding:16px;text-align:center;">
            <div style="font-size:28px;font-weight:bold;color:#2980b9;">${total}</div>
            <div style="font-size:12px;color:#555;">Total Opportunities</div>
          </div>
          <div style="flex:1;min-width:120px;background:#f0fff4;border:1px solid #c0e8c0;border-radius:8px;padding:16px;text-align:center;">
            <div style="font-size:28px;font-weight:bold;color:#27ae60;">${tracked}</div>
            <div style="font-size:12px;color:#555;">Tracked Products</div>
          </div>
          <div style="flex:1;min-width:120px;background:#fffbf0;border:1px solid #f0dca0;border-radius:8px;padding:16px;text-align:center;">
            <div style="font-size:28px;font-weight:bold;color:#f39c12;">${launched}</div>
            <div style="font-size:12px;color:#555;">Launched</div>
          </div>
          <div style="flex:1;min-width:120px;background:#f8f8f8;border:1px solid #ddd;border-radius:8px;padding:16px;text-align:center;">
            <div style="font-size:28px;font-weight:bold;color:#555;">${db.totalScanned.toLocaleString()}</div>
            <div style="font-size:12px;color:#555;">Total Scanned</div>
          </div>
        </div>

        <!-- Status Breakdown -->
        <div style="margin-bottom:24px;">
          <h3 style="margin:0 0 10px;font-size:14px;color:#333;text-transform:uppercase;letter-spacing:0.5px;">Status Breakdown</h3>
          <div>${statusSummary}</div>
        </div>

        <!-- Top Opportunities -->
        ${topByScore.length > 0 ? `
        <div style="margin-bottom:24px;">
          <h3 style="margin:0 0 10px;font-size:14px;color:#333;text-transform:uppercase;letter-spacing:0.5px;">Top Opportunities by Score</h3>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:#f5f5f5;">
                <th style="padding:8px;text-align:left;font-size:12px;color:#555;">PRODUCT</th>
                <th style="padding:8px;text-align:center;font-size:12px;color:#555;">SCORE</th>
                <th style="padding:8px;text-align:center;font-size:12px;color:#555;">PRICE</th>
                <th style="padding:8px;text-align:center;font-size:12px;color:#555;">MARGIN</th>
                <th style="padding:8px;text-align:center;font-size:12px;color:#555;">LINK</th>
              </tr>
            </thead>
            <tbody>${topScoreRows}</tbody>
          </table>
        </div>
        ` : ""}

        <!-- Best Margin Products -->
        ${bestMargin.length > 0 ? `
        <div style="margin-bottom:24px;">
          <h3 style="margin:0 0 10px;font-size:14px;color:#333;text-transform:uppercase;letter-spacing:0.5px;">Best Margin Products</h3>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:#f5f5f5;">
                <th style="padding:8px;text-align:left;font-size:12px;color:#555;">PRODUCT</th>
                <th style="padding:8px;text-align:center;font-size:12px;color:#555;">MARGIN</th>
                <th style="padding:8px;text-align:center;font-size:12px;color:#555;">PROFIT/UNIT</th>
                <th style="padding:8px;text-align:center;font-size:12px;color:#555;">EST. MONTHLY</th>
              </tr>
            </thead>
            <tbody>${bestMarginRows}</tbody>
          </table>
        </div>
        ` : ""}

        <hr style="border:0;border-top:1px solid #eee;margin:24px 0;">
        <p style="font-size:12px;color:#888;margin:0;">
          Last research: ${db.lastResearchAt ? new Date(db.lastResearchAt).toLocaleString() : "Never"}<br>
          Last competitor check: ${db.lastCompetitorCheckAt ? new Date(db.lastCompetitorCheckAt).toLocaleString() : "Never"}<br>
          Last review check: ${db.lastReviewCheckAt ? new Date(db.lastReviewCheckAt).toLocaleString() : "Never"}<br><br>
          Sent by Amazon FBA Bot
        </p>
      </div>
    </div>
  `;

  return sendEmail({
    subject: `FBA Bot Weekly Digest — ${weekLabel}`,
    html,
  });
}

/**
 * Send single "order this product" email for the best validated product.
 * If multiple passed, picks the one with highest combined score + margin + monthly profit.
 */
export async function sendValidationSummary(passed, failed) {
  if (passed.length === 0) {
    // All failed — just log, no email needed
    console.log(`[Email] All ${failed.length} products failed validation — no email sent`);
    return;
  }

  // Pick the single best product using a composite score:
  // 60% validation score + 20% margin + 20% estimated monthly profit potential
  const best = [...passed].sort((a, b) => {
    const scoreA =
      (a.validationMetrics?.score || a.opportunityScore || 0) * 0.6 +
      (a.margin || 0) * 0.2 +
      Math.min((a.estimatedMonthlyRevenue || 0) / 100, 30) * 0.2;
    const scoreB =
      (b.validationMetrics?.score || b.opportunityScore || 0) * 0.6 +
      (b.margin || 0) * 0.2 +
      Math.min((b.estimatedMonthlyRevenue || 0) / 100, 30) * 0.2;
    return scoreB - scoreA;
  })[0];

  // Reuse the main order email format
  return sendOpportunityAlert([best]);
}

/**
 * Escape HTML special characters to prevent XSS in email templates.
 */
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
