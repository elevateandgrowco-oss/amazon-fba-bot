// amazon_sp_api.js — Amazon SP-API: listings, orders, messages, inventory

import axios from "axios";
import { getSpApiToken, hasSpApiCredentials } from "./amazon_auth.js";
export { hasSpApiCredentials };

const SP_API_BASE = "https://sellingpartnerapi-na.amazon.com";
const MARKETPLACE_ID = process.env.SP_API_MARKETPLACE_ID || "ATVPDKIKX0DER"; // US default
const SELLER_ID = process.env.SP_API_SELLER_ID;

// Amazon SP-API requires array params as repeated keys (not key[]=val)
function serializeParams(params) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    } else if (value !== undefined && value !== null) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join("&");
}

async function spRequest({ method = "GET", path, params = {}, data = null }) {
  if (!hasSpApiCredentials()) {
    throw new Error("SP-API credentials not configured");
  }

  const token = await getSpApiToken();

  const res = await axios({
    method,
    url: `${SP_API_BASE}${path}`,
    headers: {
      "x-amz-access-token": token,
      "Content-Type": "application/json",
    },
    params,
    paramsSerializer: { serialize: serializeParams },
    data,
    timeout: 15000,
  });

  return res.data;
}

// ─── Listings ─────────────────────────────────────────────────────────────────

/**
 * Create or update a product listing.
 * @param {string} sku - Your seller SKU
 * @param {object} listing - { title, description, bulletPoints, keywords, price, images }
 * @returns {object} SP-API response
 */
export async function createListing(sku, listing) {
  console.log(`[SP-API] Creating listing for SKU: ${sku}`);

  // Build image attributes from supplier images
  const imageAttributes = {};
  const images = (listing.images || []).filter(
    (url) => url && typeof url === "string" && url.startsWith("http")
  );

  if (images.length > 0) {
    imageAttributes.main_product_image_locator = [
      { media_location: images[0], marketplace_id: MARKETPLACE_ID },
    ];
    images.slice(1, 8).forEach((imgUrl, i) => {
      imageAttributes[`other_product_image_locator_${i + 1}`] = [
        { media_location: imgUrl, marketplace_id: MARKETPLACE_ID },
      ];
    });
    console.log(`[SP-API] Submitting ${images.length} product image(s) for SKU ${sku}`);
  }

  const body = {
    productType: "PRODUCT",
    requirements: "LISTING",
    attributes: {
      item_name: [{ value: listing.title, marketplace_id: MARKETPLACE_ID }],
      product_description: [{ value: listing.description, marketplace_id: MARKETPLACE_ID }],
      bullet_point: listing.bulletPoints.map((bp) => ({
        value: bp,
        marketplace_id: MARKETPLACE_ID,
      })),
      generic_keyword: [{ value: listing.keywords?.join(" "), marketplace_id: MARKETPLACE_ID }],
      fulfillment_availability: [
        {
          fulfillment_channel_code: "AMAZON_NA",
          quantity: listing.quantity ?? 0,
          marketplace_id: MARKETPLACE_ID,
        },
      ],
      purchasable_offer: [
        {
          currency: "USD",
          our_price: [{ schedule: [{ value_with_tax: listing.price }] }],
          marketplace_id: MARKETPLACE_ID,
        },
      ],
      ...imageAttributes,
    },
  };

  return spRequest({
    method: "PUT",
    path: `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(sku)}`,
    params: { marketplaceIds: MARKETPLACE_ID },
    data: body,
  });
}

/**
 * Update inventory quantity for a SKU.
 */
export async function updateInventory(sku, quantity) {
  console.log(`[SP-API] Updating inventory: SKU=${sku} qty=${quantity}`);
  return spRequest({
    method: "PATCH",
    path: `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(sku)}`,
    params: { marketplaceIds: MARKETPLACE_ID },
    data: {
      productType: "PRODUCT",
      patches: [
        {
          op: "replace",
          path: "/attributes/fulfillment_availability",
          value: [
            {
              fulfillment_channel_code: "AMAZON_NA",
              quantity,
              marketplace_id: MARKETPLACE_ID,
            },
          ],
        },
      ],
    },
  });
}

/**
 * Update price for a SKU.
 */
export async function updatePrice(sku, price) {
  console.log(`[SP-API] Updating price: SKU=${sku} price=$${price}`);
  return spRequest({
    method: "PATCH",
    path: `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(sku)}`,
    params: { marketplaceIds: MARKETPLACE_ID },
    data: {
      productType: "PRODUCT",
      patches: [
        {
          op: "replace",
          path: "/attributes/purchasable_offer",
          value: [
            {
              currency: "USD",
              our_price: [{ schedule: [{ value_with_tax: price }] }],
              marketplace_id: MARKETPLACE_ID,
            },
          ],
        },
      ],
    },
  });
}

// ─── Orders ───────────────────────────────────────────────────────────────────

/**
 * Get orders from the last N days.
 */
export async function getRecentOrders(days = 7) {
  const createdAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const res = await spRequest({
    path: "/orders/v0/orders",
    params: {
      MarketplaceIds: MARKETPLACE_ID,
      CreatedAfter: createdAfter,
      OrderStatuses: ["Unshipped", "PartiallyShipped", "Shipped", "Delivered", "InvoiceUnconfirmed"],
    },
  });
  return res.payload?.Orders || [];
}

/**
 * Get order items for a specific order.
 */
export async function getOrderItems(orderId) {
  const res = await spRequest({ path: `/orders/v0/orders/${orderId}/orderItems` });
  return res.payload?.OrderItems || [];
}

// ─── Messaging ────────────────────────────────────────────────────────────────

/**
 * Get buyer messages for an order.
 */
export async function getBuyerMessages(orderId) {
  try {
    const res = await spRequest({
      path: `/messaging/v1/orders/${orderId}/messages/buyerSellerMessages`,
      params: { marketplaceIds: MARKETPLACE_ID },
    });
    return res.payload?.messages || [];
  } catch {
    return [];
  }
}

/**
 * Reply to a buyer message.
 */
export async function replyToBuyer(orderId, body) {
  console.log(`[SP-API] Replying to buyer for order ${orderId}`);
  return spRequest({
    method: "POST",
    path: `/messaging/v1/orders/${orderId}/messages/buyerSellerMessages`,
    params: { marketplaceIds: MARKETPLACE_ID },
    data: { text: body },
  });
}

// ─── Review Requests ──────────────────────────────────────────────────────────

/**
 * Request a review for an order (Amazon sends the email).
 */
export async function requestReview(orderId) {
  console.log(`[SP-API] Requesting review for order ${orderId}`);
  return spRequest({
    method: "POST",
    path: `/messaging/v1/orders/${orderId}/messages/requestReview`,
    params: { marketplaceIds: MARKETPLACE_ID },
  });
}

// ─── Inventory ────────────────────────────────────────────────────────────────

/**
 * Get current FBA inventory levels.
 */
export async function getFBAInventory() {
  const res = await spRequest({
    path: "/fba/inventory/v1/summaries",
    params: {
      details: true,
      granularityType: "Marketplace",
      granularityId: MARKETPLACE_ID,
      marketplaceIds: MARKETPLACE_ID,
    },
  });
  return res.payload?.inventorySummaries || [];
}

// ─── Listing Status ───────────────────────────────────────────────────────────

/**
 * Get listing status and any suppression issues for a SKU.
 * @param {string} sku
 * @returns {{ status, issues, isSuppressed }}
 */
export async function getListingStatus(sku) {
  try {
    const res = await spRequest({
      path: `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(sku)}`,
      params: {
        marketplaceIds: MARKETPLACE_ID,
        includedData: "issues,summaries,attributes",
      },
    });

    const summaries = res.summaries || [];
    const issues = res.issues || [];
    const summary = summaries.find((s) => s.marketplaceId === MARKETPLACE_ID) || summaries[0] || {};
    const status = summary.status || "UNKNOWN";
    const isSuppressed = status === "SUPPRESSED" || issues.some((i) => i.severity === "ERROR");

    return {
      sku,
      status,
      isSuppressed,
      issues: issues.map((i) => ({
        severity: i.severity,
        code: i.code,
        message: i.message,
        attributeNames: i.attributeNames || [],
      })),
    };
  } catch (err) {
    console.error(`[SP-API] getListingStatus failed for SKU ${sku}:`, err.message);
    return { sku, status: "ERROR", isSuppressed: false, issues: [] };
  }
}

/**
 * Get sales & traffic report for conversion rate data.
 * Returns per-ASIN: { sessions, unitSessionPercentage, orderedUnits }
 * @param {number} days
 */
export async function getSalesTrafficReport(days = 7) {
  try {
    const reportId = await createReport("GET_SALES_AND_TRAFFIC_REPORT", days);
    const { status, reportDocumentId } = await waitForReport(reportId, 180000);
    if (status !== "DONE" || !reportDocumentId) return [];

    const rows = await downloadReport(reportDocumentId);
    return rows.map((r) => ({
      asin: r["Child ASIN"] || r["(Child) ASIN"] || "",
      sku: r["SKU"] || "",
      sessions: parseInt(r["Sessions"] || "0", 10),
      unitSessionPct: parseFloat((r["Unit Session Percentage"] || "0").replace("%", "")) / 100,
      orderedUnits: parseInt(r["Units Ordered"] || "0", 10),
      orderedRevenue: parseFloat(r["Ordered Product Sales"] || "0"),
    }));
  } catch (err) {
    console.error("[SP-API] getSalesTrafficReport failed:", err.message);
    return [];
  }
}

// ─── Pricing / Offers ─────────────────────────────────────────────────────────

/**
 * Get all active offers for an ASIN (to detect hijackers and buy box owner).
 * @param {string} asin
 * @returns {object} { offers, buyBoxSellerId }
 */
export async function getItemOffers(asin) {
  try {
    const res = await spRequest({
      path: `/products/pricing/v0/items/${asin}/offers`,
      params: {
        MarketplaceId: MARKETPLACE_ID,
        ItemCondition: "New",
        CustomerType: "Consumer",
      },
    });

    const offers = res.payload?.Offers || [];
    const summary = res.payload?.Summary || {};

    // Find buy box winner
    const buyBoxOffer = offers.find((o) => o.IsBuyBoxWinner);
    const buyBoxSellerId = buyBoxOffer?.SellerId || null;

    return {
      asin,
      offers: offers.map((o) => ({
        sellerId: o.SellerId,
        price: o.ListingPrice?.Amount,
        isBuyBoxWinner: o.IsBuyBoxWinner || false,
        isFulfilledByAmazon: o.IsFulfilledByAmazon || false,
        feedbackCount: o.SellerFeedbackRating?.FeedbackCount || 0,
      })),
      buyBoxSellerId,
      lowestPrice: summary.LowestPrices?.[0]?.LandedPrice?.Amount || null,
      totalOfferCount: summary.TotalOfferCount || offers.length,
    };
  } catch (err) {
    console.error(`[SP-API] getItemOffers failed for ${asin}:`, err.message);
    return { asin, offers: [], buyBoxSellerId: null, totalOfferCount: 0 };
  }
}

// ─── Reports ──────────────────────────────────────────────────────────────────

/**
 * Create a report and return the reportId.
 * @param {string} reportType - e.g. "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA"
 * @param {number} days - data window in days
 */
export async function createReport(reportType, days = 30) {
  const dataStartTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const res = await spRequest({
    method: "POST",
    path: "/reports/2021-06-30/reports",
    data: {
      reportType,
      dataStartTime,
      marketplaceIds: [MARKETPLACE_ID],
    },
  });
  if (!res.reportId) throw new Error(`SP-API createReport returned no reportId: ${JSON.stringify(res)}`);
  return res.reportId;
}

/**
 * Poll report status until done. Returns { status, reportDocumentId }.
 * @param {string} reportId
 * @param {number} maxWaitMs
 */
export async function waitForReport(reportId, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 10000));
    try {
      const res = await spRequest({ path: `/reports/2021-06-30/reports/${reportId}` });
      if (res.processingStatus === "DONE") {
        return { status: "DONE", reportDocumentId: res.reportDocumentId };
      }
      if (res.processingStatus === "FATAL" || res.processingStatus === "CANCELLED") {
        return { status: res.processingStatus };
      }
    } catch {}
  }
  return { status: "TIMEOUT" };
}

/**
 * Download a report document and return parsed TSV rows.
 * @param {string} reportDocumentId
 * @returns {Array<object>}
 */
export async function downloadReport(reportDocumentId) {
  const meta = await spRequest({ path: `/reports/2021-06-30/documents/${reportDocumentId}` });
  const url = meta.url;

  const res = await axios.get(url, { timeout: 30000, responseType: "text" });
  const lines = res.data.split("\n").filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const vals = line.split("\t");
    return Object.fromEntries(headers.map((h, i) => [h.trim(), (vals[i] || "").trim()]));
  });
}

// ─── Sales Metrics ────────────────────────────────────────────────────────────

/**
 * Get order-level sales data for the last N days (for P&L calculation).
 * Returns { orders, totalRevenue, unitsSold }
 * @param {number} days
 */
export async function getSalesData(days = 30) {
  const orders = await getRecentOrders(days);
  const detailed = [];

  for (const order of orders.slice(0, 100)) {
    try {
      const items = await getOrderItems(order.AmazonOrderId);
      for (const item of items) {
        detailed.push({
          orderId: order.AmazonOrderId,
          asin: item.ASIN,
          sku: item.SellerSKU,
          title: item.Title,
          qty: item.QuantityOrdered || 1,
          revenue: parseFloat(item.ItemPrice?.Amount || 0),
          purchaseDate: order.PurchaseDate,
        });
      }
      await new Promise((r) => setTimeout(r, 300));
    } catch {}
  }

  return detailed;
}
