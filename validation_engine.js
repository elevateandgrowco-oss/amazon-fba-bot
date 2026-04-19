// validation_engine.js — Multi-signal product validation engine
// Stage 1 (free): Google Trends + competition depth + review velocity + price stability + demand
// Stage 2 (paid): PPC metrics combined with all Stage 1 signals
// Product must score ≥ 65/100 on Stage 1 before we spend a dollar on PPC
// Product must score ≥ 75/100 on final combined score to order inventory

import axios from "axios";
import * as cheerio from "cheerio";

// ─── Scoring Weights ──────────────────────────────────────────────────────────
// Stage 1 (pre-PPC): max 100 points
const WEIGHTS = {
  googleTrend: 20,       // Is demand growing?
  competitionDepth: 25,  // Is the market winnable?
  reviewVelocity: 20,    // Are competitors making consistent sales?
  priceStability: 15,    // Is pricing stable (not a race to bottom)?
  demandScore: 20,       // Is there real search demand?
};

// Stage 2 thresholds (post-PPC)
const PPC_MIN_CLICKS = 80;
const PPC_MIN_CVR = 0.07;        // 7% conversion rate
const PPC_MIN_SALES = 3;         // At least 3 actual purchases
const PPC_MAX_ACOS = 0.35;       // ACoS under 35%

const PRE_VALIDATION_MIN = 65;   // Must score ≥ 65/100 before PPC test
const FINAL_VALIDATION_MIN = 75; // Must score ≥ 75/100 after PPC test

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Signal 1: Google Trends ──────────────────────────────────────────────────

/**
 * Check Google Trends for keyword interest over 5 years (US).
 * Returns trend direction and seasonal flag.
 */
export async function checkGoogleTrends(keyword) {
  const signal = { score: 0, label: "unknown", seasonal: false, raw: null };

  try {
    const req = JSON.stringify({
      comparisonItem: [{ keyword, geo: "US", time: "today 5-y" }],
      category: 0,
      property: "",
    });

    const res = await axios.get("https://trends.google.com/trends/api/explore", {
      params: { hl: "en-US", tz: 240, req },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
      },
      timeout: 10000,
    });

    // Response starts with )]}' — strip it
    const json = JSON.parse(res.data.replace(/^\)\]\}'/, "").trim());
    const widgets = json.widgets || [];
    const timelineWidget = widgets.find((w) => w.id === "TIMESERIES");
    if (!timelineWidget) {
      signal.label = "no data";
      signal.score = 10; // neutral
      return signal;
    }

    // Fetch the actual timeline data
    const timelineRes = await axios.get("https://trends.google.com/trends/api/widgetdata/multiline", {
      params: {
        hl: "en-US",
        tz: 240,
        req: JSON.stringify(timelineWidget.request),
        token: timelineWidget.token,
      },
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      timeout: 10000,
    });

    const timelineJson = JSON.parse(timelineRes.data.replace(/^\)\]\}'/, "").trim());
    const points = timelineJson.default?.timelineData || [];

    if (points.length < 10) {
      signal.label = "insufficient data";
      signal.score = 10;
      return signal;
    }

    const values = points.map((p) => p.value?.[0] || 0);
    signal.raw = values;

    // Google Trends returns weekly data points (~52/year)
    // Compare last 26 weeks (6 months) vs. prior 26 weeks (6-12 months ago)
    const recent = values.slice(-26);           // last 6 months
    const older = values.slice(-52, -26);       // 6-12 months ago

    const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
    const olderAvg = older.length > 0 ? older.reduce((s, v) => s + v, 0) / older.length : recentAvg;

    // Check for seasonality (high variance)
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    // Seasonal if coefficient of variation > 40% (normalized to scale)
    const cv = avg > 0 ? stdDev / avg : 0;
    signal.seasonal = cv > 0.4 && avg > 10;

    // Trend direction
    const growthRate = olderAvg > 0 ? (recentAvg - olderAvg) / olderAvg : 0;

    if (recentAvg < 10) {
      signal.label = "very low interest";
      signal.score = 0;
    } else if (growthRate > 0.2) {
      signal.label = "growing fast";
      signal.score = signal.seasonal ? 15 : 20; // seasonal gets slight penalty
    } else if (growthRate > 0.05) {
      signal.label = "growing";
      signal.score = signal.seasonal ? 12 : 18;
    } else if (growthRate > -0.1) {
      signal.label = "stable";
      signal.score = signal.seasonal ? 10 : 15;
    } else if (growthRate > -0.3) {
      signal.label = "declining";
      signal.score = 5;
    } else {
      signal.label = "dying";
      signal.score = 0;
    }

    console.log(`[Validation] Google Trends "${keyword}": ${signal.label} (growth: ${(growthRate * 100).toFixed(1)}%, seasonal: ${signal.seasonal})`);
  } catch (err) {
    console.error(`[Validation] Google Trends error for "${keyword}":`, err.message);
    signal.label = "error";
    signal.score = 10; // neutral on error — don't penalize for API issues
  }

  return signal;
}

// ─── Signal 2: Competition Depth ─────────────────────────────────────────────

/**
 * Analyze top 10 Amazon competitors for a keyword.
 * Checks if market is winnable: few reviews, weak listings, price room.
 */
export async function checkCompetitionDepth(keyword, browser) {
  const signal = {
    score: 0,
    label: "unknown",
    totalResults: 0,
    avgTopReviews: 0,
    weakCompetitors: 0,
    avgPrice: 0,
  };

  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
    );
    await page.goto(`https://www.amazon.com/s?k=${encodeURIComponent(keyword)}`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await sleep(1500);

    const data = await page.evaluate(() => {
      const results = [];
      const containers = document.querySelectorAll('[data-component-type="s-search-result"]');

      for (const el of containers) {
        const reviewEl = el.querySelector('.a-size-base.s-underline-text');
        const ratingEl = el.querySelector('[aria-label*="out of 5 stars"]');
        const priceEl = el.querySelector(".a-price .a-offscreen");

        const reviewText = reviewEl?.textContent?.replace(/,/g, "") || "0";
        const reviews = parseInt(reviewText.replace(/[^0-9]/g, ""), 10) || 0;
        const rating = parseFloat(ratingEl?.getAttribute("aria-label") || "0") || 0;
        const price = parseFloat(priceEl?.textContent?.replace(/[^0-9.]/g, "") || "0") || 0;

        results.push({ reviews, rating, price });
        if (results.length >= 10) break;
      }

      // Try to get total results count
      const totalEl = document.querySelector('.s-result-count, [data-component-type="s-result-info-bar"] span');
      const totalText = totalEl?.textContent || "";
      const totalMatch = totalText.match(/[\d,]+/);
      const total = totalMatch ? parseInt(totalMatch[0].replace(/,/g, ""), 10) : 0;

      return { results, total };
    });

    const top10 = data.results.slice(0, 10);
    signal.totalResults = data.total;
    signal.avgTopReviews =
      top10.length > 0 ? Math.round(top10.reduce((s, p) => s + p.reviews, 0) / top10.length) : 0;
    signal.weakCompetitors = top10.filter((p) => p.reviews < 200).length;
    signal.avgPrice =
      top10.filter((p) => p.price > 0).length > 0
        ? parseFloat(
            (
              top10.filter((p) => p.price > 0).reduce((s, p) => s + p.price, 0) /
              top10.filter((p) => p.price > 0).length
            ).toFixed(2)
          )
        : 0;

    // Scoring logic
    if (signal.weakCompetitors >= 5) {
      signal.label = "very winnable";
      signal.score = 25;
    } else if (signal.weakCompetitors >= 3) {
      signal.label = "winnable";
      signal.score = 20;
    } else if (signal.avgTopReviews < 500) {
      signal.label = "moderate competition";
      signal.score = 15;
    } else if (signal.avgTopReviews < 1000) {
      signal.label = "competitive";
      signal.score = 8;
    } else {
      signal.label = "saturated";
      signal.score = 0;
    }

    console.log(
      `[Validation] Competition for "${keyword}": ${signal.label} (avg reviews: ${signal.avgTopReviews}, weak competitors: ${signal.weakCompetitors}/10)`
    );
  } catch (err) {
    console.error(`[Validation] Competition check error for "${keyword}":`, err.message);
    signal.label = "error";
    signal.score = 12;
  } finally {
    await page.close();
  }

  return signal;
}

// ─── Signal 3: Review Velocity ────────────────────────────────────────────────

/**
 * Check if top competitors are getting consistent recent reviews.
 * Recent reviews = ongoing sales. Old reviews only = dead product.
 */
export async function checkReviewVelocity(asin, browser) {
  const signal = { score: 0, label: "unknown", recentCount: 0, lastReviewDays: 999 };

  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
    );
    await page.goto(
      `https://www.amazon.com/product-reviews/${asin}?sortBy=recent&pageNumber=1`,
      { waitUntil: "domcontentloaded", timeout: 20000 }
    );
    await sleep(1500);

    const reviewData = await page.evaluate(() => {
      const reviews = [];
      const reviewEls = document.querySelectorAll('[data-hook="review"]');

      for (const el of reviewEls) {
        const dateEl = el.querySelector('[data-hook="review-date"]');
        const dateText = dateEl?.textContent || "";
        reviews.push(dateText);
        if (reviews.length >= 10) break;
      }

      return reviews;
    });

    const now = Date.now();
    const parsedDates = reviewData
      .map((text) => {
        const match = text.match(/on (.+)$/);
        if (!match) return null;
        return new Date(match[1]);
      })
      .filter((d) => d && !isNaN(d.getTime()));

    if (parsedDates.length === 0) {
      signal.label = "no reviews";
      signal.score = 5;
      return signal;
    }

    const daysAgo = parsedDates.map((d) => (now - d.getTime()) / (1000 * 60 * 60 * 24));
    signal.lastReviewDays = Math.round(Math.min(...daysAgo));
    signal.recentCount = daysAgo.filter((d) => d <= 30).length; // reviews in last 30 days

    if (signal.recentCount >= 5) {
      signal.label = "high velocity";
      signal.score = 20;
    } else if (signal.recentCount >= 3) {
      signal.label = "good velocity";
      signal.score = 16;
    } else if (signal.recentCount >= 1) {
      signal.label = "low velocity";
      signal.score = 10;
    } else if (signal.lastReviewDays <= 90) {
      signal.label = "slow";
      signal.score = 6;
    } else {
      signal.label = "dead";
      signal.score = 0;
    }

    console.log(
      `[Validation] Review velocity for ${asin}: ${signal.label} (${signal.recentCount} reviews in 30 days, last: ${signal.lastReviewDays} days ago)`
    );
  } catch (err) {
    console.error(`[Validation] Review velocity error for ${asin}:`, err.message);
    signal.label = "error";
    signal.score = 10;
  } finally {
    await page.close();
  }

  return signal;
}

// ─── Signal 4: Price Stability ────────────────────────────────────────────────

/**
 * Check if competitor prices are stable or in a downward spiral.
 * Uses price history stored in DB + current competitor scrape.
 */
export function checkPriceStability(product) {
  const signal = { score: 0, label: "unknown", trend: "unknown" };

  const history = product.priceHistory || [];
  const competitorHistory = product.competitorPriceHistory || [];

  if (history.length < 2 && competitorHistory.length < 2) {
    // Not enough history — check if current price seems reasonable
    const price = product.price || 0;
    if (price >= 15 && price <= 80) {
      signal.label = "no history — price looks ok";
      signal.score = 12;
    } else {
      signal.label = "no history";
      signal.score = 10;
    }
    return signal;
  }

  const allHistory = [...history, ...competitorHistory].sort(
    (a, b) => new Date(a.date) - new Date(b.date)
  );

  const prices = allHistory.map((h) => h.price).filter((p) => p > 0);
  if (prices.length < 2) {
    signal.score = 10;
    signal.label = "insufficient data";
    return signal;
  }

  const first = prices[0];
  const last = prices[prices.length - 1];
  const change = (last - first) / first;

  if (change < -0.3) {
    signal.label = "steep decline";
    signal.score = 0;
    signal.trend = "down";
  } else if (change < -0.1) {
    signal.label = "declining";
    signal.score = 5;
    signal.trend = "down";
  } else if (change < 0.05) {
    signal.label = "stable";
    signal.score = 15;
    signal.trend = "stable";
  } else {
    signal.label = "rising";
    signal.score = 15;
    signal.trend = "up";
  }

  console.log(`[Validation] Price stability for ${product.asin}: ${signal.label} (${(change * 100).toFixed(1)}% change)`);
  return signal;
}

// ─── Signal 5: Demand Score ───────────────────────────────────────────────────

/**
 * Estimate search demand using Amazon autocomplete popularity.
 * More suggestions + money keywords = higher demand.
 */
export async function checkDemandScore(keyword) {
  const signal = { score: 0, label: "unknown", suggestionCount: 0 };

  try {
    const encoded = encodeURIComponent(keyword.toLowerCase());
    const url =
      `https://completion.amazon.com/api/2017/suggestions` +
      `?session-id=000-0000000-0000000&customer-id=&request-id=` +
      `&page-type=Gateway&lop=en_US&site-variant=desktop` +
      `&client-info=amazon-search-ui&mid=ATVPDKIKX0DER` +
      `&alias=aps&b2b=0&fresh=0&ks=80&prefix=${encoded}&event=onKeyPress&limit=11&fb=1`;

    const res = await axios.get(url, { timeout: 8000 });
    const suggestions = res.data?.suggestions || [];
    signal.suggestionCount = suggestions.length;

    // Check for buying-intent keywords in suggestions
    const buyingIntent = ["buy", "best", "cheap", "top", "for", "set", "pack", "bundle", "deal"];
    const intentMatches = suggestions.filter((s) =>
      buyingIntent.some((w) => s.value?.toLowerCase().includes(w))
    ).length;

    if (suggestions.length >= 8 && intentMatches >= 3) {
      signal.label = "very high demand";
      signal.score = 20;
    } else if (suggestions.length >= 6 && intentMatches >= 2) {
      signal.label = "high demand";
      signal.score = 17;
    } else if (suggestions.length >= 4) {
      signal.label = "moderate demand";
      signal.score = 12;
    } else if (suggestions.length >= 2) {
      signal.label = "low demand";
      signal.score = 6;
    } else {
      signal.label = "very low demand";
      signal.score = 0;
    }

    console.log(
      `[Validation] Demand for "${keyword}": ${signal.label} (${suggestions.length} suggestions, ${intentMatches} buying-intent)`
    );
  } catch (err) {
    console.error(`[Validation] Demand check error for "${keyword}":`, err.message);
    signal.score = 10;
    signal.label = "error";
  }

  return signal;
}

// ─── Stage 1: Pre-PPC Validation ─────────────────────────────────────────────

/**
 * Run all free signals before spending on PPC.
 * Returns a score and whether to proceed with PPC test.
 * @param {object} product
 * @param {object} browser - Puppeteer browser instance
 * @returns {{ score, signals, passed, reason }}
 */
export async function runPreValidation(product, browser) {
  const keyword = product.title?.split(/[,|(]/)[0].trim() || product.title || "";
  const asin = product.asin;

  console.log(`[Validation] Running pre-PPC validation for "${keyword}" (${asin})...`);

  const signals = {};

  // Run all signals in parallel where possible
  const [trendsSignal, demandSignal] = await Promise.all([
    checkGoogleTrends(keyword),
    checkDemandScore(keyword),
  ]);
  signals.googleTrend = trendsSignal;
  signals.demand = demandSignal;

  // Sequential browser-based checks
  signals.competition = await checkCompetitionDepth(keyword, browser);
  await sleep(1500);
  signals.reviewVelocity = await checkReviewVelocity(asin, browser);

  // Price stability (pure data, no browser needed)
  signals.priceStability = checkPriceStability(product);

  const totalScore =
    signals.googleTrend.score +
    signals.competition.score +
    signals.reviewVelocity.score +
    signals.priceStability.score +
    signals.demand.score;

  const passed = totalScore >= PRE_VALIDATION_MIN;

  const summary = [
    `Google Trends: ${signals.googleTrend.label} (${signals.googleTrend.score}/${WEIGHTS.googleTrend})`,
    `Competition: ${signals.competition.label} (${signals.competition.score}/${WEIGHTS.competitionDepth})`,
    `Review Velocity: ${signals.reviewVelocity.label} (${signals.reviewVelocity.score}/${WEIGHTS.reviewVelocity})`,
    `Price Stability: ${signals.priceStability.label} (${signals.priceStability.score}/${WEIGHTS.priceStability})`,
    `Demand: ${signals.demand.label} (${signals.demand.score}/${WEIGHTS.demandScore})`,
  ].join(" | ");

  console.log(
    `[Validation] Pre-PPC score: ${totalScore}/100 — ${passed ? "PROCEED to PPC test" : "SKIP"}`
  );
  console.log(`[Validation] ${summary}`);

  return {
    score: totalScore,
    signals,
    passed,
    reason: passed
      ? `Score ${totalScore}/100 — ${summary}`
      : `Score ${totalScore}/100 too low (need ${PRE_VALIDATION_MIN}) — ${summary}`,
    seasonal: signals.googleTrend.seasonal,
  };
}

// ─── Stage 2: Post-PPC Validation ────────────────────────────────────────────

/**
 * Combine PPC metrics with pre-validation signals for final verdict.
 * @param {object} preValidation - Result from runPreValidation
 * @param {object} ppcMetrics - { clicks, orders, sales, spend, conversionRate, impressions }
 * @returns {{ score, passed, reason, confidence }}
 */
export function runPostValidation(preValidation, ppcMetrics) {
  if (!ppcMetrics) {
    return { score: 0, passed: false, reason: "No PPC metrics available", confidence: "low" };
  }

  // PPC scoring (max 50 points on top of pre-validation 100)
  let ppcScore = 0;
  const ppcDetails = [];

  // Clicks (max 10 pts)
  if (ppcMetrics.clicks >= PPC_MIN_CLICKS * 1.5) {
    ppcScore += 10;
    ppcDetails.push(`clicks: ${ppcMetrics.clicks} ✓`);
  } else if (ppcMetrics.clicks >= PPC_MIN_CLICKS) {
    ppcScore += 7;
    ppcDetails.push(`clicks: ${ppcMetrics.clicks} ✓`);
  } else if (ppcMetrics.clicks >= PPC_MIN_CLICKS * 0.6) {
    ppcScore += 3;
    ppcDetails.push(`clicks: ${ppcMetrics.clicks} (low)`);
  } else {
    ppcDetails.push(`clicks: ${ppcMetrics.clicks} ✗`);
  }

  // Conversion rate (max 20 pts)
  const cvr = ppcMetrics.conversionRate || 0;
  if (cvr >= PPC_MIN_CVR * 1.5) {
    ppcScore += 20;
    ppcDetails.push(`CVR: ${(cvr * 100).toFixed(1)}% ✓`);
  } else if (cvr >= PPC_MIN_CVR) {
    ppcScore += 14;
    ppcDetails.push(`CVR: ${(cvr * 100).toFixed(1)}% ✓`);
  } else if (cvr >= PPC_MIN_CVR * 0.6) {
    ppcScore += 6;
    ppcDetails.push(`CVR: ${(cvr * 100).toFixed(1)}% (low)`);
  } else {
    ppcDetails.push(`CVR: ${(cvr * 100).toFixed(1)}% ✗`);
  }

  // Actual sales (max 10 pts)
  const orders = ppcMetrics.orders || 0;
  if (orders >= PPC_MIN_SALES * 2) {
    ppcScore += 10;
    ppcDetails.push(`orders: ${orders} ✓`);
  } else if (orders >= PPC_MIN_SALES) {
    ppcScore += 7;
    ppcDetails.push(`orders: ${orders} ✓`);
  } else if (orders >= 1) {
    ppcScore += 3;
    ppcDetails.push(`orders: ${orders} (low)`);
  } else {
    ppcDetails.push(`orders: ${orders} ✗`);
  }

  // ACoS (max 10 pts)
  const acos = ppcMetrics.sales > 0 ? ppcMetrics.spend / ppcMetrics.sales : 1;
  if (acos <= 0.2) {
    ppcScore += 10;
    ppcDetails.push(`ACoS: ${(acos * 100).toFixed(0)}% ✓`);
  } else if (acos <= PPC_MAX_ACOS) {
    ppcScore += 6;
    ppcDetails.push(`ACoS: ${(acos * 100).toFixed(0)}% ✓`);
  } else {
    ppcDetails.push(`ACoS: ${(acos * 100).toFixed(0)}% ✗`);
  }

  // Combine: weight pre-validation (60%) + PPC (40%)
  const preScore = preValidation?.score || 0;
  const combinedScore = Math.round(preScore * 0.6 + ppcScore * (100 / 50) * 0.4);

  const passed = combinedScore >= FINAL_VALIDATION_MIN;

  // Confidence level
  let confidence;
  if (combinedScore >= 85) confidence = "very high";
  else if (combinedScore >= 75) confidence = "high";
  else if (combinedScore >= 65) confidence = "medium";
  else confidence = "low";

  const reason = [
    `Final score: ${combinedScore}/100 (need ${FINAL_VALIDATION_MIN})`,
    `Pre-PPC: ${preScore}/100`,
    `PPC: ${ppcDetails.join(", ")}`,
  ].join(" | ");

  console.log(`[Validation] Post-PPC result: ${passed ? "PASSED" : "FAILED"} — ${reason}`);

  return { score: combinedScore, passed, reason, confidence };
}

// ─── Seasonal Warning ─────────────────────────────────────────────────────────

/**
 * Return a warning if the product is seasonal and we're in the wrong time of year.
 */
export function getSeasonalWarning(product) {
  if (!product.validationSignals?.googleTrend?.seasonal) return null;

  const month = new Date().getMonth(); // 0-11
  const keyword = (product.title || "").toLowerCase();

  const seasonalPatterns = [
    { keywords: ["christmas", "holiday", "xmas"], peakMonths: [10, 11], name: "Christmas" },
    { keywords: ["halloween", "costume"], peakMonths: [8, 9], name: "Halloween" },
    { keywords: ["summer", "beach", "pool", "outdoor"], peakMonths: [4, 5, 6], name: "Summer" },
    { keywords: ["winter", "snow", "cold", "warm"], peakMonths: [10, 11, 0, 1], name: "Winter" },
    { keywords: ["valentine", "heart"], peakMonths: [0, 1], name: "Valentine's Day" },
    { keywords: ["back to school", "school supply"], peakMonths: [6, 7], name: "Back to School" },
  ];

  for (const pattern of seasonalPatterns) {
    if (pattern.keywords.some((k) => keyword.includes(k))) {
      const inSeason = pattern.peakMonths.includes(month);
      if (!inSeason) {
        const monthsToSeason = Math.min(
          ...pattern.peakMonths.map((m) => ((m - month + 12) % 12))
        );
        return `⚠️ ${pattern.name} product — ${monthsToSeason} months until peak season. Order inventory in ${monthsToSeason - 2} months.`;
      }
    }
  }

  return "⚠️ Seasonal product detected — monitor trend carefully before ordering large inventory.";
}
