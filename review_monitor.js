// review_monitor.js — Scrapes recent reviews on tracked products, alerts on negatives

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
 * Scrape the most recent reviews for a product.
 * @param {string} asin
 * @param {object} browser
 * @returns {Array} review objects
 */
async function scrapeRecentReviews(asin, browser) {
  const page = await browser.newPage();
  const reviews = [];

  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    page.setDefaultNavigationTimeout(30000);

    const url = `https://www.amazon.com/product-reviews/${asin}?sortBy=recent&reviewerType=all_reviews`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await sleep(1500);

    // Check for CAPTCHA
    const captcha = await page.$("#captchacharacters").catch(() => null);
    if (captcha) {
      console.warn(`[Reviews] CAPTCHA on ${asin} — skipping`);
      await page.close();
      return [];
    }

    const extracted = await page.evaluate(() => {
      const results = [];
      const reviewEls = document.querySelectorAll('[data-hook="review"]');

      for (const el of reviewEls) {
        if (results.length >= 10) break;

        // Rating
        const ratingEl = el.querySelector('[data-hook="review-star-rating"] .a-icon-alt, [data-hook="cmps-review-star-rating"] .a-icon-alt');
        const ratingText = ratingEl?.textContent?.trim() || "0 out of 5";
        const rating = parseFloat(ratingText.split(" ")[0]) || 0;

        // Title
        const titleEl = el.querySelector('[data-hook="review-title"] span:not(.a-icon-alt), [data-hook="review-title"]');
        const title = titleEl?.textContent?.trim().replace(/^\d+(\.\d+)?\s+out\s+of\s+5\s+stars?\s*/i, "") || "";

        // Body
        const bodyEl = el.querySelector('[data-hook="review-body"] span, [data-hook="review-body"]');
        const body = bodyEl?.textContent?.trim() || "";

        // Date
        const dateEl = el.querySelector('[data-hook="review-date"]');
        const date = dateEl?.textContent?.trim() || "";

        // Verified purchase
        const verifiedEl = el.querySelector('[data-hook="avp-badge"]');
        const verified = !!verifiedEl;

        // Review ID
        const reviewId = el.getAttribute("id") || el.getAttribute("data-hook-id") || `${title.slice(0, 20)}_${rating}`;

        if (title || body) {
          results.push({ reviewId, rating, title, body: body.slice(0, 500), date, verified });
        }
      }

      return results;
    });

    reviews.push(...extracted);
    console.log(`[Reviews] Scraped ${reviews.length} reviews for ${asin}`);
  } catch (err) {
    console.error(`[Reviews] Error scraping reviews for ${asin}:`, err.message);
  } finally {
    await page.close();
  }

  return reviews;
}

/**
 * Build a unique key for deduplicating reviews.
 * @param {object} review
 * @returns {string}
 */
function reviewKey(review) {
  return `${review.rating}_${(review.title || "").slice(0, 30)}_${(review.date || "").slice(0, 20)}`;
}

/**
 * Monitor reviews on all tracked products, alert on new negative reviews.
 * @param {object} db - Full database object (mutated in place)
 * @param {boolean} dryRun - If true, don't persist changes
 * @returns {Array} alert objects
 */
export async function monitorReviews(db, dryRun = false) {
  console.log(`[Reviews] Starting review monitoring... (dryRun=${dryRun})`);

  const tracked = getTrackedProducts(db);
  if (tracked.length === 0) {
    console.log("[Reviews] No tracked products — nothing to do");
    return [];
  }

  let browser;
  const allAlerts = [];

  try {
    browser = await launchBrowser();

    for (let i = 0; i < tracked.length; i++) {
      const product = tracked[i];
      console.log(`[Reviews] Checking reviews for ${product.asin}: ${product.title.slice(0, 50)}`);

      try {
        const freshReviews = await scrapeRecentReviews(product.asin, browser);

        if (freshReviews.length === 0) {
          console.log(`[Reviews] No reviews scraped for ${product.asin}`);
          continue;
        }

        // Build set of known review keys
        const knownKeys = new Set(
          (product.recentReviews || []).map(reviewKey)
        );

        // Find genuinely new reviews
        const newReviews = freshReviews.filter((r) => !knownKeys.has(reviewKey(r)));

        console.log(`[Reviews] ${newReviews.length} new reviews for ${product.asin}`);

        // Alert on negative new reviews (1-2 stars)
        const negativeNew = newReviews.filter((r) => r.rating <= 2);
        for (const review of negativeNew) {
          const alert = {
            type: "negative_review",
            asin: product.asin,
            title: product.title,
            reviewTitle: review.title,
            reviewBody: review.body,
            reviewRating: review.rating,
            reviewDate: review.date,
            message: `New ${review.rating}-star review: "${review.title}"`,
          };
          allAlerts.push(alert);
          console.log(`  → ALERT: ${alert.message}`);
        }

        if (!dryRun) {
          // Merge new reviews with stored ones, keep most recent 20
          const merged = [
            ...newReviews,
            ...(product.recentReviews || []),
          ]
            .filter((r, idx, arr) => {
              // Dedupe
              return arr.findIndex((x) => reviewKey(x) === reviewKey(r)) === idx;
            })
            .slice(0, 20);

          // Extract review themes for listing writer context
          const reviewThemes = extractThemes(merged);

          updateOpportunity(db, product.asin, {
            recentReviews: merged,
            reviewThemes,
          });
        }
      } catch (err) {
        console.error(`[Reviews] Error processing ${product.asin}:`, err.message);
      }

      if (i < tracked.length - 1) {
        await randomDelay(1500, 3000);
      }
    }

    if (!dryRun) {
      db.lastReviewCheckAt = new Date().toISOString();
      saveDB(db);
    }

    console.log(`[Reviews] Done. Total alerts: ${allAlerts.length}`);
    return allAlerts;
  } catch (err) {
    console.error("[Reviews] Fatal error:", err.message);
    return allAlerts;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

/**
 * Extract common themes from review set for use in listing copy.
 * @param {Array} reviews
 * @returns {{ positiveThemes: string[], negativeThemes: string[] }}
 */
function extractThemes(reviews) {
  const positive = reviews.filter((r) => r.rating >= 4).map((r) => r.title).filter(Boolean).slice(0, 5);
  const negative = reviews.filter((r) => r.rating <= 2).map((r) => r.title).filter(Boolean).slice(0, 5);
  return { positiveThemes: positive, negativeThemes: negative };
}
