// rank_tracker.js — Track keyword rankings for your listings on Amazon search results

import { Resend } from "resend";
import { loadDB, saveDB } from "./products_db.js";

const resend = new Resend(process.env.RESEND_API_KEY);

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// How many search result pages to scan (16 results per page)
const MAX_PAGES = 3; // covers positions 1–48
// Alert when rank drops by this many positions
const RANK_DROP_ALERT_THRESHOLD = 10;

let puppeteer;
let puppeteerReady = false;

async function initPuppeteer() {
  if (puppeteerReady) return;
  const { default: pExtra } = await import("puppeteer-extra");
  const { default: StealthPlugin } = await import("puppeteer-extra-plugin-stealth");
  pExtra.use(StealthPlugin());
  puppeteer = pExtra;
  puppeteerReady = true;
}

async function launchBrowser() {
  await initPuppeteer();
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  return puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--single-process", "--no-zygote", "--disable-gpu"],
    ...(execPath ? { executablePath: execPath } : {}),
  });
}

/**
 * Search Amazon for a keyword and find the rank of an ASIN in results.
 * @param {string} keyword
 * @param {string} asin
 * @param {object} page - Puppeteer page
 * @returns {number} rank (1-based) or -1 if not found in first MAX_PAGES pages
 */
async function findAsinRank(keyword, asin, page) {
  let globalPosition = 0;

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    try {
      const url =
        `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}&page=${pageNum}`;

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));

      // Check for CAPTCHA
      const title = await page.title();
      if (title.toLowerCase().includes("robot") || title.toLowerCase().includes("captcha")) {
        console.warn(`[Rank] CAPTCHA on keyword "${keyword}" page ${pageNum}`);
        return -1;
      }

      const { found, position, totalResults } = await page.evaluate((targetAsin) => {
        const results = document.querySelectorAll(
          '[data-component-type="s-search-result"][data-asin]'
        );
        let pos = 0;
        for (const el of results) {
          const elAsin = el.getAttribute("data-asin");
          if (!elAsin) continue;
          pos++;
          if (elAsin === targetAsin) {
            return { found: true, position: pos, totalResults: results.length };
          }
        }
        return { found: false, position: -1, totalResults: results.length };
      }, asin);

      if (found) {
        return globalPosition + position;
      }

      globalPosition += totalResults || 16;

      // Small delay between pages
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
    } catch (err) {
      console.error(`[Rank] Error on page ${pageNum} for "${keyword}":`, err.message);
      break;
    }
  }

  return -1; // Not ranked in first MAX_PAGES pages
}

/**
 * Send rank drop alert email.
 */
async function sendRankAlert(drops) {
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL) return;

  const rows = drops
    .map(
      (d) => `
      <tr>
        <td style="padding:10px;font-size:13px;">
          <a href="https://www.amazon.com/dp/${d.asin}" style="color:#0066c0;">${d.title?.slice(0, 45) || d.asin}</a>
        </td>
        <td style="padding:10px;font-size:13px;font-style:italic;color:#555;">"${d.keyword}"</td>
        <td style="padding:10px;font-size:13px;text-align:center;color:#27ae60;font-weight:bold;">#${d.previousRank}</td>
        <td style="padding:10px;font-size:13px;text-align:center;color:#e74c3c;font-weight:bold;">#${d.currentRank === -1 ? "50+" : d.currentRank}</td>
        <td style="padding:10px;font-size:13px;text-align:center;color:#e74c3c;">▼ ${d.drop === 999 ? "50+" : d.drop} positions</td>
      </tr>
    `
    )
    .join("");

  await resend.emails.send({
    from: process.env.FROM_EMAIL || "bot@yourdomain.com",
    to: process.env.ALERT_EMAIL,
    subject: `Keyword Rank Drop Alert — ${drops.length} keyword${drops.length > 1 ? "s" : ""} slipping`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:700px;color:#222;">
        <div style="background:#8e44ad;color:white;padding:16px 20px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;">Keyword Rank Drop Detected</h2>
        </div>
        <div style="border:1px solid #8e44ad;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
          <p style="margin-top:0;">Your rankings dropped significantly for these keywords. Lower rankings = less organic traffic = less revenue:</p>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:#f8f8f8;">
                <th style="padding:8px;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">Product</th>
                <th style="padding:8px;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">Keyword</th>
                <th style="padding:8px;text-align:center;font-size:12px;text-transform:uppercase;color:#666;">Before</th>
                <th style="padding:8px;text-align:center;font-size:12px;text-transform:uppercase;color:#666;">Now</th>
                <th style="padding:8px;text-align:center;font-size:12px;text-transform:uppercase;color:#666;">Change</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:20px;padding:12px;background:#f8f0ff;border-radius:6px;font-size:13px;">
            <strong>What causes rank drops:</strong><br>
            • Lower sales velocity (check if PPC is still running)<br>
            • Competitors undercutting your price significantly<br>
            • New negative reviews dropping conversion rate<br>
            • Listing changed or suppressed by Amazon
          </div>
        </div>
      </div>
    `,
  });
}

/**
 * Track keyword rankings for all launched products.
 * Checks top 3 keywords per product to stay within rate limits.
 * @param {boolean} dryRun
 * @returns {Array} ranking results with alerts
 */
export async function trackKeywordRanks(dryRun = false) {
  console.log("[Rank] Starting keyword rank tracking...");

  const db = loadDB();
  const launched = (db.opportunities || []).filter(
    (p) => (p.status === "launched" || p.status === "validating") &&
            p.asin &&
            p.keywords?.length > 0
  );

  if (launched.length === 0) {
    console.log("[Rank] No launched products with keywords — skipping");
    return [];
  }

  let browser;
  const rankDropAlerts = [];
  const allResults = [];

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });

    for (const product of launched) {
      // Track top 3 keywords per product (balance coverage vs rate limiting)
      const keywordsToTrack = (product.keywords || []).slice(0, 3);
      const rankHistory = product.rankHistory || {};
      const currentRanks = {};

      console.log(`[Rank] Checking ${product.asin}: "${product.title?.slice(0, 40)}"`);

      for (const keyword of keywordsToTrack) {
        try {
          const rank = await findAsinRank(keyword, product.asin, page);

          console.log(`[Rank] "${keyword}" → ${rank === -1 ? "Not ranked (50+)" : `#${rank}`}`);

          currentRanks[keyword] = {
            rank,
            checkedAt: new Date().toISOString(),
          };

          // Compare with previous rank
          const previousEntry = rankHistory[keyword];
          if (previousEntry && previousEntry.rank !== -1 && rank !== -1) {
            const drop = rank - previousEntry.rank;
            if (drop >= RANK_DROP_ALERT_THRESHOLD) {
              rankDropAlerts.push({
                asin: product.asin,
                title: product.title,
                keyword,
                previousRank: previousEntry.rank,
                currentRank: rank,
                drop,
              });
            }
          } else if (previousEntry && previousEntry.rank !== -1 && rank === -1) {
            // Fell off the first 3 pages entirely
            rankDropAlerts.push({
              asin: product.asin,
              title: product.title,
              keyword,
              previousRank: previousEntry.rank,
              currentRank: -1,
              drop: 999,
            });
          }

          allResults.push({ asin: product.asin, keyword, rank });

          // Delay between keyword searches
          await new Promise((r) => setTimeout(r, 2500 + Math.random() * 1500));
        } catch (err) {
          console.error(`[Rank] Error tracking "${keyword}" for ${product.asin}:`, err.message);
        }
      }

      // Save rank history to DB
      const updatedHistory = { ...rankHistory };
      for (const [kw, data] of Object.entries(currentRanks)) {
        updatedHistory[kw] = data;
      }

      const db2 = loadDB();
      const idx = db2.opportunities.findIndex((o) => o.asin === product.asin);
      if (idx !== -1) {
        db2.opportunities[idx] = {
          ...db2.opportunities[idx],
          rankHistory: updatedHistory,
          lastRankCheckAt: new Date().toISOString(),
          currentRanks: Object.fromEntries(
            Object.entries(currentRanks).map(([kw, d]) => [kw, d.rank])
          ),
        };
        saveDB(db2);
      }

      // Delay between products
      await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
    }
  } catch (err) {
    console.error("[Rank] Fatal error:", err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  if (rankDropAlerts.length > 0 && !dryRun) {
    try {
      await sendRankAlert(rankDropAlerts);
      console.log(`[Rank] Alert sent for ${rankDropAlerts.length} rank drop(s)`);
    } catch (err) {
      console.error("[Rank] Failed to send rank alert:", err.message);
    }
  } else if (rankDropAlerts.length > 0 && dryRun) {
    console.log(`[Rank] DRY RUN — ${rankDropAlerts.length} rank drops detected`);
  }

  console.log(`[Rank] Done — tracked ${allResults.length} keyword rankings, ${rankDropAlerts.length} drops`);
  return { results: allResults, alerts: rankDropAlerts };
}
