// movers_shakers.js — Scrape Amazon Movers & Shakers for fast-rising products
// These are products with the biggest BSR improvement in 24 hours = proven demand spike

import { calculateFBAFees, calculateMargin, bsrToMonthlySales, scoreProduct } from "./fee_calculator.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MOVERS_CATEGORIES = [
  { name: "Home & Kitchen",           url: "https://www.amazon.com/gp/movers-and-shakers/home-garden" },
  { name: "Sports & Outdoors",        url: "https://www.amazon.com/gp/movers-and-shakers/sporting-goods" },
  { name: "Toys & Games",             url: "https://www.amazon.com/gp/movers-and-shakers/toys-and-games" },
  { name: "Health & Household",       url: "https://www.amazon.com/gp/movers-and-shakers/hpc" },
  { name: "Beauty & Personal Care",   url: "https://www.amazon.com/gp/movers-and-shakers/beauty" },
  { name: "Office Products",          url: "https://www.amazon.com/gp/movers-and-shakers/office-products" },
  { name: "Pet Supplies",             url: "https://www.amazon.com/gp/movers-and-shakers/pet-supplies" },
  { name: "Tools & Home Improvement", url: "https://www.amazon.com/gp/movers-and-shakers/hi" },
];

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function launchBrowser() {
  await initPuppeteer();
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  return puppeteer.launch({
    headless: true,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--single-process","--no-zygote","--disable-gpu"],
    ...(execPath ? { executablePath: execPath } : {}),
  });
}

async function scrapeMoverCategory(category, browser) {
  const page = await browser.newPage();
  const products = [];

  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });
    console.log(`[Movers] Scraping: ${category.name}`);

    await page.goto(category.url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await sleep(1500);

    // Check for CAPTCHA
    const title = await page.title();
    if (title.toLowerCase().includes("robot") || title.toLowerCase().includes("captcha")) {
      console.warn(`[Movers] CAPTCHA on ${category.name} — skipping`);
      return [];
    }

    const items = await page.evaluate(() => {
      const results = [];
      const containers = [
        ...document.querySelectorAll(".zg-item-immersion"),
        ...document.querySelectorAll(".p13n-sc-uncoverable-faceout"),
      ];

      const seen = new Set();

      for (const el of containers) {
        const asin = el.getAttribute("data-asin") || el.closest("[data-asin]")?.getAttribute("data-asin") || "";
        if (!asin || seen.has(asin)) continue;
        seen.add(asin);

        const titleEl =
          el.querySelector(".p13n-sc-truncate-desktop-type2") ||
          el.querySelector(".p13n-sc-truncate") ||
          el.querySelector("a span");
        const title = titleEl?.textContent?.trim() || "";

        const priceEl = el.querySelector(".p13n-sc-price") || el.querySelector(".a-price .a-offscreen");
        const price = parseFloat(priceEl?.textContent?.replace(/[^0-9.]/g, "") || "0") || 0;

        const ratingEl = el.querySelector(".a-icon-alt");
        const rating = parseFloat(ratingEl?.textContent?.split(" ")[0] || "0") || 0;

        const reviewEl = el.querySelector(".a-size-small a");
        const reviews = parseInt(reviewEl?.textContent?.replace(/,/g, "").replace(/[^0-9]/g, "") || "0", 10) || 0;

        // Movement indicator (% rise)
        const moveEl = el.querySelector(".zg-bdg-percent-change, .a-color-success");
        const moveText = moveEl?.textContent?.trim() || "";
        const moveMatch = moveText.match(/(\d+)/);
        const percentRise = moveMatch ? parseInt(moveMatch[1], 10) : 0;

        if (asin && title) {
          results.push({ asin, title, price, rating, reviewCount: reviews, percentRise });
        }

        if (results.length >= 30) break;
      }

      return results;
    });

    products.push(...items.map((item) => ({
      ...item,
      category: category.name,
      source: "movers_shakers",
    })));

    console.log(`[Movers] Found ${products.length} rising products in ${category.name}`);
  } catch (err) {
    console.error(`[Movers] Error scraping ${category.name}:`, err.message);
  } finally {
    await page.close();
  }

  return products;
}

/**
 * Find fast-rising products from Amazon Movers & Shakers.
 * These have proven demand spikes — strong signal for FBA opportunity.
 * @param {number} maxLeads
 * @returns {Array} scored product leads
 */
export async function findMovers(maxLeads = 15) {
  console.log("[Movers] Scanning Amazon Movers & Shakers...");
  let browser;
  const allProducts = [];

  try {
    browser = await launchBrowser();

    for (let i = 0; i < MOVERS_CATEGORIES.length; i++) {
      try {
        const products = await scrapeMoverCategory(MOVERS_CATEGORIES[i], browser);
        allProducts.push(...products);
      } catch (err) {
        console.error(`[Movers] Category failed: ${MOVERS_CATEGORIES[i].name}:`, err.message);
      }
      if (i < MOVERS_CATEGORIES.length - 1) {
        await sleep(Math.floor(Math.random() * 2000) + 1500);
      }
    }

    // Filter to viable FBA candidates
    const candidates = allProducts.filter((p) =>
      p.price >= 10 && p.price <= 120 && p.reviewCount <= 3000
    );

    // Score each product — boost score for high % rise
    const scored = candidates.map((p) => {
      const cogsRate = 0.25 + Math.random() * 0.05;
      const estimatedCOGS = parseFloat((p.price * cogsRate).toFixed(2));
      const weightLbs = 1.0; // default estimate
      const { profit, margin, roi, totalFees } = calculateMargin(p.price, estimatedCOGS, weightLbs, p.category);
      const bsr = 10000; // conservative estimate for new movers
      const estimatedMonthlySales = bsrToMonthlySales(bsr, p.category);

      let opportunityScore = scoreProduct({
        price: p.price,
        reviewCount: p.reviewCount,
        rating: p.rating,
        bsr,
        margin,
        category: p.category,
      });

      // Bonus points for strong upward movement
      if (p.percentRise >= 500) opportunityScore = Math.min(100, opportunityScore + 15);
      else if (p.percentRise >= 200) opportunityScore = Math.min(100, opportunityScore + 10);
      else if (p.percentRise >= 100) opportunityScore = Math.min(100, opportunityScore + 5);

      return {
        ...p,
        estimatedCOGS,
        fbaFees: totalFees,
        estimatedProfit: profit,
        estimatedMonthlySales,
        estimatedMonthlyRevenue: parseFloat((estimatedMonthlySales * p.price).toFixed(2)),
        margin,
        roi,
        bsr,
        opportunityScore,
      };
    });

    const leads = scored
      .filter((p) => p.opportunityScore >= 50 && p.margin >= 25)
      .sort((a, b) => b.opportunityScore - a.opportunityScore)
      .slice(0, maxLeads);

    console.log(`[Movers] ${leads.length} quality leads from Movers & Shakers`);
    return leads;
  } catch (err) {
    console.error("[Movers] Fatal error:", err.message);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
