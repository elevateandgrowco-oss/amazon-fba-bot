// competitor_tracker.js — Monitor tracked products for BSR/price/stock changes

import { getTrackedProducts, updateOpportunity, saveDB } from "./products_db.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Lazy puppeteer init
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs = 1000, maxMs = 3000) {
  return sleep(Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs);
}

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
  const opts = { headless: true, args };
  if (execPath) opts.executablePath = execPath;
  return puppeteer.launch(opts);
}

/**
 * Scrape current price, BSR, review count, and stock status for a product.
 * @param {string} asin
 * @param {object} browser
 * @returns {{ price, bsr, reviewCount, inStock }}
 */
async function scrapeProductStatus(asin, browser) {
  const page = await browser.newPage();
  const status = { price: 0, bsr: 0, reviewCount: 0, inStock: true };

  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    page.setDefaultNavigationTimeout(30000);

    await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: "domcontentloaded" });
    await sleep(1200);

    // Check for CAPTCHA
    const captcha = await page.$("#captchacharacters");
    const pageTitle = await page.title().catch(() => "");
    if (captcha || pageTitle.toLowerCase().includes("robot") || pageTitle.toLowerCase().includes("captcha")) {
      console.warn(`[Tracker] CAPTCHA on ${asin} — skipping`);
      await page.close();
      return null;
    }

    const extracted = await page.evaluate(() => {
      const result = { price: 0, bsr: 0, reviewCount: 0, inStock: true };

      // Price — try multiple selectors
      const priceSelectors = [
        "#priceblock_ourprice",
        "#priceblock_dealprice",
        ".a-price .a-offscreen",
        "#price_inside_buybox",
        "#apex_offerDisplay_desktop .a-price .a-offscreen",
        ".priceToPay .a-offscreen",
      ];
      for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const val = parseFloat(el.textContent.replace(/[^0-9.]/g, ""));
          if (val > 0) {
            result.price = val;
            break;
          }
        }
      }

      // BSR
      const allText = document.body.innerText;
      const bsrMatch = allText.match(/Best Sellers Rank.*?#([\d,]+)/);
      if (bsrMatch) {
        result.bsr = parseInt(bsrMatch[1].replace(/,/g, ""), 10) || 0;
      }

      // Review count
      const reviewEl = document.querySelector("#acrCustomerReviewText");
      if (reviewEl) {
        const reviewText = reviewEl.textContent.replace(/,/g, "");
        result.reviewCount = parseInt(reviewText.match(/\d+/)?.[0] || "0", 10);
      }

      // Stock status
      const addToCartBtn = document.querySelector("#add-to-cart-button");
      const outOfStockMsg = document.querySelector("#outOfStock, .a-color-error");
      const unavailable = allText.includes("Currently unavailable") || allText.includes("out of stock");
      result.inStock = !!(addToCartBtn) && !unavailable;
      if (outOfStockMsg) result.inStock = false;

      return result;
    });

    Object.assign(status, extracted);
  } catch (err) {
    console.error(`[Tracker] Error scraping ${asin}:`, err.message);
    return null;
  } finally {
    await page.close();
  }

  return status;
}

/**
 * Track competitors and detect significant changes.
 * @param {object} db - Full database object (mutated in place)
 * @param {boolean} dryRun - If true, scrape but don't save
 * @returns {Array} alert objects
 */
export async function trackCompetitors(db, dryRun = false) {
  console.log(`[Tracker] Starting competitor tracking... (dryRun=${dryRun})`);

  const tracked = getTrackedProducts(db);
  if (tracked.length === 0) {
    console.log("[Tracker] No tracked products found — nothing to do");
    return [];
  }

  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const now = Date.now();

  // Filter out recently checked (within 6 hours)
  const toCheck = tracked
    .filter((p) => {
      if (!p.lastChecked) return true;
      return now - new Date(p.lastChecked).getTime() > SIX_HOURS;
    })
    .slice(0, 20); // Max 20 per run

  console.log(`[Tracker] Products to check: ${toCheck.length} of ${tracked.length} tracked`);

  if (toCheck.length === 0) {
    console.log("[Tracker] All products checked recently — skipping");
    return [];
  }

  let browser;
  const allAlerts = [];

  try {
    browser = await launchBrowser();

    for (let i = 0; i < toCheck.length; i++) {
      const product = toCheck[i];
      console.log(`[Tracker] Checking ${product.asin}: ${product.title.slice(0, 50)}`);

      try {
        const current = await scrapeProductStatus(product.asin, browser);

        if (!current) {
          console.warn(`[Tracker] Could not scrape ${product.asin} — skipping`);
          continue;
        }

        const alerts = [];
        const nowISO = new Date().toISOString();

        // --- Price change detection ---
        const prevPrice = product.price || 0;
        if (prevPrice > 0 && current.price > 0) {
          const priceDrop = ((prevPrice - current.price) / prevPrice) * 100;
          if (priceDrop >= 10) {
            alerts.push({
              type: "price_drop",
              asin: product.asin,
              title: product.title,
              prevPrice,
              currentPrice: current.price,
              dropPercent: priceDrop.toFixed(1),
              message: `Price dropped ${priceDrop.toFixed(1)}% from $${prevPrice} to $${current.price}`,
            });
          }
        }

        // --- Stock status detection ---
        if (product.inStock !== false && !current.inStock) {
          alerts.push({
            type: "competitor_oos",
            asin: product.asin,
            title: product.title,
            message: `Competitor went OUT OF STOCK — opportunity to capture Buy Box!`,
          });
        }

        // --- BSR change detection ---
        const prevBSR = product.bsr || 0;
        if (prevBSR > 0 && current.bsr > 0) {
          const bsrImprovement = ((prevBSR - current.bsr) / prevBSR) * 100;
          if (bsrImprovement >= 20) {
            alerts.push({
              type: "trending_up",
              asin: product.asin,
              title: product.title,
              prevBSR,
              currentBSR: current.bsr,
              improvementPercent: bsrImprovement.toFixed(1),
              message: `BSR improved ${bsrImprovement.toFixed(1)}% (${prevBSR} → ${current.bsr}) — product trending up`,
            });
          }
        }

        // --- Review spike detection ---
        const prevReviews = product.reviews || 0;
        if (prevReviews > 0 && current.reviewCount > 0) {
          const newReviews = current.reviewCount - prevReviews;
          if (newReviews >= 20) {
            alerts.push({
              type: "review_spike",
              asin: product.asin,
              title: product.title,
              prevReviews,
              currentReviews: current.reviewCount,
              newReviews,
              message: `Review spike: +${newReviews} new reviews (${prevReviews} → ${current.reviewCount})`,
            });
          }
        }

        // --- Update price/BSR history (keep last 30 data points) ---
        if (!dryRun) {
          const priceHistory = [
            ...(product.priceHistory || []),
            { date: nowISO, price: current.price },
          ].slice(-30);

          const bsrHistory = [
            ...(product.bsrHistory || []),
            { date: nowISO, bsr: current.bsr },
          ].slice(-30);

          updateOpportunity(db, product.asin, {
            price: current.price || product.price,
            bsr: current.bsr || product.bsr,
            reviews: current.reviewCount || product.reviews,
            inStock: current.inStock,
            priceHistory,
            bsrHistory,
            lastChecked: nowISO,
          });
        }

        if (alerts.length > 0) {
          allAlerts.push(...alerts);
          console.log(`[Tracker] ${alerts.length} alert(s) for ${product.asin}`);
          alerts.forEach((a) => console.log(`  → ${a.message}`));
        }
      } catch (err) {
        console.error(`[Tracker] Error processing ${product.asin}:`, err.message);
      }

      if (i < toCheck.length - 1) {
        await randomDelay(1500, 3000);
      }
    }

    if (!dryRun && toCheck.length > 0) {
      db.lastCompetitorCheckAt = new Date().toISOString();
      saveDB(db);
    }

    console.log(`[Tracker] Done. Total alerts: ${allAlerts.length}`);
    return allAlerts;
  } catch (err) {
    console.error("[Tracker] Fatal error:", err.message);
    return allAlerts;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}
