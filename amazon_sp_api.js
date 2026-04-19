// amazon_sp_api.js — Amazon SP-API: listings, orders, messages, inventory

import axios from "axios";
import { getSpApiToken, hasSpApiCredentials } from "./amazon_auth.js";

const SP_API_BASE = "https://sellingpartnerapi-na.amazon.com";
const MARKETPLACE_ID = process.env.SP_API_MARKETPLACE_ID || "ATVPDKIKX0DER"; // US default
const SELLER_ID = process.env.SP_API_SELLER_ID;

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
      OrderStatuses: "Shipped,Delivered",
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
