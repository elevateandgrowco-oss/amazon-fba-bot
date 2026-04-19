// product_researcher.js — Scrapes Amazon Best Sellers, scores FBA opportunities

import { calculateFBAFees, calculateMargin, bsrToMonthlySales, scoreProduct } from "./fee_calculator.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Lazy init puppeteer so it doesn't block server startup
let puppeteerReady = false;
let puppeteer;

async function initPuppeteer() {
  if (puppeteerReady) return;
  const { default: pExtra } = await import("puppeteer-extra");
  const { default: StealthPlugin } = await import("puppeteer-extra-plugin-stealth");
  pExtra.use(StealthPlugin());
  puppeteer = pExtra;
  puppeteerReady = true;
}

const CATEGORIES = [
  { name: "Home & Kitchen",           url: "https://www.amazon.com/gp/bestsellers/home-garden" },
  { name: "Sports & Outdoors",        url: "https://www.amazon.com/gp/bestsellers/sporting-goods" },
  { name: "Toys & Games",             url: "https://www.amazon.com/gp/bestsellers/toys-and-games" },
  { name: "Health & Household",       url: "https://www.amazon.com/gp/bestsellers/hpc" },
  { name: "Beauty & Personal Care",   url: "https://www.amazon.com/gp/bestsellers/beauty" },
  { name: "Office Products",          url: "https://www.amazon.com/gp/bestsellers/office-products" },
  { name: "Pet Supplies",             url: "https://www.amazon.com/gp/bestsellers/pet-supplies" },
  { name: "Tools & Home Improvement", url: "https://www.amazon.com/gp/bestsellers/hi" },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs = 1000, maxMs = 3000) {
  return sleep(Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs);
}

/**
 * Launch a stealth browser instance.
 */
async function launchBrowser() {
  await initPuppeteer();
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--no-first-run",
    "--no-zygote",
    "--single-process",
    "--disable-gpu",
  ];
  const opts = {
    headless: true,
    args,
  };
  if (execPath) opts.executablePath = execPath;
  return puppeteer.launch(opts);
}

/**
 * Set up a page with common headers and timeouts.
 */
async function setupPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  });
  page.setDefaultNavigationTimeout(30000);
  return page;
}

/**
 * Check if the page has a CAPTCHA.
 */
async function hasCaptcha(page) {
  try {
    const captcha = await page.$("#captchacharacters");
    if (captcha) return true;
    const title = await page.title();
    if (title.toLowerCase().includes("robot") || title.toLowerCase().includes("captcha")) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Scrape best sellers for a single category.
 * @param {object} category - { name, url }
 * @param {object} browser - Puppeteer browser instance
 * @returns {Array} raw product objects
 */
export async function scrapeCategory(category, browser) {
  const page = await setupPage(browser);
  const products = [];

  try {
    console.log(`[Researcher] Scraping category: ${category.name}`);
    await page.goto(category.url, { waitUntil: "domcontentloaded" });
    await sleep(1500);

    if (await hasCaptcha(page)) {
      console.warn(`[Researcher] CAPTCHA detected on ${category.name} — skipping`);
      await page.close();
      return [];
    }

    const items = await page.evaluate(() => {
      const results = [];

      // Try both selector patterns Amazon uses
      const containers = [
        ...document.querySelectorAll(".zg-item-immersion"),
        ...document.querySelectorAll(".p13n-sc-uncoverable-faceout"),
      ];

      // Dedupe by checking we only got unique items
      const seen = new Set();
      let rank = 1;

      for (const el of containers) {
        const asin =
          el.getAttribute("data-asin") ||
          el.closest("[data-asin]")?.getAttribute("data-asin") ||
          "";
        if (!asin || seen.has(asin)) continue;
        seen.add(asin);

        // Title
        const titleEl =
          el.querySelector(".p13n-sc-truncate-desktop-type2") ||
          el.querySelector(".p13n-sc-truncate") ||
          el.querySelector("._cDEzb_p13n-sc-css-line-clamp-3_g3dy1") ||
          el.querySelector("a span");
        const title = titleEl?.textContent?.trim() || "";

        // Price
        const priceEl = el.querySelector(".p13n-sc-price") || el.querySelector(".a-price .a-offscreen");
        const priceText = priceEl?.textContent?.trim() || "";
        const price = parseFloat(priceText.replace(/[^0-9.]/g, "")) || 0;

        // Rating
        const ratingEl = el.querySelector(".a-icon-alt");
        const ratingText = ratingEl?.textContent?.trim() || "";
        const rating = parseFloat(ratingText.split(" ")[0]) || 0;

        // Review count
        const reviewEl = el.querySelector(".a-size-small a") || el.querySelector("[aria-label*='stars'] ~ span a");
        const reviewText = reviewEl?.textContent?.trim().replace(/,/g, "") || "0";
        const reviewCount = parseInt(reviewText.replace(/[^0-9]/g, ""), 10) || 0;

        if (asin && title) {
          results.push({ asin, title, price, rating, reviewCount, bsr: rank });
          rank++;
        }

        if (rank > 50) break;
      }

      return results;
    });

    for (const item of items) {
      products.push({ ...item, category: category.name });
    }

    console.log(`[Researcher] Found ${products.length} products in ${category.name}`);
  } catch (err) {
    console.error(`[Researcher] Error scraping ${category.name}:`, err.message);
  } finally {
    await page.close();
  }

  return products;
}

/**
 * Scrape additional product details from a product detail page.
 * @param {string} asin
 * @param {object} browser
 * @returns {{ fullBSR, weightLbs, dimensions }}
 */
export async function scrapeProductDetails(asin, browser) {
  const page = await setupPage(browser);
  const details = { fullBSR: 0, weightLbs: 1.0, dimensions: "" };

  try {
    await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: "domcontentloaded" });
    await sleep(1200);

    if (await hasCaptcha(page)) {
      console.warn(`[Researcher] CAPTCHA on product detail page ${asin} — skipping`);
      await page.close();
      return details;
    }

    const extracted = await page.evaluate(() => {
      const result = { fullBSR: 0, weightLbs: 1.0, dimensions: "" };

      // BSR — look in product details table or feature bullets
      const allText = document.body.innerText;
      const bsrMatch = allText.match(/Best Sellers Rank.*?#([\d,]+)/);
      if (bsrMatch) {
        result.fullBSR = parseInt(bsrMatch[1].replace(/,/g, ""), 10) || 0;
      }

      // Product details table rows
      const detailRows = document.querySelectorAll("#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, .detail-bullet-list span");
      const tableText = Array.from(detailRows).map((r) => r.textContent).join(" ");

      // Weight
      const weightMatch = tableText.match(/(\d+\.?\d*)\s*(pounds?|lbs?|ounces?|oz)/i);
      if (weightMatch) {
        const val = parseFloat(weightMatch[1]);
        const unit = weightMatch[2].toLowerCase();
        result.weightLbs = unit.startsWith("oz") || unit.startsWith("ounce") ? val / 16 : val;
      }

      // Dimensions
      const dimMatch = tableText.match(/(\d+\.?\d*\s*x\s*\d+\.?\d*\s*x\s*\d+\.?\d*\s*(inches|in)?)/i);
      if (dimMatch) result.dimensions = dimMatch[1].trim();

      return result;
    });

    Object.assign(details, extracted);
  } catch (err) {
    console.error(`[Researcher] Error scraping detail page ${asin}:`, err.message);
  } finally {
    await page.close();
  }

  return details;
}

/**
 * Search Amazon for a specific keyword and return raw products.
 */
async function searchByKeyword(keyword, browser) {
  const page = await setupPage(browser);
  const products = [];

  try {
    const url = `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}`;
    console.log(`[Researcher] Searching Amazon for: "${keyword}"`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await sleep(1500);

    if (await hasCaptcha(page)) {
      console.warn(`[Researcher] CAPTCHA on search "${keyword}" — skipping`);
      return [];
    }

    const items = await page.evaluate(() => {
      const results = [];
      const containers = document.querySelectorAll('[data-component-type="s-search-result"]');

      for (const el of containers) {
        const asin = el.getAttribute("data-asin");
        if (!asin) continue;

        const titleEl = el.querySelector("h2 span");
        const title = titleEl?.textContent?.trim() || "";

        const priceEl = el.querySelector(".a-price .a-offscreen");
        const priceText = priceEl?.textContent?.trim() || "";
        const price = parseFloat(priceText.replace(/[^0-9.]/g, "")) || 0;

        const ratingEl = el.querySelector("[aria-label*='out of 5 stars']");
        const ratingText = ratingEl?.getAttribute("aria-label") || "";
        const rating = parseFloat(ratingText) || 0;

        const reviewEl = el.querySelector(".a-size-base.s-underline-text");
        const reviewText = reviewEl?.textContent?.trim().replace(/,/g, "") || "0";
        const reviewCount = parseInt(reviewText.replace(/[^0-9]/g, ""), 10) || 0;

        if (asin && title && price > 0) {
          results.push({ asin, title, price, rating, reviewCount });
        }

        if (results.length >= 20) break;
      }

      return results;
    });

    products.push(...items.map((item) => ({ ...item, category: "YouTube Lead", bsr: 50000 })));
    console.log(`[Researcher] Found ${products.length} results for "${keyword}"`);
  } catch (err) {
    console.error(`[Researcher] Error searching for "${keyword}":`, err.message);
  } finally {
    await page.close();
  }

  return products;
}

/**
 * Search Amazon for YouTube-sourced product keywords and return scored leads.
 * @param {string[]} keywords
 * @param {number} maxLeads
 * @returns {Array} scored product leads
 */
export async function searchByKeywords(keywords, maxLeads = 20) {
  console.log(`[Researcher] Searching Amazon for ${keywords.length} YouTube-sourced keywords...`);
  let browser;
  const allProducts = [];

  try {
    browser = await launchBrowser();

    // Cap at 10 keywords to avoid bans + stay within time budget
    const batch = keywords.slice(0, 10);

    for (let i = 0; i < batch.length; i++) {
      try {
        const products = await searchByKeyword(batch[i], browser);
        allProducts.push(...products);
      } catch (err) {
        console.error(`[Researcher] Search failed for "${batch[i]}":`, err.message);
      }
      if (i < batch.length - 1) await randomDelay(1500, 3000);
    }

    const candidates = allProducts.filter(
      (p) => p.price >= 10 && p.price <= 120 && p.reviewCount <= 3000
    );

    console.log(`[Researcher] YouTube candidates after filter: ${candidates.length}`);

    const detailBatch = candidates
      .sort((a, b) => a.reviewCount - b.reviewCount)
      .slice(0, 20);

    const enriched = [];

    for (let i = 0; i < detailBatch.length; i++) {
      const product = detailBatch[i];
      try {
        const details = await scrapeProductDetails(product.asin, browser);
        const bsr = details.fullBSR > 0 ? details.fullBSR : 50000;
        const weightLbs = details.weightLbs || 1.0;
        const cogsRate = 0.25 + Math.random() * 0.05;
        const estimatedCOGS = parseFloat((product.price * cogsRate).toFixed(2));

        const { profit, margin, roi, totalFees } = calculateMargin(
          product.price,
          estimatedCOGS,
          weightLbs,
          "Home & Kitchen" // use default referral rate
        );

        const estimatedMonthlySales = bsrToMonthlySales(bsr);
        const opportunityScore = scoreProduct({
          price: product.price,
          reviewCount: product.reviewCount,
          rating: product.rating,
          bsr,
          margin,
        });

        enriched.push({
          ...product,
          bsr,
          weightLbs,
          dimensions: details.dimensions,
          estimatedCOGS,
          fbaFees: totalFees,
          estimatedProfit: profit,
          estimatedMonthlySales,
          estimatedMonthlyRevenue: parseFloat((estimatedMonthlySales * product.price).toFixed(2)),
          margin,
          roi,
          opportunityScore,
          source: "youtube",
        });
      } catch (err) {
        console.error(`[Researcher] Error enriching YouTube lead ${product.asin}:`, err.message);
      }
      if (i < detailBatch.length - 1) await randomDelay(1000, 2000);
    }

    const leads = enriched
      .filter((p) => p.opportunityScore >= 50 && p.margin >= 25)
      .sort((a, b) => b.opportunityScore - a.opportunityScore)
      .slice(0, maxLeads);

    console.log(`[Researcher] YouTube leads after scoring: ${leads.length}`);
    return leads;
  } catch (err) {
    console.error("[Researcher] Fatal error in searchByKeywords:", err.message);
    return [];
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

/**
 * Main entry point — find FBA product leads.
 * @param {number} maxLeads - Maximum number of leads to return
 * @returns {Array} scored product leads
 */
export async function findLeads(maxLeads = 20) {
  console.log("[Researcher] Starting product research...");
  let browser;
  const allProducts = [];

  try {
    browser = await launchBrowser();

    for (let i = 0; i < CATEGORIES.length; i++) {
      const category = CATEGORIES[i];
      try {
        const products = await scrapeCategory(category, browser);
        allProducts.push(...products);
      } catch (err) {
        console.error(`[Researcher] Category scrape failed for ${category.name}:`, err.message);
      }

      // Delay between categories
      if (i < CATEGORIES.length - 1) {
        await randomDelay(1500, 3000);
      }
    }

    console.log(`[Researcher] Total raw products scraped: ${allProducts.length}`);

    // Filter to candidates worth researching further
    const candidates = allProducts.filter((p) => {
      if (p.price < 10 || p.price > 120) return false;
      if (p.reviewCount > 3000) return false;
      return true;
    });

    console.log(`[Researcher] Candidates after initial filter: ${candidates.length}`);

    // Scrape product detail pages for top candidates (limit to 30 to avoid bans)
    const detailCandidates = candidates
      .sort((a, b) => a.reviewCount - b.reviewCount)
      .slice(0, 30);

    const enriched = [];
    for (let i = 0; i < detailCandidates.length; i++) {
      const product = detailCandidates[i];
      try {
        const details = await scrapeProductDetails(product.asin, browser);

        // Use full BSR if available, otherwise use page position rank
        // Use full BSR from detail page; fall back to category rank * 100 (conservative estimate)
        const bsr = details.fullBSR > 0 ? details.fullBSR : Math.max(product.bsr * 100, 5000);
        if (!details.fullBSR) console.warn(`[Researcher] No full BSR for ${product.asin} — using estimated ${bsr}`);
        const weightLbs = details.weightLbs || 1.0;

        // Estimate COGS at 25-30% of selling price (source from China)
        const cogsRate = 0.25 + Math.random() * 0.05;
        const estimatedCOGS = parseFloat((product.price * cogsRate).toFixed(2));

        const { profit, margin, roi, totalFees } = calculateMargin(
          product.price,
          estimatedCOGS,
          weightLbs,
          product.category
        );

        const estimatedMonthlySales = bsrToMonthlySales(bsr);
        const estimatedMonthlyRevenue = parseFloat((estimatedMonthlySales * product.price).toFixed(2));

        const enrichedProduct = {
          ...product,
          bsr,
          weightLbs,
          dimensions: details.dimensions,
          estimatedCOGS,
          fbaFees: totalFees,
          estimatedProfit: profit,
          estimatedMonthlySales,
          estimatedMonthlyRevenue,
          margin,
          roi,
        };

        const opportunityScore = scoreProduct({
          price: product.price,
          reviewCount: product.reviewCount,
          rating: product.rating,
          bsr,
          margin,
        });

        enrichedProduct.opportunityScore = opportunityScore;
        enriched.push(enrichedProduct);
      } catch (err) {
        console.error(`[Researcher] Error enriching ${product.asin}:`, err.message);
      }

      if (i < detailCandidates.length - 1) {
        await randomDelay(1000, 2500);
      }
    }

    // Filter by minimum quality thresholds
    const leads = enriched
      .filter((p) => p.opportunityScore >= 50 && p.margin >= 25)
      .sort((a, b) => b.opportunityScore - a.opportunityScore)
      .slice(0, maxLeads);

    console.log(`[Researcher] Final leads after scoring: ${leads.length}`);
    return leads;
  } catch (err) {
    console.error("[Researcher] Fatal error in findLeads:", err.message);
    return [];
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}
