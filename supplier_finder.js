// supplier_finder.js — Scrapes Alibaba for suppliers matching a product keyword

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

/**
 * Score a supplier based on trust signals.
 * @param {object} supplier
 * @returns {number}
 */
function scoreSupplier(supplier) {
  let score = 0;
  if (supplier.tradeAssurance) score += 30;
  if (supplier.years >= 5) score += 20;
  else if (supplier.years >= 2) score += 10;
  if (supplier.responseRate >= 90) score += 20;
  else if (supplier.responseRate >= 70) score += 10;
  if (supplier.verified) score += 15;
  // Bonus for lower MOQ (more accessible)
  if (supplier.moq > 0 && supplier.moq <= 50) score += 10;
  else if (supplier.moq <= 200) score += 5;
  return score;
}

/**
 * Parse price range text like "$1.50 - $3.00" → { min, max, text }
 */
function parsePriceRange(text) {
  if (!text) return { min: 0, max: 0, text: "" };
  const nums = text.match(/[\d.]+/g);
  if (!nums || nums.length === 0) return { min: 0, max: 0, text: text.trim() };
  const vals = nums.map(Number);
  return {
    min: vals[0] || 0,
    max: vals[1] || vals[0] || 0,
    text: text.trim(),
  };
}

/**
 * Find suppliers on Alibaba for a product keyword.
 * @param {string} productKeyword
 * @returns {Array} top 5 scored suppliers
 */
export async function findSuppliers(productKeyword) {
  console.log(`[Suppliers] Searching Alibaba for: "${productKeyword}"`);

  if (!productKeyword || productKeyword.trim().length < 2) {
    console.warn("[Suppliers] Empty keyword — skipping");
    return [];
  }

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

  let browser;
  try {
    browser = await puppeteer.launch(opts);
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    page.setDefaultNavigationTimeout(30000);

    const encoded = encodeURIComponent(productKeyword.trim());
    const searchUrl = `https://www.alibaba.com/trade/search?SearchText=${encoded}&IndexArea=product_en&tab=supplier`;

    await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
    await sleep(2000);

    // Check for CAPTCHA / verification page
    const pageTitle = await page.title();
    if (
      pageTitle.toLowerCase().includes("verify") ||
      pageTitle.toLowerCase().includes("captcha")
    ) {
      console.warn("[Suppliers] Verification page detected on Alibaba — returning empty");
      await browser.close();
      return [];
    }

    const rawSuppliers = await page.evaluate(() => {
      const results = [];

      // Alibaba supplier cards — try multiple selectors
      const cards = [
        ...document.querySelectorAll(".supplier-card"),
        ...document.querySelectorAll('[class*="supplier-info"]'),
        ...document.querySelectorAll(".organic-list-offer-outter"),
        ...document.querySelectorAll('[data-spm*="supplier"]'),
      ];

      // Dedupe by position
      const seen = new Set();
      let count = 0;

      for (const card of cards) {
        const html = card.innerHTML;
        const key = html.slice(0, 50);
        if (seen.has(key) || count >= 15) continue;
        seen.add(key);
        count++;

        // Company name
        const nameEl =
          card.querySelector(".supplier-name") ||
          card.querySelector('[class*="company-name"]') ||
          card.querySelector("h4") ||
          card.querySelector("h3");
        const name = nameEl?.textContent?.trim() || "";

        // Price range
        const priceEl =
          card.querySelector(".price") ||
          card.querySelector('[class*="price"]') ||
          card.querySelector(".offer-price");
        const priceRange = priceEl?.textContent?.trim() || "";

        // MOQ
        const moqEl =
          card.querySelector('[class*="moq"]') ||
          card.querySelector('[class*="min-order"]') ||
          card.querySelector("*[title*='Min. Order']");
        const moqText = moqEl?.textContent?.trim() || "100";

        // Response rate
        const responseEl = card.querySelector('[class*="response-rate"]') || card.querySelector('[title*="Response"]');
        const responseText = responseEl?.textContent?.trim() || "";

        // Years in business
        const yearsEl =
          card.querySelector('[class*="year"]') ||
          card.querySelector('[class*="years"]');
        const yearsText = yearsEl?.textContent?.trim() || "";

        // Trade assurance
        const tradeAssuranceEl =
          card.querySelector('[class*="trade-assurance"]') ||
          card.querySelector('[title*="Trade Assurance"]') ||
          card.querySelector('[alt*="Trade Assurance"]');
        const tradeAssurance = !!tradeAssuranceEl;

        // Verified supplier
        const verifiedEl =
          card.querySelector('[class*="verified"]') ||
          card.querySelector('[title*="Verified"]') ||
          card.querySelector('[alt*="Verified"]');
        const verified = !!verifiedEl;

        // Supplier URL
        const linkEl = card.querySelector("a[href]");
        const url = linkEl?.href || "";

        results.push({
          name,
          priceRange,
          moqText,
          responseText,
          yearsText,
          tradeAssurance,
          verified,
          url,
        });
      }

      return results;
    });

    // If supplier tab returned nothing, try product search and infer supplier info
    let suppliersToProcess = rawSuppliers;
    if (rawSuppliers.length === 0) {
      console.log("[Suppliers] Supplier tab empty, trying product search fallback");
      const productUrl = `https://www.alibaba.com/trade/search?SearchText=${encoded}&IndexArea=product_en`;
      await page.goto(productUrl, { waitUntil: "domcontentloaded" });
      await sleep(2000);

      const productSuppliers = await page.evaluate(() => {
        const results = [];
        const cards = document.querySelectorAll(".organic-list-offer-outter, .list-no-v2-outter, [class*='product-card']");

        let count = 0;
        for (const card of cards) {
          if (count >= 15) break;

          const nameEl = card.querySelector('[class*="company"]') || card.querySelector('[class*="supplier"]');
          const name = nameEl?.textContent?.trim() || `Supplier ${count + 1}`;

          const priceEl = card.querySelector(".price, [class*='price']");
          const priceRange = priceEl?.textContent?.trim() || "";

          const moqEl = card.querySelector('[class*="moq"], [class*="min"]');
          const moqText = moqEl?.textContent?.trim() || "100";

          const tradeAssuranceEl = card.querySelector('[class*="trade"], [alt*="Trade"]');
          const tradeAssurance = !!tradeAssuranceEl;

          const linkEl = card.querySelector("a[href]");
          const url = linkEl?.href || "";

          if (name || priceRange) {
            results.push({ name, priceRange, moqText, responseText: "", yearsText: "", tradeAssurance, verified: false, url });
            count++;
          }
        }
        return results;
      });
      suppliersToProcess = productSuppliers;
    }

    await browser.close();
    browser = null;

    if (suppliersToProcess.length === 0) {
      console.log("[Suppliers] No suppliers found for:", productKeyword);
      return [];
    }

    // Parse and score
    const processed = suppliersToProcess.map((s) => {
      const priceData = parsePriceRange(s.priceRange);

      // Parse MOQ
      const moqMatch = s.moqText.match(/(\d+)/);
      const moq = moqMatch ? parseInt(moqMatch[1], 10) : 100;

      // Parse response rate
      const respMatch = s.responseText.match(/(\d+)/);
      const responseRate = respMatch ? parseInt(respMatch[1], 10) : 0;

      // Parse years
      const yearsMatch = s.yearsText.match(/(\d+)/);
      const years = yearsMatch ? parseInt(yearsMatch[1], 10) : 0;

      const supplier = {
        name: s.name || "Unknown Supplier",
        priceRange: priceData.text || s.priceRange,
        priceMin: priceData.min,
        priceMax: priceData.max,
        moq,
        responseRate,
        years,
        tradeAssurance: s.tradeAssurance,
        verified: s.verified,
        url: s.url,
        score: 0,
      };
      supplier.score = scoreSupplier(supplier);
      return supplier;
    });

    const top5 = processed
      .filter((s) => s.name && s.name !== "Unknown Supplier")
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    // If we filtered too aggressively, take what we have
    const final = top5.length > 0 ? top5 : processed.slice(0, 5);

    console.log(`[Suppliers] Returning ${final.length} suppliers for "${productKeyword}"`);
    return final;
  } catch (err) {
    console.error("[Suppliers] Error scraping Alibaba:", err.message);
    return [];
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}
