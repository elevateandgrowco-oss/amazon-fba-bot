// ppc_manager.js — Amazon Ads API: validation campaigns, launch campaigns, bid optimization

import axios from "axios";
import { getAdsToken, hasAdsCredentials } from "./amazon_auth.js";
export { hasAdsCredentials };

const ADS_BASE = "https://advertising-api.amazon.com";

// Validation campaign settings
const VALIDATION_BUDGET_PER_DAY = 7;  // $7/day x 7 days = $49 max test spend
const VALIDATION_DAYS = 7;
const VALIDATION_MIN_CLICKS = 50;
const VALIDATION_MIN_CONVERSION_RATE = 0.05; // 5%

// Cache resolved profile ID so we only fetch it once per process
let _resolvedProfileId = process.env.AMAZON_ADS_PROFILE_ID || null;

/**
 * Resolve the US profile ID. Uses env var if set, otherwise fetches from API
 * and caches it for the rest of the process lifetime.
 */
async function getProfileId() {
  if (_resolvedProfileId) return _resolvedProfileId;

  const token = await getAdsToken();
  const res = await axios.get(`${ADS_BASE}/v2/profiles`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Amazon-Advertising-API-ClientId": process.env.AMAZON_ADS_CLIENT_ID,
    },
    timeout: 10000,
  });

  const profiles = res.data || [];
  // Prefer US marketplace profile
  const us = profiles.find(
    (p) => p.countryCode === "US" && p.accountInfo?.type === "seller"
  ) || profiles[0];

  if (!us) throw new Error("[PPC] No advertising profiles found for this account");

  _resolvedProfileId = String(us.profileId);
  console.log(`[PPC] Resolved Ads profile ID: ${_resolvedProfileId} (${us.countryCode})`);
  return _resolvedProfileId;
}

async function adsRequest({ method = "GET", path, data = null }) {
  if (!hasAdsCredentials()) {
    throw new Error("Amazon Ads API credentials not configured");
  }

  const token = await getAdsToken();
  const profileId = await getProfileId();

  const res = await axios({
    method,
    url: `${ADS_BASE}${path}`,
    headers: {
      Authorization: `Bearer ${token}`,
      "Amazon-Advertising-API-ClientId": process.env.AMAZON_ADS_CLIENT_ID,
      "Amazon-Advertising-API-Scope": profileId,
      "Content-Type": "application/json",
    },
    data,
    timeout: 15000,
  });

  return res.data;
}

// ─── Validation Campaigns ─────────────────────────────────────────────────────

/**
 * Create a 7-day validation PPC campaign for a new product.
 * @param {object} product - { asin, title, sku, keywords }
 * @returns {{ campaignId, adGroupId }} IDs to track validation
 */
export async function createValidationCampaign(product) {
  console.log(`[PPC] Creating validation campaign for: ${product.title?.slice(0, 40)}`);

  const endDate = new Date(Date.now() + VALIDATION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");

  // Create campaign
  const campaignRes = await adsRequest({
    method: "POST",
    path: "/v2/sp/campaigns",
    data: [
      {
        name: `VALIDATION_${product.asin}_${Date.now()}`,
        campaignType: "sponsoredProducts",
        targetingType: "manual",
        state: "enabled",
        dailyBudget: VALIDATION_BUDGET_PER_DAY,
        startDate: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
        endDate,
        bidding: { strategy: "autoForSales" },
      },
    ],
  });

  const campaign = Array.isArray(campaignRes) ? campaignRes[0] : campaignRes;
  const campaignId = campaign?.campaignId;
  if (!campaignId) throw new Error(`Failed to create validation campaign: ${campaign?.description || JSON.stringify(campaign)}`);

  // Create ad group
  const adGroupRes = await adsRequest({
    method: "POST",
    path: "/v2/sp/adGroups",
    data: [
      {
        name: `validation_adgroup_${product.asin}`,
        campaignId,
        defaultBid: 0.75,
        state: "enabled",
      },
    ],
  });

  const adGroup = Array.isArray(adGroupRes) ? adGroupRes[0] : adGroupRes;
  const adGroupId = adGroup?.adGroupId;
  if (!adGroupId) throw new Error(`Failed to create validation ad group: ${adGroup?.description || JSON.stringify(adGroup)}`);

  // Add product ad
  await adsRequest({
    method: "POST",
    path: "/v2/sp/productAds",
    data: [{ campaignId, adGroupId, sku: product.sku, state: "enabled" }],
  });

  // Add top keywords from research
  const kws = (product.keywords || []).slice(0, 10).map((kw) => ({
    campaignId,
    adGroupId,
    keywordText: typeof kw === "string" ? kw : kw.keyword,
    matchType: "broad",
    bid: 0.75,
    state: "enabled",
  }));

  if (kws.length > 0) {
    await adsRequest({ method: "POST", path: "/v2/sp/keywords", data: kws });
  }

  console.log(`[PPC] Validation campaign created: campaignId=${campaignId}`);
  return { campaignId, adGroupId };
}

/**
 * Get performance metrics for a campaign.
 * @param {string} campaignId
 * @returns {{ clicks, impressions, sales, orders, spend, conversionRate }}
 */
export async function getCampaignMetrics(campaignId) {
  try {
    // Request report
    const report = await adsRequest({
      method: "POST",
      path: "/v2/reports",
      data: {
        recordType: "campaigns",
        reportDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, ""),
        metrics: "clicks,impressions,attributedSales7d,attributedUnitsOrdered7d,cost",
        segment: "query",
      },
    });

    // Poll until report is ready (Amazon takes 10-90 seconds)
    let data = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((r) => setTimeout(r, 10000)); // wait 10s each attempt
      try {
        const status = await adsRequest({ path: `/v2/reports/${report.reportId}` });
        if (status.status === "SUCCESS") {
          data = await adsRequest({ path: `/v2/reports/${report.reportId}/download` });
          break;
        }
        if (status.status === "FAILURE") {
          console.error(`[PPC] Report generation failed for campaign ${campaignId}`);
          return null;
        }
        console.log(`[PPC] Report pending (attempt ${attempt + 1}/12)...`);
      } catch {}
    }

    if (!data) {
      console.error(`[PPC] Report timed out for campaign ${campaignId}`);
      return null;
    }

    const row = Array.isArray(data) ? data.find((r) => r.campaignId == campaignId) : null;

    if (!row) return null;

    const clicks = row.clicks || 0;
    const orders = row.attributedUnitsOrdered7d || 0;
    const conversionRate = clicks > 0 ? orders / clicks : 0;

    return {
      clicks,
      impressions: row.impressions || 0,
      sales: row.attributedSales7d || 0,
      orders,
      spend: row.cost || 0,
      conversionRate,
    };
  } catch (err) {
    console.error(`[PPC] Error getting metrics for campaign ${campaignId}:`, err.message);
    return null;
  }
}

/**
 * Evaluate whether a product passed validation.
 * @param {object} metrics
 * @returns {{ passed: boolean, reason: string }}
 */
export function evaluateValidation(metrics) {
  if (!metrics) return { passed: false, reason: "no metrics available" };

  if (metrics.clicks < VALIDATION_MIN_CLICKS) {
    return {
      passed: false,
      reason: `only ${metrics.clicks} clicks (need ${VALIDATION_MIN_CLICKS})`,
    };
  }

  if (metrics.conversionRate < VALIDATION_MIN_CONVERSION_RATE) {
    return {
      passed: false,
      reason: `conversion rate ${(metrics.conversionRate * 100).toFixed(1)}% (need ${VALIDATION_MIN_CONVERSION_RATE * 100}%)`,
    };
  }

  return {
    passed: true,
    reason: `${metrics.clicks} clicks, ${(metrics.conversionRate * 100).toFixed(1)}% CVR, $${metrics.sales.toFixed(2)} sales`,
  };
}

/**
 * Create a full launch campaign after validation passes.
 * @param {object} product
 * @returns {string} campaignId
 */
export async function createLaunchCampaign(product) {
  console.log(`[PPC] Creating launch campaign for: ${product.title?.slice(0, 40)}`);

  const launchCampaignRes = await adsRequest({
    method: "POST",
    path: "/v2/sp/campaigns",
    data: [
      {
        name: `LAUNCH_${product.asin}_${Date.now()}`,
        campaignType: "sponsoredProducts",
        targetingType: "manual",
        state: "enabled",
        dailyBudget: 20,
        startDate: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
        bidding: { strategy: "autoForSales" },
      },
    ],
  });

  const launchCampaign = Array.isArray(launchCampaignRes) ? launchCampaignRes[0] : launchCampaignRes;
  const campaignId = launchCampaign?.campaignId;
  if (!campaignId) throw new Error(`Failed to create launch campaign: ${launchCampaign?.description || JSON.stringify(launchCampaign)}`);

  const launchAdGroupRes = await adsRequest({
    method: "POST",
    path: "/v2/sp/adGroups",
    data: [
      {
        name: `launch_adgroup_${product.asin}`,
        campaignId,
        defaultBid: 1.0,
        state: "enabled",
      },
    ],
  });

  const launchAdGroup = Array.isArray(launchAdGroupRes) ? launchAdGroupRes[0] : launchAdGroupRes;
  if (!launchAdGroup?.adGroupId) throw new Error(`Failed to create launch ad group: ${launchAdGroup?.description || JSON.stringify(launchAdGroup)}`);

  await adsRequest({
    method: "POST",
    path: "/v2/sp/productAds",
    data: [{ campaignId, adGroupId: launchAdGroup.adGroupId, sku: product.sku, state: "enabled" }],
  });

  // Add all keywords with appropriate match types
  const kws = (product.keywords || []).slice(0, 20).flatMap((kw) => {
    const text = typeof kw === "string" ? kw : kw.keyword;
    return ["exact", "broad"].map((matchType) => ({
      campaignId,
      adGroupId: launchAdGroup.adGroupId,
      keywordText: text,
      matchType,
      bid: matchType === "exact" ? 1.2 : 0.8,
      state: "enabled",
    }));
  });

  if (kws.length > 0) {
    await adsRequest({ method: "POST", path: "/v2/sp/keywords", data: kws });
  }

  console.log(`[PPC] Launch campaign created: campaignId=${campaignId}`);
  return campaignId;
}

/**
 * Daily bid optimization — pause poor performers, raise bids on winners.
 * @param {string[]} campaignIds
 */
export async function optimizeBids(campaignIds) {
  if (!hasAdsCredentials()) {
    console.log("[PPC] Ads credentials not set — skipping bid optimization");
    return;
  }

  console.log(`[PPC] Optimizing bids for ${campaignIds.length} campaigns...`);

  for (const campaignId of campaignIds) {
    try {
      const metrics = await getCampaignMetrics(campaignId);
      if (!metrics) continue;

      const acos = metrics.sales > 0 ? (metrics.spend / metrics.sales) * 100 : 0;

      if (acos > 40 && metrics.spend > 5) {
        // ACoS too high — reduce budget by 20%
        await adsRequest({
          method: "PUT",
          path: `/v2/sp/campaigns`,
          data: [{ campaignId, dailyBudget: Math.max(5, metrics.spend * 0.8) }],
        });
        console.log(`[PPC] Reduced budget for campaign ${campaignId} (ACoS=${acos.toFixed(1)}%)`);
      } else if (acos < 20 && metrics.sales > 50) {
        // Performing well — increase budget by 20%
        await adsRequest({
          method: "PUT",
          path: `/v2/sp/campaigns`,
          data: [{ campaignId, dailyBudget: metrics.spend * 1.2 }],
        });
        console.log(`[PPC] Increased budget for campaign ${campaignId} (ACoS=${acos.toFixed(1)}%)`);
      }
    } catch (err) {
      console.error(`[PPC] Error optimizing campaign ${campaignId}:`, err.message);
    }
  }
}
