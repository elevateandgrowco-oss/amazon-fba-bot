// account_health_monitor.js — Track seller account health metrics and alert before suspension

import { Resend } from "resend";
import { getRecentOrders, hasSpApiCredentials } from "./amazon_sp_api.js";
import { loadDB, saveDB } from "./products_db.js";

const resend = new Resend(process.env.RESEND_API_KEY);

// Amazon's official thresholds — suspension happens at these levels
const THRESHOLDS = {
  orderDefectRate: { danger: 0.0075, suspend: 0.01 },    // ODR: alert at 0.75%, suspend at 1%
  cancellationRate: { danger: 0.020, suspend: 0.025 },   // Pre-fulfillment cancel: alert 2%, suspend 2.5%
  lateShipmentRate: { danger: 0.030, suspend: 0.04 },    // Late shipment: alert 3%, suspend 4%
};

// FBA handles shipping so LSR is less relevant — focus on ODR for FBA sellers
// ODR = (negative feedback count + A-to-Z claims + chargebacks) / total orders in 60 days

/**
 * Classify orders to estimate defects.
 * A defect = order that was canceled (buyer-initiated), returned with complaint, or A-to-Z claim.
 * We estimate from order status since the full A-to-Z API requires special access.
 */
function calculateMetrics(orders) {
  const total = orders.length;
  if (total === 0) return null;

  // Count defect indicators from order status
  let defectCount = 0;
  let canceledByBuyer = 0;
  let pendingCount = 0;

  for (const order of orders) {
    const status = order.OrderStatus || "";
    const cancelReason = order.CancellationReason || "";

    // Buyer-canceled orders = potential defect
    if (status === "Canceled") {
      canceledByBuyer++;
      // Only count as defect if buyer initiated (not seller or Amazon)
      if (cancelReason !== "AMAZON" && cancelReason !== "SYSTEM") {
        defectCount++;
      }
    }

    if (status === "Pending") pendingCount++;
  }

  const shippedOrders = total - canceledByBuyer - pendingCount;
  const orderDefectRate = total > 0 ? defectCount / total : 0;
  const cancellationRate = total > 0 ? canceledByBuyer / total : 0;

  return {
    totalOrders: total,
    shippedOrders,
    defectCount,
    canceledByBuyer,
    orderDefectRate: parseFloat(orderDefectRate.toFixed(4)),
    cancellationRate: parseFloat(cancellationRate.toFixed(4)),
    // FBA handles shipping so late shipment rate is N/A
    lateShipmentRate: 0,
  };
}

/**
 * Evaluate which metrics are in danger or suspension territory.
 */
function evaluateHealth(metrics) {
  const issues = [];
  let overallStatus = "healthy"; // healthy | warning | danger | critical

  const checks = [
    { key: "orderDefectRate", label: "Order Defect Rate", format: (v) => `${(v * 100).toFixed(2)}%` },
    { key: "cancellationRate", label: "Cancellation Rate", format: (v) => `${(v * 100).toFixed(2)}%` },
    { key: "lateShipmentRate", label: "Late Shipment Rate", format: (v) => `${(v * 100).toFixed(2)}%` },
  ];

  for (const check of checks) {
    const value = metrics[check.key];
    const threshold = THRESHOLDS[check.key];
    if (!threshold || value === 0) continue;

    if (value >= threshold.suspend) {
      issues.push({
        metric: check.label,
        value: check.format(value),
        status: "critical",
        message: `ABOVE SUSPENSION THRESHOLD (${check.format(threshold.suspend)}) — act immediately`,
      });
      overallStatus = "critical";
    } else if (value >= threshold.danger) {
      issues.push({
        metric: check.label,
        value: check.format(value),
        status: "danger",
        message: `Approaching suspension threshold (${check.format(threshold.suspend)}) — investigate now`,
      });
      if (overallStatus !== "critical") overallStatus = "danger";
    }
  }

  return { overallStatus, issues };
}

/**
 * Send account health alert email.
 */
async function sendHealthAlert(metrics, evaluation) {
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL) return;

  const isCritical = evaluation.overallStatus === "critical";
  const headerColor = isCritical ? "#c0392b" : "#e67e22";
  const subject = isCritical
    ? "CRITICAL: Amazon Account At Risk of Suspension — Act Now"
    : "WARNING: Amazon Account Health Needs Attention";

  const issueRows = evaluation.issues
    .map(
      (i) => `
      <tr style="background:${i.status === "critical" ? "#fff0f0" : "#fffbf0"};">
        <td style="padding:10px;font-size:13px;font-weight:bold;">${i.metric}</td>
        <td style="padding:10px;font-size:13px;text-align:center;">
          <span style="color:${i.status === "critical" ? "#c0392b" : "#e67e22"};font-weight:bold;font-size:16px;">${i.value}</span>
        </td>
        <td style="padding:10px;font-size:13px;color:#555;">${i.message}</td>
      </tr>
    `
    )
    .join("");

  await resend.emails.send({
    from: process.env.FROM_EMAIL || "bot@yourdomain.com",
    to: process.env.ALERT_EMAIL,
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:700px;color:#222;">
        <div style="background:${headerColor};color:white;padding:16px 24px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;">${isCritical ? "CRITICAL" : "WARNING"} — Amazon Account Health</h2>
          <p style="margin:6px 0 0;opacity:0.9;font-size:14px;">
            ${isCritical ? "Your account is at immediate risk of suspension" : "One or more metrics are approaching Amazon's suspension thresholds"}
          </p>
        </div>
        <div style="border:2px solid ${headerColor};border-top:none;padding:20px;border-radius:0 0 8px 8px;">

          <!-- Health Score -->
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px;">
            <div style="text-align:center;padding:12px;background:#f8f8f8;border-radius:8px;">
              <div style="font-size:22px;font-weight:700;color:#1a1a2e;">${metrics.totalOrders}</div>
              <div style="font-size:12px;color:#888;margin-top:4px;">Orders (60 days)</div>
            </div>
            <div style="text-align:center;padding:12px;background:#f8f8f8;border-radius:8px;">
              <div style="font-size:22px;font-weight:700;color:${evaluation.overallStatus === "healthy" ? "#27ae60" : "#e74c3c"};">${(metrics.orderDefectRate * 100).toFixed(2)}%</div>
              <div style="font-size:12px;color:#888;margin-top:4px;">Order Defect Rate</div>
            </div>
            <div style="text-align:center;padding:12px;background:#f8f8f8;border-radius:8px;">
              <div style="font-size:22px;font-weight:700;color:#1a1a2e;">${metrics.defectCount}</div>
              <div style="font-size:12px;color:#888;margin-top:4px;">Defective Orders</div>
            </div>
          </div>

          <!-- Issues -->
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:#f8f8f8;">
                <th style="padding:8px;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">Metric</th>
                <th style="padding:8px;text-align:center;font-size:12px;text-transform:uppercase;color:#666;">Current</th>
                <th style="padding:8px;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">What To Do</th>
              </tr>
            </thead>
            <tbody>${issueRows}</tbody>
          </table>

          <div style="margin-top:20px;padding:14px;background:#fff8f0;border-left:4px solid ${headerColor};border-radius:4px;font-size:13px;">
            <strong>Quick actions:</strong><br>
            1. Go to <a href="https://sellercentral.amazon.com/performance/dashboard" style="color:${headerColor};">Seller Central → Account Health</a><br>
            2. Look at any open A-to-Z claims — resolve them immediately even if you refund<br>
            3. Check for negative feedback — you can request removal if policy-violating<br>
            4. Amazon measures ODR over a rolling 60-day window — improving today has immediate impact
          </div>
        </div>
      </div>
    `,
  });
}

/**
 * Check account health metrics and alert if approaching thresholds.
 * @param {boolean} dryRun
 * @returns {{ status, metrics, issues }}
 */
export async function checkAccountHealth(dryRun = false) {
  if (!hasSpApiCredentials()) {
    console.log("[Health] SP-API credentials not set — skipping account health check");
    return null;
  }

  console.log("[Health] Checking account health metrics (last 60 days)...");

  let orders = [];
  try {
    orders = await getRecentOrders(60);
  } catch (err) {
    console.error("[Health] Failed to fetch orders:", err.message);
    return null;
  }

  if (orders.length === 0) {
    console.log("[Health] No orders in last 60 days — nothing to measure");
    return null;
  }

  const metrics = calculateMetrics(orders);
  if (!metrics) return null;

  const evaluation = evaluateHealth(metrics);

  console.log(`[Health] Account status: ${evaluation.overallStatus.toUpperCase()}`);
  console.log(`[Health] ODR: ${(metrics.orderDefectRate * 100).toFixed(2)}% (threshold: 1%)`);
  console.log(`[Health] Cancel rate: ${(metrics.cancellationRate * 100).toFixed(2)}% (threshold: 2.5%)`);
  console.log(`[Health] Total orders: ${metrics.totalOrders}, Defects: ${metrics.defectCount}`);

  // Save to DB
  const db = loadDB();
  db.accountHealth = {
    ...metrics,
    overallStatus: evaluation.overallStatus,
    issues: evaluation.issues,
    checkedAt: new Date().toISOString(),
  };
  saveDB(db);

  // Alert if not healthy
  if (evaluation.overallStatus !== "healthy" && !dryRun) {
    try {
      await sendHealthAlert(metrics, evaluation);
      console.log(`[Health] Alert sent — status: ${evaluation.overallStatus}`);
    } catch (err) {
      console.error("[Health] Failed to send health alert:", err.message);
    }
  } else if (evaluation.overallStatus !== "healthy" && dryRun) {
    console.log(`[Health] DRY RUN — would alert on ${evaluation.overallStatus} status`);
  } else {
    console.log("[Health] Account is healthy — no alert needed");
  }

  return { status: evaluation.overallStatus, metrics, issues: evaluation.issues };
}
