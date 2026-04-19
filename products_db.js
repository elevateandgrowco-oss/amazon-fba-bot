// products_db.js — JSON file database for FBA opportunities

import fs from "fs";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || ".";
const DB_PATH = path.join(DATA_DIR, "products.json");

const DEFAULT_DB = {
  opportunities: [],
  totalScanned: 0,
  lastResearchAt: null,
  lastCompetitorCheckAt: null,
  lastReviewCheckAt: null,
};

/**
 * Load the database from disk. Returns DEFAULT_DB if file missing or corrupt.
 * @returns {object} db
 */
export function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      return structuredClone(DEFAULT_DB);
    }
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    // Ensure all expected top-level keys exist
    return {
      ...structuredClone(DEFAULT_DB),
      ...parsed,
    };
  } catch (err) {
    console.error("[DB] Failed to load products.json, starting fresh:", err.message);
    return structuredClone(DEFAULT_DB);
  }
}

/**
 * Persist the database to disk.
 * @param {object} db
 */
export function saveDB(db) {
  try {
    // Ensure DATA_DIR exists
    if (DATA_DIR !== "." && !fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
  } catch (err) {
    console.error("[DB] Failed to save products.json:", err.message);
  }
}

/**
 * Add or update an opportunity. Dedupes by ASIN.
 * @param {object} db
 * @param {object} product - Full product object
 * @returns {object} db (mutated in place)
 */
export function addOpportunity(db, product) {
  if (!product.asin) {
    console.warn("[DB] addOpportunity called with no ASIN — skipping");
    return db;
  }

  const existing = db.opportunities.findIndex((o) => o.asin === product.asin);

  const entry = {
    asin: product.asin,
    title: product.title || "",
    category: product.category || "",
    price: product.price || 0,
    bsr: product.bsr || 0,
    reviews: product.reviewCount ?? product.reviews ?? 0,
    rating: product.rating || 0,
    estimatedMonthlySales: product.estimatedMonthlySales || 0,
    estimatedMonthlyRevenue: product.estimatedMonthlyRevenue || 0,
    estimatedCOGS: product.estimatedCOGS || 0,
    fbaFees: product.fbaFees || 0,
    estimatedProfit: product.estimatedProfit || 0,
    margin: product.margin || 0,
    roi: product.roi || 0,
    opportunityScore: product.opportunityScore || product.score || 0,
    status: product.status || "researching",
    suppliers: product.suppliers || [],
    listing: product.listing || null,
    keywords: product.keywords || [],
    priceHistory: product.priceHistory || [{ date: new Date().toISOString(), price: product.price || 0 }],
    bsrHistory: product.bsrHistory || [{ date: new Date().toISOString(), bsr: product.bsr || 0 }],
    recentReviews: product.recentReviews || [],
    addedAt: product.addedAt || new Date().toISOString(),
    lastChecked: product.lastChecked || null,
  };

  if (existing >= 0) {
    // Update existing — preserve history arrays by merging
    db.opportunities[existing] = {
      ...db.opportunities[existing],
      ...entry,
      priceHistory: db.opportunities[existing].priceHistory,
      bsrHistory: db.opportunities[existing].bsrHistory,
      recentReviews: db.opportunities[existing].recentReviews,
      addedAt: db.opportunities[existing].addedAt,
    };
    console.log(`[DB] Updated existing opportunity: ${product.asin}`);
  } else {
    db.opportunities.push(entry);
    console.log(`[DB] Added new opportunity: ${product.asin} — ${entry.title.slice(0, 60)}`);
  }

  return db;
}

/**
 * Update fields on an existing opportunity.
 * @param {object} db
 * @param {string} asin
 * @param {object} updates - Partial fields to merge
 * @returns {boolean} true if found and updated
 */
export function updateOpportunity(db, asin, updates) {
  const idx = db.opportunities.findIndex((o) => o.asin === asin);
  if (idx < 0) {
    console.warn(`[DB] updateOpportunity: ASIN ${asin} not found`);
    return false;
  }
  db.opportunities[idx] = { ...db.opportunities[idx], ...updates };
  return true;
}

/**
 * Check if a product has already been researched (has listing + keywords).
 * @param {object} db
 * @param {string} asin
 * @returns {boolean}
 */
export function hasBeenResearched(db, asin) {
  const product = db.opportunities.find((o) => o.asin === asin);
  if (!product) return false;
  return !!(product.listing && product.keywords && product.keywords.length > 0);
}

/**
 * Return all products that are actively being tracked (status !== "passed").
 * @param {object} db
 * @returns {Array}
 */
export function getTrackedProducts(db) {
  return db.opportunities.filter((o) => o.status !== "passed");
}

/**
 * Print a summary of the database to console.
 * @param {object} db
 */
export function printSummary(db) {
  const total = db.opportunities.length;
  const byStatus = db.opportunities.reduce((acc, o) => {
    acc[o.status] = (acc[o.status] || 0) + 1;
    return acc;
  }, {});

  const topByScore = [...db.opportunities]
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
    .slice(0, 5);

  console.log("\n========== FBA BOT DATABASE SUMMARY ==========");
  console.log(`Total opportunities: ${total}`);
  console.log(`Total scanned: ${db.totalScanned}`);
  console.log(`Status breakdown:`, byStatus);
  console.log(`Last research: ${db.lastResearchAt || "never"}`);
  console.log(`Last competitor check: ${db.lastCompetitorCheckAt || "never"}`);
  console.log(`Last review check: ${db.lastReviewCheckAt || "never"}`);

  if (topByScore.length > 0) {
    console.log("\nTop 5 by opportunity score:");
    topByScore.forEach((p, i) => {
      console.log(
        `  ${i + 1}. [${p.opportunityScore}] ${p.title.slice(0, 55)}... $${p.price} | Margin: ${p.margin}% | BSR: ${p.bsr}`
      );
    });
  }
  console.log("==============================================\n");
}
