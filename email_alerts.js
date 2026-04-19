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
 * Send alert when new high-score FBA opportunities are found.
 * @param {Array} products - Array of product objects (top 3 shown)
 */
export async function sendOpportunityAlert(products) {
  if (!products || products.length === 0) return;

  const top3 = products.slice(0, 3);

  const productCards = top3
    .map(
      (p) => `
    <div style="background:#f9f9f9;border:1px solid #e0e0e0;border-radius:8px;padding:20px;margin-bottom:16px;">
      <h3 style="margin:0 0 8px;color:#1a1a2e;font-size:16px;">${escapeHtml(p.title?.slice(0, 80) || "Unknown Product")}</h3>
      <table style="width:100%;font-size:14px;color:#333;">
        <tr>
          <td style="padding:3px 8px 3px 0;"><strong>Score:</strong></td>
          <td style="padding:3px 0;">${p.opportunityScore}/100</td>
          <td style="padding:3px 8px 3px 16px;"><strong>ASIN:</strong></td>
          <td style="padding:3px 0;font-family:monospace;">${p.asin}</td>
        </tr>
        <tr>
          <td style="padding:3px 8px 3px 0;"><strong>Price:</strong></td>
          <td style="padding:3px 0;">${usd(p.price)}</td>
          <td style="padding:3px 8px 3px 16px;"><strong>BSR:</strong></td>
          <td style="padding:3px 0;">#${(p.bsr || 0).toLocaleString()}</td>
        </tr>
        <tr>
          <td style="padding:3px 8px 3px 0;"><strong>Est. Monthly Revenue:</strong></td>
          <td style="padding:3px 0;">${usd(p.estimatedMonthlyRevenue)}</td>
          <td style="padding:3px 8px 3px 16px;"><strong>Margin:</strong></td>
          <td style="padding:3px 0;">${p.margin}%</td>
        </tr>
        <tr>
          <td style="padding:3px 8px 3px 0;"><strong>Reviews:</strong></td>
          <td style="padding:3px 0;">${(p.reviews || 0).toLocaleString()}</td>
          <td style="padding:3px 8px 3px 16px;"><strong>Rating:</strong></td>
          <td style="padding:3px 0;">${p.rating}/5</td>
        </tr>
        ${
          p.suppliers && p.suppliers.length > 0
            ? `<tr>
          <td style="padding:3px 8px 3px 0;"><strong>Top Supplier:</strong></td>
          <td colspan="3" style="padding:3px 0;">${escapeHtml(p.suppliers[0].name || "")} — ${escapeHtml(p.suppliers[0].priceRange || "")} (MOQ: ${p.suppliers[0].moq})</td>
        </tr>`
            : ""
        }
      </table>
      <a href="https://www.amazon.com/dp/${p.asin}" style="display:inline-block;margin-top:10px;color:#0066c0;font-size:13px;">View on Amazon →</a>
    </div>
  `
    )
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">
      <div style="background:#1a1a2e;color:white;padding:24px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:22px;">New FBA Opportunities Found</h1>
        <p style="margin:8px 0 0;opacity:0.8;font-size:14px;">${products.length} new product${products.length !== 1 ? "s" : ""} identified — showing top ${top3.length}</p>
      </div>
      <div style="padding:24px;background:#fff;border:1px solid #e0e0e0;border-top:0;border-radius:0 0 8px 8px;">
        ${productCards}
        <p style="font-size:12px;color:#888;margin-top:24px;">Sent by Amazon FBA Bot</p>
      </div>
    </div>
  `;

  return sendEmail({
    subject: `FBA Bot: ${products.length} New Opportunit${products.length !== 1 ? "ies" : "y"} Found`,
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
