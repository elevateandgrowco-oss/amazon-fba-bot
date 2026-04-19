// review_requester.js — Auto-request reviews after confirmed delivery via SP-API

import { getRecentOrders, requestReview } from "./amazon_sp_api.js";
import { hasSpApiCredentials } from "./amazon_auth.js";
import { loadDB, saveDB } from "./products_db.js";

/**
 * Request reviews for all eligible recent orders.
 * Amazon only allows review requests between 5-30 days after delivery.
 * @param {boolean} dryRun
 * @returns {number} count of review requests sent
 */
export async function requestPendingReviews(dryRun = false) {
  if (!hasSpApiCredentials()) {
    console.log("[Reviews] SP-API credentials not set — skipping review requests");
    return 0;
  }

  console.log("[Reviews] Checking for review request opportunities...");

  const db = loadDB();
  const reviewedOrders = new Set(db.reviewRequestedOrderIds || []);

  // Get orders from last 25 days (5-30 day window for review requests)
  const orders = await getRecentOrders(25);

  const eligible = orders.filter((order) => {
    if (reviewedOrders.has(order.AmazonOrderId)) return false;
    if (order.OrderStatus !== "Shipped" && order.OrderStatus !== "Delivered") return false;

    // Check order is at least 5 days old
    const orderDate = new Date(order.PurchaseDate);
    const daysSinceOrder = (Date.now() - orderDate.getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceOrder >= 5;
  });

  console.log(`[Reviews] ${eligible.length} orders eligible for review request`);

  let sent = 0;

  for (const order of eligible) {
    try {
      if (!dryRun) {
        await requestReview(order.AmazonOrderId);
        reviewedOrders.add(order.AmazonOrderId);
        sent++;
        console.log(`[Reviews] Review requested for order ${order.AmazonOrderId}`);
      } else {
        console.log(`[Reviews] DRY RUN — would request review for order ${order.AmazonOrderId}`);
        sent++;
      }

      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.error(`[Reviews] Failed to request review for ${order.AmazonOrderId}:`, err.message);
    }
  }

  // Save reviewed order IDs to avoid duplicate requests
  if (!dryRun && sent > 0) {
    db.reviewRequestedOrderIds = Array.from(reviewedOrders);
    saveDB(db);
  }

  console.log(`[Reviews] Review requests sent: ${sent}`);
  return sent;
}
