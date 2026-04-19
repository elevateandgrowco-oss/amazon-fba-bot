// negative_keyword_miner.js — Pull Ads search term reports and auto-add negative keywords
// Stops wasting 20-40% of ad budget on searches that never convert

import axios from "axios";
import { getAdsToken, hasAdsCredentials } from "./amazon_auth.js";
import { loadDB, saveDB } from "./products_db.js";

const ADS_BASE = "https://advertising-api.amazon.com";
const ADS_PROFILE_ID = process.env.AMAZON_ADS_PROFILE_ID;

// A search term that spent this much with 0 orders gets negated
const MIN_SPEND_TO_NEGATE = 2.00; // $2 spent, 0 orders = waste
// A search term with very low CVR also gets negated
const MAX_ACOS_TO_KEEP = 80; // above 80% ACoS = unprofitable, negate
// Minimum spend before we evaluate ACoS (too little data is noise)
const MIN_SPEND_FOR_ACOS_CHECK = 5.00;

async function adsRequest({ method = "GET", path, data = null }) {
  if (!hasAdsCredentials()) throw new Error("Ads API credentials not configured");
  const token = await getAdsToken();
  const res = await axios({
    method,
    url: `${ADS_BASE}${path}`,
    headers: {
      Authorization: `Bearer ${token}`,
      "Amazon-Advertising-API-ClientId": process.env.AMAZON_ADS_CLIENT_ID,
      "Amazon-Advertising-API-Scope": ADS_PROFILE_ID,
      "Content-Type": "application/json",
    },
    data,
    timeout: 20000,
  });
  return res.data;
}

/**
 * Request a search term report for a campaign, wait for it, and download.
 * Returns array of { query, clicks, spend, orders, sales } rows.
 */
async function getSearchTermReport(campaignId) {
  const reportDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, "");

  const report = await adsRequest({
    method: "POST",
    path: "/v2/reports",
    data: {
      recordType: "keywords",
      reportDate,
      metrics: "clicks,cost,attributedUnitsOrdered7d,attributedSales7d,impressions",
      segment: "query",
    },
  });

  // Poll until ready
  let data = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((r) => setTimeout(r, 10000));
    try {
      const status = await adsRequest({ path: `/v2/reports/${report.reportId}` });
      if (status.status === "SUCCESS") {
        // Download the report (it's a URL from Amazon S3)
        const dlRes = await axios.get(status.location, { timeout: 30000 });
        data = dlRes.data;
        break;
      }
      if (status.status === "FAILURE") {
        console.error(`[NegKW] Report generation failed for campaign ${campaignId}`);
        return [];
      }
    } catch {}
  }

  if (!data) return [];

  const rows = Array.isArray(data) ? data : [];

  // Filter to rows matching this campaign
  return rows
    .filter((r) => String(r.campaignId) === String(campaignId) && r.query)
    .map((r) => ({
      query: r.query,
      clicks: r.clicks || 0,
      spend: r.cost || 0,
      orders: r.attributedUnitsOrdered7d || 0,
      sales: r.attributedSales7d || 0,
      impressions: r.impressions || 0,
    }));
}

/**
 * Identify search terms that should be negated.
 * Rules: spent $2+ with 0 orders, OR ACoS > 80% with $5+ spend.
 */
function findNegativeTerms(searchTerms, existingNegatives) {
  const existingSet = new Set(existingNegatives.map((n) => n.toLowerCase()));

  return searchTerms.filter((term) => {
    if (existingSet.has(term.query.toLowerCase())) return false; // already negated

    // Skip very short queries (single words are usually too broad to negate)
    if (term.query.split(" ").length < 2) return false;

    // Rule 1: spent enough with zero orders = pure waste
    if (term.spend >= MIN_SPEND_TO_NEGATE && term.orders === 0) return true;

    // Rule 2: high ACoS = spending more than earning
    if (term.spend >= MIN_SPEND_FOR_ACOS_CHECK && term.sales > 0) {
      const acos = (term.spend / term.sales) * 100;
      if (acos > MAX_ACOS_TO_KEEP) return true;
    }

    return false;
  });
}

/**
 * Add negative keywords to an ad group.
 */
async function addNegativeKeywords(campaignId, adGroupId, terms) {
  if (terms.length === 0) return;

  const negKeywords = terms.map((t) => ({
    campaignId,
    adGroupId,
    keywordText: t.query,
    matchType: "negativeExact",
    state: "enabled",
  }));

  // Batch in groups of 100 (API limit)
  for (let i = 0; i < negKeywords.length; i += 100) {
    const batch = negKeywords.slice(i, i + 100);
    try {
      await adsRequest({ method: "POST", path: "/v2/sp/negativeKeywords", data: batch });
      console.log(`[NegKW] Added ${batch.length} negative keywords`);
    } catch (err) {
      console.error("[NegKW] Failed to add negative keywords batch:", err.message);
    }
  }
}

/**
 * Get existing negative keywords for an ad group (to avoid duplicates).
 */
async function getExistingNegatives(campaignId) {
  try {
    const res = await adsRequest({
      path: `/v2/sp/negativeKeywords?campaignIdFilter=${campaignId}&stateFilter=enabled`,
    });
    return (Array.isArray(res) ? res : []).map((k) => k.keywordText || "");
  } catch {
    return [];
  }
}

/**
 * Mine search term reports for all active campaigns and add negative keywords.
 * @param {boolean} dryRun
 * @returns {{ totalNegated: number, byProduct: Array }}
 */
export async function mineNegativeKeywords(dryRun = false) {
  if (!hasAdsCredentials()) {
    console.log("[NegKW] Ads credentials not set — skipping negative keyword mining");
    return { totalNegated: 0, byProduct: [] };
  }

  console.log("[NegKW] Mining search term reports for waste...");

  const db = loadDB();
  const activeCampaigns = (db.opportunities || []).filter(
    (p) => p.launchCampaignId || p.validationCampaignId
  );

  if (activeCampaigns.length === 0) {
    console.log("[NegKW] No active campaigns to analyze");
    return { totalNegated: 0, byProduct: [] };
  }

  let totalNegated = 0;
  const byProduct = [];

  for (const product of activeCampaigns) {
    const campaignId = product.launchCampaignId || product.validationCampaignId;
    const adGroupId = product.launchAdGroupId || product.validationAdGroupId;

    if (!adGroupId) {
      console.log(`[NegKW] ${product.asin} — no ad group ID stored, skipping`);
      continue;
    }

    try {
      console.log(`[NegKW] Pulling search term report for ${product.asin}...`);
      const searchTerms = await getSearchTermReport(campaignId);

      if (searchTerms.length === 0) {
        console.log(`[NegKW] No search term data for ${product.asin} yet`);
        continue;
      }

      const existingNegatives = await getExistingNegatives(campaignId);
      const toNegate = findNegativeTerms(searchTerms, existingNegatives);

      console.log(`[NegKW] ${product.asin} — ${searchTerms.length} terms analyzed, ${toNegate.length} to negate`);
      toNegate.forEach((t) =>
        console.log(`  - "${t.query}" (spent $${t.spend.toFixed(2)}, ${t.orders} orders)`)
      );

      if (toNegate.length > 0 && !dryRun) {
        await addNegativeKeywords(campaignId, adGroupId, toNegate);
        totalNegated += toNegate.length;
      } else if (dryRun) {
        totalNegated += toNegate.length;
      }

      byProduct.push({
        asin: product.asin,
        title: product.title?.slice(0, 50),
        termsAnalyzed: searchTerms.length,
        termsNegated: toNegate.length,
        wastedSpend: toNegate.reduce((s, t) => s + t.spend, 0).toFixed(2),
        negatedTerms: toNegate.map((t) => t.query),
      });

      // Save negated terms to DB so we can track history
      const db2 = loadDB();
      const idx = db2.opportunities.findIndex((o) => o.asin === product.asin);
      if (idx !== -1) {
        const existing = db2.opportunities[idx].negativeKeywords || [];
        db2.opportunities[idx].negativeKeywords = [
          ...new Set([...existing, ...toNegate.map((t) => t.query)]),
        ].slice(-500);
        db2.opportunities[idx].lastNegativeKeywordMineAt = new Date().toISOString();
        saveDB(db2);
      }

      // Rate limit between campaigns
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[NegKW] Error processing ${product.asin}:`, err.message);
    }
  }

  const totalWastedSpend = byProduct.reduce((s, p) => s + parseFloat(p.wastedSpend), 0);
  console.log(`[NegKW] Done — ${totalNegated} negative keywords added, $${totalWastedSpend.toFixed(2)} in wasted spend stopped`);

  return { totalNegated, totalWastedSpend, byProduct };
}
