// server.js — Railway entry point: HTTP server, HTML dashboard, crons, manual triggers
import "dotenv/config";
import express from "express";
import cron from "node-cron";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DRY_RUN = process.env.DRY_RUN === "true";

// ─── Module Status Tracking ──────────────────────────────────────────────────
const moduleStatus = {
  product_researcher: "pending",
  keyword_researcher: "pending",
  supplier_finder: "pending",
  listing_writer: "pending",
  competitor_tracker: "pending",
  review_monitor: "pending",
  email_alerts: "pending",
  products_db: "pending",
  fee_calculator: "pending",
  youtube_scraper: "pending",
  movers_shakers: "pending",
  review_sentiment: "pending",
  inventory_reorder: "pending",
  hijacker_monitor: "pending",
  return_monitor: "pending",
  pnl_tracker: "pending",
  rank_tracker: "pending",
  suppression_detector: "pending",
  price_elasticity: "pending",
  q4_forecaster: "pending",
  negative_keyword_miner: "pending",
  account_health_monitor: "pending",
  launch_coupon: "pending",
  amazon_sp_api: "pending",
  ppc_manager: "pending",
  customer_service: "pending",
  supplier_outreach: "pending",
  review_requester: "pending",
  repricing: "pending",
  validation_engine: "pending",
};

// ─── Run History ─────────────────────────────────────────────────────────────
const runHistory = {
  research: [],
  competitors: [],
  reviews: [],
  digest: [],
  validation: [],
  customerService: [],
  reviewRequests: [],
  repricing: [],
  inventoryReorder: [],
  hijackerCheck: [],
  returnCheck: [],
  pnlReport: [],
  rankTracking: [],
  suppressionCheck: [],
  priceElasticity: [],
  seasonalForecast: [],
  negativeKeywords: [],
  accountHealth: [],
  launchCoupon: [],
};

const MAX_HISTORY = 20;

function addRunHistory(type, entry) {
  runHistory[type].unshift(entry);
  if (runHistory[type].length > MAX_HISTORY) {
    runHistory[type] = runHistory[type].slice(0, MAX_HISTORY);
  }
}

// ─── Active Runs ─────────────────────────────────────────────────────────────
const activeRuns = {
  research: false,
  competitors: false,
  reviews: false,
  digest: false,
  validation: false,
  customerService: false,
  reviewRequests: false,
  repricing: false,
  inventoryReorder: false,
  hijackerCheck: false,
  returnCheck: false,
  pnlReport: false,
  rankTracking: false,
  suppressionCheck: false,
  priceElasticity: false,
  seasonalForecast: false,
  negativeKeywords: false,
  accountHealth: false,
  launchCoupon: false,
};

// ─── Module Lazy Loaders ─────────────────────────────────────────────────────
let modules = {};

async function loadModule(name, importFn) {
  if (modules[name]) return modules[name];
  try {
    moduleStatus[name] = "loading";
    modules[name] = await importFn();
    moduleStatus[name] = "loaded";
    console.log(`[Server] Module loaded: ${name}`);
    return modules[name];
  } catch (err) {
    moduleStatus[name] = `error: ${err.message}`;
    console.error(`[Server] Failed to load module ${name}:`, err.message);
    throw err;
  }
}

async function getDB() {
  const mod = await loadModule("products_db", () => import("./products_db.js"));
  return mod;
}

async function getResearcher() {
  return loadModule("product_researcher", () => import("./product_researcher.js"));
}

async function getKeywordResearcher() {
  return loadModule("keyword_researcher", () => import("./keyword_researcher.js"));
}

async function getSupplierFinder() {
  return loadModule("supplier_finder", () => import("./supplier_finder.js"));
}

async function getListingWriter() {
  return loadModule("listing_writer", () => import("./listing_writer.js"));
}

async function getCompetitorTracker() {
  return loadModule("competitor_tracker", () => import("./competitor_tracker.js"));
}

async function getReviewMonitor() {
  return loadModule("review_monitor", () => import("./review_monitor.js"));
}

async function getEmailAlerts() {
  return loadModule("email_alerts", () => import("./email_alerts.js"));
}

async function getYouTubeScraper() {
  return loadModule("youtube_scraper", () => import("./youtube_scraper.js"));
}

async function getValidationEngine() {
  return loadModule("validation_engine", () => import("./validation_engine.js"));
}

async function getPPCManager() {
  return loadModule("ppc_manager", () => import("./ppc_manager.js"));
}

async function getCustomerService() {
  return loadModule("customer_service", () => import("./customer_service.js"));
}

async function getSupplierOutreach() {
  return loadModule("supplier_outreach", () => import("./supplier_outreach.js"));
}

async function getReviewRequester() {
  return loadModule("review_requester", () => import("./review_requester.js"));
}

async function getRepricing() {
  return loadModule("repricing", () => import("./repricing.js"));
}

async function getMovers() {
  return loadModule("movers_shakers", () => import("./movers_shakers.js"));
}

async function getReviewSentiment() {
  return loadModule("review_sentiment", () => import("./review_sentiment.js"));
}

async function getInventoryReorder() {
  return loadModule("inventory_reorder", () => import("./inventory_reorder.js"));
}

async function getHijackerMonitor() {
  return loadModule("hijacker_monitor", () => import("./hijacker_monitor.js"));
}

async function getReturnMonitor() {
  return loadModule("return_monitor", () => import("./return_monitor.js"));
}

async function getPnLTracker() {
  return loadModule("pnl_tracker", () => import("./pnl_tracker.js"));
}

async function getRankTracker() {
  return loadModule("rank_tracker", () => import("./rank_tracker.js"));
}

async function getSuppressionDetector() {
  return loadModule("suppression_detector", () => import("./suppression_detector.js"));
}

async function getPriceElasticity() {
  return loadModule("price_elasticity", () => import("./price_elasticity.js"));
}

async function getQ4Forecaster() {
  return loadModule("q4_forecaster", () => import("./q4_forecaster.js"));
}

async function getNegativeKeywordMiner() {
  return loadModule("negative_keyword_miner", () => import("./negative_keyword_miner.js"));
}

async function getAccountHealthMonitor() {
  return loadModule("account_health_monitor", () => import("./account_health_monitor.js"));
}

async function getLaunchCoupon() {
  return loadModule("launch_coupon", () => import("./launch_coupon.js"));
}

// ─── runAndTrack Wrapper ─────────────────────────────────────────────────────
async function runAndTrack(type, fn) {
  if (activeRuns[type]) {
    console.log(`[Server] ${type} already running — skipping`);
    return { skipped: true, reason: "already running" };
  }

  activeRuns[type] = true;
  const startTime = Date.now();
  const startISO = new Date().toISOString();

  console.log(`[Server] Starting run: ${type} at ${startISO} (DRY_RUN=${DRY_RUN})`);

  try {
    const result = await fn();
    const duration = Date.now() - startTime;

    addRunHistory(type, {
      startedAt: startISO,
      completedAt: new Date().toISOString(),
      duration: `${(duration / 1000).toFixed(1)}s`,
      status: "success",
      result: summarizeResult(type, result),
    });

    console.log(`[Server] Completed run: ${type} in ${(duration / 1000).toFixed(1)}s`);
    return result;
  } catch (err) {
    const duration = Date.now() - startTime;
    console.error(`[Server] Run failed: ${type}:`, err.message);

    addRunHistory(type, {
      startedAt: startISO,
      completedAt: new Date().toISOString(),
      duration: `${(duration / 1000).toFixed(1)}s`,
      status: "error",
      error: err.message,
    });

    throw err;
  } finally {
    activeRuns[type] = false;
  }
}

function summarizeResult(type, result) {
  if (!result) return "no result";
  if (type === "research") {
    return `${Array.isArray(result) ? result.length : 0} new opportunities`;
  }
  if (type === "competitors" || type === "reviews") {
    return `${Array.isArray(result) ? result.length : 0} alerts`;
  }
  return "done";
}

// ─── Main Research Flow ───────────────────────────────────────────────────────
async function runResearch() {
  const dbMod = await getDB();
  const db = dbMod.loadDB();

  const researcher = await getResearcher();
  const kwResearcher = await getKeywordResearcher();
  const supplierFinder = await getSupplierFinder();
  const listingWriter = await getListingWriter();
  const emailAlerts = await getEmailAlerts();

  // Get YouTube-sourced product niches
  let ytLeads = [];
  try {
    const ytScraper = await getYouTubeScraper();
    const niches = await ytScraper.extractProductNiches();
    if (niches.length > 0 && !DRY_RUN) {
      ytLeads = await researcher.searchByKeywords(niches, 10);
      console.log(`[Research] YouTube leads: ${ytLeads.length}`);
    } else if (niches.length > 0) {
      console.log(`[Research] DRY RUN — skipping YouTube Amazon search (${niches.length} niches extracted)`);
    }
  } catch (err) {
    console.error("[Research] YouTube sourcing failed:", err.message);
  }

  // Get Movers & Shakers leads (fast-rising products = proven demand)
  let moversLeads = [];
  try {
    const movers = await getMovers();
    moversLeads = await movers.findMovers(15);
    console.log(`[Research] Movers & Shakers leads: ${moversLeads.length}`);
  } catch (err) {
    console.error("[Research] Movers & Shakers failed:", err.message);
  }

  console.log("[Research] Finding product leads...");
  const leads = await researcher.findLeads(20);

  // Merge all lead sources
  const allLeads = [...leads, ...ytLeads, ...moversLeads];

  db.totalScanned = (db.totalScanned || 0) + allLeads.length + 50; // 50 = rough estimate of discarded candidates

  const newProducts = [];

  for (const lead of allLeads) {
    try {
      // Skip already researched products
      if (dbMod.hasBeenResearched(db, lead.asin)) {
        console.log(`[Research] Already researched ${lead.asin} — skipping`);
        continue;
      }

      console.log(`[Research] Processing lead: ${lead.asin} — "${lead.title.slice(0, 50)}"`);

      // Keyword research
      let keywordData = { keywords: [], backendKeywords: "" };
      try {
        keywordData = await kwResearcher.researchKeywords(lead.title, lead.asin);
      } catch (err) {
        console.error(`[Research] Keyword research failed for ${lead.asin}:`, err.message);
      }

      // Supplier search (use first 3 words of title)
      let suppliers = [];
      try {
        const searchKw = lead.title.split(" ").slice(0, 3).join(" ");
        suppliers = await supplierFinder.findSuppliers(searchKw);
      } catch (err) {
        console.error(`[Research] Supplier search failed for ${lead.asin}:`, err.message);
      }

      // Write listing (skip in dry run)
      let listing = null;
      if (!DRY_RUN) {
        try {
          listing = await listingWriter.writeListing(lead, keywordData, suppliers);
        } catch (err) {
          console.error(`[Research] Listing write failed for ${lead.asin}:`, err.message);
        }
      } else {
        console.log(`[Research] DRY RUN — skipping listing write for ${lead.asin}`);
      }

      // ── Pre-PPC Validation (free checks before spending $49) ──
      let preValidation = null;
      try {
        const validationEngine = await getValidationEngine();
        const { default: puppeteerExtra } = await import("puppeteer-extra");
        const { default: StealthPlugin } = await import("puppeteer-extra-plugin-stealth");
        puppeteerExtra.use(StealthPlugin());
        const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
        const validationBrowser = await puppeteerExtra.launch({
          headless: true,
          args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--single-process","--no-zygote","--disable-gpu"],
          ...(execPath ? { executablePath: execPath } : {}),
        });

        try {
          preValidation = await validationEngine.runPreValidation(lead, validationBrowser);
        } finally {
          await validationBrowser.close().catch(() => {});
        }

        if (!preValidation.passed) {
          console.log(`[Research] SKIPPED ${lead.asin} — failed pre-validation: ${preValidation.reason}`);
          dbMod.addOpportunity(db, {
            ...lead,
            status: "passed",
            validationStatus: "pre_failed",
            validationReason: preValidation.reason,
          });
          continue;
        }

        console.log(`[Research] ${lead.asin} passed pre-validation (score: ${preValidation.score}/100) — proceeding`);
      } catch (err) {
        console.error(`[Research] Pre-validation error for ${lead.asin}:`, err.message);
        // Don't skip on error — let it through
      }

      // Generate a SKU for this product
      const sku = `FBA-${lead.asin}-${Date.now()}`;

      // Submit listing to Amazon + start validation campaign
      let validationCampaignId = null;
      let listingSubmittedAt = null;

      if (!DRY_RUN && listing) {
        try {
          const spApi = await loadModule("amazon_sp_api", () => import("./amazon_sp_api.js"));
          const { hasSpApiCredentials } = await import("./amazon_auth.js");

          if (hasSpApiCredentials()) {
            await spApi.createListing(sku, {
              title: listing.title || lead.title,
              description: listing.description || "",
              bulletPoints: listing.bulletPoints || [],
              keywords: keywordData.keywords,
              price: lead.price,
              quantity: 0, // Start at 0 — validation mode
            });
            listingSubmittedAt = new Date().toISOString();
            console.log(`[Research] Listing submitted to Amazon for ${lead.asin}`);

            // Start validation PPC campaign
            const ppc = await getPPCManager();
            const { hasAdsCredentials } = await import("./amazon_auth.js");
            if (hasAdsCredentials()) {
              const campaign = await ppc.createValidationCampaign({
                ...lead,
                sku,
                keywords: keywordData.keywords,
              });
              validationCampaignId = campaign.campaignId;
              console.log(`[Research] Validation campaign started for ${lead.asin}`);
            }
          }
        } catch (err) {
          console.error(`[Research] SP-API/PPC setup failed for ${lead.asin}:`, err.message);
        }
      }

      const productEntry = {
        ...lead,
        sku,
        keywords: keywordData.keywords,
        suppliers,
        listing,
        listingSubmittedAt,
        validationStatus: validationCampaignId ? "validating" : null,
        validationCampaignId,
        validationStartedAt: validationCampaignId ? new Date().toISOString() : null,
        preValidation,
        status: validationCampaignId ? "validating" : "researching",
      };

      dbMod.addOpportunity(db, productEntry);
      newProducts.push(productEntry);

      // Small delay between products
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`[Research] Error processing lead ${lead.asin}:`, err.message);
    }
  }

  db.lastResearchAt = new Date().toISOString();
  dbMod.saveDB(db);
  dbMod.printSummary(db);

  // Send single best product email — only if pre-validation passed AND listing written
  const actionableProducts = newProducts.filter(
    (p) => p.listing && p.opportunityScore >= 60 && p.margin >= 25
  );

  // Run review sentiment analysis on new leads to surface competitor weaknesses
  if (newProducts.length > 0 && !DRY_RUN) {
    try {
      const sentiment = await getReviewSentiment();
      for (const product of newProducts.slice(0, 5)) {
        try {
          const analysis = await sentiment.analyzeCompetitorReviews(product.asin, product.title);
          if (analysis) {
            const dbMod2 = await getDB();
            const db2 = dbMod2.loadDB();
            dbMod2.updateOpportunity(db2, product.asin, { reviewSentiment: analysis });
            dbMod2.saveDB(db2);
          }
        } catch (err) {
          console.error(`[Research] Review sentiment failed for ${product.asin}:`, err.message);
        }
      }
    } catch (err) {
      console.error("[Research] Review sentiment module failed:", err.message);
    }
  }

  if (actionableProducts.length > 0 && !DRY_RUN) {
    try {
      await emailAlerts.sendOpportunityAlert(actionableProducts);
    } catch (err) {
      console.error("[Research] Failed to send opportunity alert:", err.message);
    }
  }

  return newProducts;
}

// ─── Validation Check Flow ────────────────────────────────────────────────────
async function runValidationCheck() {
  const dbMod = await getDB();
  const db = dbMod.loadDB();
  const ppc = await getPPCManager();
  const emailAlerts = await getEmailAlerts();
  const spApi = await loadModule("amazon_sp_api", () => import("./amazon_sp_api.js"));
  const outreach = await getSupplierOutreach();

  const validating = db.opportunities.filter((o) => o.validationStatus === "validating");
  console.log(`[Validation] Checking ${validating.length} products in validation...`);

  const passed = [];
  const failed = [];

  for (const product of validating) {
    try {
      if (!product.validationCampaignId) continue;

      // Check if 7 days have passed
      const startedAt = new Date(product.validationStartedAt);
      const daysSince = (Date.now() - startedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 7) {
        console.log(`[Validation] ${product.asin} — ${daysSince.toFixed(1)} days in (need 7)`);
        continue;
      }

      const metrics = await ppc.getCampaignMetrics(product.validationCampaignId);
      const validationEngine = await getValidationEngine();
      const preValidation = product.preValidation || null;
      const { passed: didPass, reason, confidence } = validationEngine.runPostValidation(preValidation, metrics);
      const seasonalWarning = validationEngine.getSeasonalWarning(product);

      dbMod.updateOpportunity(db, product.asin, {
        validationStatus: didPass ? "passed" : "failed",
        validationCompletedAt: new Date().toISOString(),
        validationMetrics: metrics,
        status: didPass ? "sourcing" : "passed", // "passed" = skipped in our status model
      });

      if (didPass) {
        passed.push({ ...product, validationMetrics: metrics, validationReason: reason, confidence, seasonalWarning });

        if (!DRY_RUN) {
          // Auto-contact suppliers
          try {
            await outreach.contactTopSuppliers(product, DRY_RUN);
          } catch (err) {
            console.error(`[Validation] Supplier outreach failed for ${product.asin}:`, err.message);
          }

          // Launch full PPC campaign
          try {
            const ppcMod = await getPPCManager();
            const launchCampaignId = await ppcMod.createLaunchCampaign({
              ...product,
              keywords: product.keywords || [],
            });
            dbMod.updateOpportunity(db, product.asin, { launchCampaignId, status: "launched" });
            console.log(`[Validation] Launch campaign created for ${product.asin}`);
          } catch (err) {
            console.error(`[Validation] Launch campaign failed for ${product.asin}:`, err.message);
          }

          // Activate launch price (15% off for 14 days to drive ranking velocity)
          try {
            const launcher = await getLaunchCoupon();
            await launcher.activateLaunchPrice(product, DRY_RUN);
          } catch (err) {
            console.error(`[Validation] Launch price failed for ${product.asin}:`, err.message);
          }
        }
      } else {
        failed.push({ ...product, validationReason: reason });
      }

      console.log(`[Validation] ${product.asin} — ${didPass ? "PASSED" : "FAILED"}: ${reason}`);
    } catch (err) {
      console.error(`[Validation] Error checking ${product.asin}:`, err.message);
    }
  }

  dbMod.saveDB(db);

  // Send email summary
  if ((passed.length > 0 || failed.length > 0) && !DRY_RUN) {
    try {
      await emailAlerts.sendValidationSummary(passed, failed);
    } catch (err) {
      console.error("[Validation] Failed to send validation email:", err.message);
    }
  }

  return { passed: passed.length, failed: failed.length };
}

// ─── Customer Service Flow ────────────────────────────────────────────────────
async function runCustomerService() {
  const cs = await getCustomerService();
  const dbMod = await getDB();
  const db = dbMod.loadDB();

  const replied = await cs.handleBuyerMessages(DRY_RUN);

  db.lastCustomerServiceAt = new Date().toISOString();
  dbMod.saveDB(db);

  return replied;
}

// ─── Review Request Flow ──────────────────────────────────────────────────────
async function runReviewRequests() {
  const requester = await getReviewRequester();
  const dbMod = await getDB();
  const db = dbMod.loadDB();

  const count = await requester.requestPendingReviews(DRY_RUN);

  db.lastReviewRequestAt = new Date().toISOString();
  dbMod.saveDB(db);

  return { requested: count };
}

// ─── Repricing Flow ───────────────────────────────────────────────────────────
async function runRepricing() {
  const repricer = await getRepricing();
  const dbMod = await getDB();
  const db = dbMod.loadDB();

  const actions = await repricer.repriceProducts(DRY_RUN);

  db.lastRepricingAt = new Date().toISOString();
  dbMod.saveDB(db);

  return actions;
}

// ─── Negative Keyword Miner Flow ─────────────────────────────────────────────
async function runNegativeKeywords() {
  const miner = await getNegativeKeywordMiner();
  return miner.mineNegativeKeywords(DRY_RUN);
}

// ─── Account Health Flow ──────────────────────────────────────────────────────
async function runAccountHealth() {
  const monitor = await getAccountHealthMonitor();
  return monitor.checkAccountHealth(DRY_RUN);
}

// ─── Launch Coupon Flow ───────────────────────────────────────────────────────
async function runLaunchCoupon() {
  const launcher = await getLaunchCoupon();
  return launcher.manageLaunchPrices(DRY_RUN);
}

// ─── Suppression Detector Flow ───────────────────────────────────────────────
async function runSuppressionCheck() {
  const detector = await getSuppressionDetector();
  return detector.checkListingSuppression(DRY_RUN);
}

// ─── Price Elasticity Flow ────────────────────────────────────────────────────
async function runPriceElasticity() {
  const engine = await getPriceElasticity();
  return engine.runPriceElasticityTests(DRY_RUN);
}

// ─── Seasonal Forecast Flow ───────────────────────────────────────────────────
async function runSeasonalForecast() {
  const forecaster = await getQ4Forecaster();
  return forecaster.runSeasonalForecast(DRY_RUN);
}

// ─── Hijacker Monitor Flow ────────────────────────────────────────────────────
async function runHijackerCheck() {
  const monitor = await getHijackerMonitor();
  return monitor.checkHijackers(DRY_RUN);
}

// ─── Return Monitor Flow ──────────────────────────────────────────────────────
async function runReturnCheck() {
  const monitor = await getReturnMonitor();
  return monitor.checkReturnRates(DRY_RUN);
}

// ─── P&L Report Flow ──────────────────────────────────────────────────────────
async function runPnLReport() {
  const tracker = await getPnLTracker();
  return tracker.runPnLReport(DRY_RUN);
}

// ─── Rank Tracking Flow ───────────────────────────────────────────────────────
async function runRankTracking() {
  const tracker = await getRankTracker();
  return tracker.trackKeywordRanks(DRY_RUN);
}

// ─── Inventory Reorder Flow ───────────────────────────────────────────────────
async function runInventoryReorder() {
  const reorder = await getInventoryReorder();
  const dbMod = await getDB();
  const db = dbMod.loadDB();

  const actions = await reorder.checkReorderPoints(DRY_RUN);

  db.lastInventoryReorderAt = new Date().toISOString();
  dbMod.saveDB(db);

  return actions;
}

// ─── Competitor Tracking Flow ─────────────────────────────────────────────────
async function runCompetitors() {
  const dbMod = await getDB();
  const db = dbMod.loadDB();
  const tracker = await getCompetitorTracker();
  const emailAlerts = await getEmailAlerts();

  const alerts = await tracker.trackCompetitors(db, DRY_RUN);

  if (alerts.length > 0 && !DRY_RUN) {
    try {
      await emailAlerts.sendCompetitorAlert(alerts);
    } catch (err) {
      console.error("[Competitors] Failed to send alert email:", err.message);
    }
  }

  return alerts;
}

// ─── Review Monitoring Flow ───────────────────────────────────────────────────
async function runReviews() {
  const dbMod = await getDB();
  const db = dbMod.loadDB();
  const monitor = await getReviewMonitor();
  const emailAlerts = await getEmailAlerts();

  const alerts = await monitor.monitorReviews(db, DRY_RUN);

  if (alerts.length > 0 && !DRY_RUN) {
    try {
      await emailAlerts.sendReviewAlert(alerts);
    } catch (err) {
      console.error("[Reviews] Failed to send review alert email:", err.message);
    }
  }

  return alerts;
}

// ─── Weekly Digest Flow ───────────────────────────────────────────────────────
async function runWeeklyDigest() {
  const dbMod = await getDB();
  const db = dbMod.loadDB();
  const emailAlerts = await getEmailAlerts();

  if (!DRY_RUN) {
    await emailAlerts.sendWeeklyDigest(db);
  } else {
    console.log("[Digest] DRY RUN — skipping weekly digest email");
  }

  return { sent: !DRY_RUN };
}

// ─── Cron Jobs ────────────────────────────────────────────────────────────────
// 6am EDT = 10:00 UTC
cron.schedule("0 10 * * *", () => {
  console.log("[Cron] 6am EDT — starting product research");
  runAndTrack("research", runResearch).catch((err) =>
    console.error("[Cron] Research cron failed:", err.message)
  );
});

// 9am EDT = 13:00 UTC
cron.schedule("0 13 * * *", () => {
  console.log("[Cron] 9am EDT — starting competitor tracking");
  runAndTrack("competitors", runCompetitors).catch((err) =>
    console.error("[Cron] Competitor cron failed:", err.message)
  );
});

// 6pm EDT = 22:00 UTC
cron.schedule("0 22 * * *", () => {
  console.log("[Cron] 6pm EDT — starting review monitoring");
  runAndTrack("reviews", runReviews).catch((err) =>
    console.error("[Cron] Review cron failed:", err.message)
  );
});

// 8am EDT Sunday = 12:00 UTC Sunday
cron.schedule("0 12 * * 0", () => {
  console.log("[Cron] 8am EDT Sunday — sending weekly digest");
  runAndTrack("digest", runWeeklyDigest).catch((err) =>
    console.error("[Cron] Digest cron failed:", err.message)
  );
});

// 10am EDT = 14:00 UTC — validation check
cron.schedule("0 14 * * *", () => {
  console.log("[Cron] 10am EDT — running validation check");
  runAndTrack("validation", runValidationCheck).catch((err) =>
    console.error("[Cron] Validation cron failed:", err.message)
  );
});

// Every 4 hours — customer service (answer buyer messages)
cron.schedule("0 */4 * * *", () => {
  console.log("[Cron] Every 4h — running customer service");
  runAndTrack("customerService", runCustomerService).catch((err) =>
    console.error("[Cron] Customer service cron failed:", err.message)
  );
});

// 7am EDT = 11:00 UTC — review requests
cron.schedule("0 11 * * *", () => {
  console.log("[Cron] 7am EDT — requesting reviews");
  runAndTrack("reviewRequests", runReviewRequests).catch((err) =>
    console.error("[Cron] Review requests cron failed:", err.message)
  );
});

// 11am EDT = 15:00 UTC — repricing
cron.schedule("0 15 * * *", () => {
  console.log("[Cron] 11am EDT — running repricing");
  runAndTrack("repricing", runRepricing).catch((err) =>
    console.error("[Cron] Repricing cron failed:", err.message)
  );
});

// 8am EDT = 12:00 UTC — inventory reorder check
cron.schedule("0 12 * * *", () => {
  console.log("[Cron] 8am EDT — checking inventory reorder points");
  runAndTrack("inventoryReorder", runInventoryReorder).catch((err) =>
    console.error("[Cron] Inventory reorder cron failed:", err.message)
  );
});

// Every 6 hours — hijacker / buy box check
cron.schedule("0 */6 * * *", () => {
  console.log("[Cron] Every 6h — hijacker & buy box check");
  runAndTrack("hijackerCheck", runHijackerCheck).catch((err) =>
    console.error("[Cron] Hijacker check cron failed:", err.message)
  );
});

// Daily 5pm EDT = 21:00 UTC — return rate check
cron.schedule("0 21 * * *", () => {
  console.log("[Cron] 5pm EDT — checking return rates");
  runAndTrack("returnCheck", runReturnCheck).catch((err) =>
    console.error("[Cron] Return check cron failed:", err.message)
  );
});

// Sundays 9am EDT = 13:00 UTC — weekly P&L report
cron.schedule("0 13 * * 0", () => {
  console.log("[Cron] Sunday 9am EDT — sending P&L report");
  runAndTrack("pnlReport", runPnLReport).catch((err) =>
    console.error("[Cron] P&L report cron failed:", err.message)
  );
});

// Daily 2pm EDT = 18:00 UTC — keyword rank tracking
cron.schedule("0 18 * * *", () => {
  console.log("[Cron] 2pm EDT — keyword rank tracking");
  runAndTrack("rankTracking", runRankTracking).catch((err) =>
    console.error("[Cron] Rank tracking cron failed:", err.message)
  );
});

// Every 2 hours — listing suppression check (urgent — you stop selling when suppressed)
cron.schedule("0 */2 * * *", () => {
  console.log("[Cron] Every 2h — listing suppression check");
  runAndTrack("suppressionCheck", runSuppressionCheck).catch((err) =>
    console.error("[Cron] Suppression check cron failed:", err.message)
  );
});

// Weekly Monday 8am EDT = 12:00 UTC — price elasticity tests
cron.schedule("0 12 * * 1", () => {
  console.log("[Cron] Monday 8am EDT — price elasticity engine");
  runAndTrack("priceElasticity", runPriceElasticity).catch((err) =>
    console.error("[Cron] Price elasticity cron failed:", err.message)
  );
});

// 1st of every month 9am EDT = 13:00 UTC — seasonal inventory forecast
cron.schedule("0 13 1 * *", () => {
  console.log("[Cron] 1st of month — seasonal inventory forecast");
  runAndTrack("seasonalForecast", runSeasonalForecast).catch((err) =>
    console.error("[Cron] Seasonal forecast cron failed:", err.message)
  );
});

// Weekly Wednesday 8am EDT = 12:00 UTC — negative keyword mining
cron.schedule("0 12 * * 3", () => {
  console.log("[Cron] Wednesday 8am EDT — mining negative keywords");
  runAndTrack("negativeKeywords", runNegativeKeywords).catch((err) =>
    console.error("[Cron] Negative keyword cron failed:", err.message)
  );
});

// Daily 8am EDT = 12:00 UTC — account health check
cron.schedule("30 12 * * *", () => {
  console.log("[Cron] 8:30am EDT — account health check");
  runAndTrack("accountHealth", runAccountHealth).catch((err) =>
    console.error("[Cron] Account health cron failed:", err.message)
  );
});

// Every 6 hours — manage launch prices (activate new, restore expired)
cron.schedule("0 */6 * * *", () => {
  console.log("[Cron] Every 6h — managing launch prices");
  runAndTrack("launchCoupon", runLaunchCoupon).catch((err) =>
    console.error("[Cron] Launch coupon cron failed:", err.message)
  );
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET / — HTML dashboard
app.get("/", async (req, res) => {
  let db;
  let dbSummary = { opportunities: [], totalScanned: 0, lastResearchAt: null, lastCompetitorCheckAt: null, lastReviewCheckAt: null };

  try {
    const dbMod = await getDB();
    db = dbMod.loadDB();
    dbSummary = db;
  } catch {}

  const opportunities = dbSummary.opportunities || [];
  const byStatus = opportunities.reduce((acc, o) => {
    acc[o.status] = (acc[o.status] || 0) + 1;
    return acc;
  }, {});

  const topOpps = [...opportunities]
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
    .slice(0, 10);

  const runningBadge = (type) =>
    activeRuns[type]
      ? `<span style="background:#f39c12;color:white;padding:2px 8px;border-radius:12px;font-size:11px;margin-left:6px;">RUNNING</span>`
      : "";

  const historyRows = (type) =>
    (runHistory[type] || [])
      .slice(0, 5)
      .map(
        (r) => `
    <tr>
      <td style="padding:4px 8px;font-size:12px;color:#555;">${new Date(r.startedAt).toLocaleString()}</td>
      <td style="padding:4px 8px;font-size:12px;">
        <span style="color:${r.status === "success" ? "#27ae60" : "#e74c3c"};">${r.status}</span>
      </td>
      <td style="padding:4px 8px;font-size:12px;color:#555;">${r.duration}</td>
      <td style="padding:4px 8px;font-size:12px;color:#555;">${r.result || r.error || ""}</td>
    </tr>
  `
      )
      .join("") || `<tr><td colspan="4" style="padding:8px;font-size:12px;color:#888;text-align:center;">No runs yet</td></tr>`;

  const oppRows = topOpps
    .map(
      (p) => `
    <tr>
      <td style="padding:8px;font-size:13px;">
        <a href="https://www.amazon.com/dp/${p.asin}" target="_blank" style="color:#0066c0;text-decoration:none;">${escHtml(p.title?.slice(0, 55) || p.asin)}</a>
      </td>
      <td style="padding:8px;font-size:13px;text-align:center;">${p.opportunityScore}</td>
      <td style="padding:8px;font-size:13px;text-align:center;">$${(p.price || 0).toFixed(2)}</td>
      <td style="padding:8px;font-size:13px;text-align:center;">${p.margin}%</td>
      <td style="padding:8px;font-size:13px;text-align:center;">#${(p.bsr || 0).toLocaleString()}</td>
      <td style="padding:8px;font-size:13px;text-align:center;">${p.reviews || 0}</td>
      <td style="padding:8px;font-size:13px;text-align:center;">
        <span style="background:${statusColor(p.status)};color:white;padding:2px 8px;border-radius:10px;font-size:11px;">${p.status}</span>
      </td>
    </tr>
  `
    )
    .join("") || `<tr><td colspan="7" style="padding:16px;text-align:center;color:#888;">No opportunities yet — trigger a research run to get started</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Amazon FBA Bot Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; color: #1a1a2e; }
    .header { background: #1a1a2e; color: white; padding: 20px 32px; display: flex; align-items: center; justify-content: space-between; }
    .header h1 { font-size: 20px; font-weight: 700; }
    .mode-badge { background: ${DRY_RUN ? "#e67e22" : "#27ae60"}; color: white; padding: 4px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px 16px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: white; border-radius: 10px; padding: 20px; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .stat-card .value { font-size: 32px; font-weight: 700; color: #2980b9; }
    .stat-card .label { font-size: 12px; color: #666; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .card { background: white; border-radius: 10px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .card h2 { font-size: 16px; margin-bottom: 16px; color: #1a1a2e; }
    .btn { display: inline-block; padding: 8px 18px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; text-decoration: none; }
    .btn-primary { background: #2980b9; color: white; }
    .btn-primary:hover { background: #2471a3; }
    .btn-secondary { background: #27ae60; color: white; }
    .btn-secondary:hover { background: #229954; }
    .btn-warning { background: #f39c12; color: white; }
    .btn-warning:hover { background: #d68910; }
    .btn-info { background: #8e44ad; color: white; }
    .btn-info:hover { background: #7d3c98; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 8px; font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid #eee; }
    td { border-bottom: 1px solid #f0f0f0; }
    .modules-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; }
    .module-item { background: #f8f9fa; border-radius: 6px; padding: 8px 12px; font-size: 12px; display: flex; justify-content: space-between; align-items: center; }
    .mod-status { font-size: 11px; padding: 2px 6px; border-radius: 10px; }
    .mod-pending { background: #eee; color: #666; }
    .mod-loaded { background: #d4edda; color: #155724; }
    .mod-loading { background: #fff3cd; color: #856404; }
    .mod-error { background: #f8d7da; color: #721c24; }
    .history-section { margin-top: 12px; }
    .cron-info { font-size: 12px; color: #888; margin-top: 8px; }
    .status-breakdown { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .status-chip { padding: 4px 12px; border-radius: 12px; font-size: 12px; }
    .spinner { display: none; }
    .spinner.active { display: inline; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Amazon FBA Bot</h1>
    <div style="display:flex;align-items:center;gap:12px;">
      <span class="mode-badge">${DRY_RUN ? "DRY RUN" : "LIVE"}</span>
      <span style="font-size:13px;opacity:0.7;">${new Date().toLocaleString()}</span>
    </div>
  </div>

  <div class="container">

    <!-- Stats -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="value">${opportunities.length}</div>
        <div class="label">Opportunities Found</div>
      </div>
      <div class="stat-card">
        <div class="value">${opportunities.filter((o) => o.status !== "passed").length}</div>
        <div class="label">Products Tracked</div>
      </div>
      <div class="stat-card">
        <div class="value">${(dbSummary.totalScanned || 0).toLocaleString()}</div>
        <div class="label">Total Scanned</div>
      </div>
      <div class="stat-card">
        <div class="value">${opportunities.filter((o) => o.listing).length}</div>
        <div class="label">Listings Written</div>
      </div>
      <div class="stat-card">
        <div class="value">${opportunities.length > 0 ? Math.round(opportunities.reduce((s, o) => s + (o.margin || 0), 0) / opportunities.length) : 0}%</div>
        <div class="label">Avg Margin</div>
      </div>
    </div>

    <!-- Actions -->
    <div class="card">
      <h2>Manual Triggers</h2>
      <div class="actions">
        <button class="btn btn-primary" onclick="trigger('/run-research', 'research-status')">
          Run Product Research ${runningBadge("research")}
        </button>
        <button class="btn btn-secondary" onclick="trigger('/run-competitors', 'competitors-status')">
          Run Competitor Check ${runningBadge("competitors")}
        </button>
        <button class="btn btn-warning" onclick="trigger('/run-reviews', 'reviews-status')">
          Run Review Monitor ${runningBadge("reviews")}
        </button>
        <button class="btn btn-info" onclick="window.location.href='/opportunities'">
          View JSON Opportunities
        </button>
      </div>
      <div id="trigger-status" style="margin-top:12px;font-size:13px;color:#555;"></div>
    </div>

    <!-- Last Run Times -->
    <div class="card">
      <h2>Schedule Status</h2>
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>Schedule (EDT)</th>
            <th>Last Run</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:10px 8px;font-size:14px;">Product Research</td>
            <td style="padding:10px 8px;font-size:13px;color:#555;">Daily at 6:00 AM</td>
            <td style="padding:10px 8px;font-size:13px;color:#555;">${dbSummary.lastResearchAt ? new Date(dbSummary.lastResearchAt).toLocaleString() : "Never"}</td>
            <td style="padding:10px 8px;">${activeRuns.research ? '<span style="color:#f39c12;font-size:13px;font-weight:600;">RUNNING</span>' : '<span style="color:#27ae60;font-size:13px;">Idle</span>'}</td>
          </tr>
          <tr>
            <td style="padding:10px 8px;font-size:14px;">Competitor Tracking</td>
            <td style="padding:10px 8px;font-size:13px;color:#555;">Daily at 9:00 AM</td>
            <td style="padding:10px 8px;font-size:13px;color:#555;">${dbSummary.lastCompetitorCheckAt ? new Date(dbSummary.lastCompetitorCheckAt).toLocaleString() : "Never"}</td>
            <td style="padding:10px 8px;">${activeRuns.competitors ? '<span style="color:#f39c12;font-size:13px;font-weight:600;">RUNNING</span>' : '<span style="color:#27ae60;font-size:13px;">Idle</span>'}</td>
          </tr>
          <tr>
            <td style="padding:10px 8px;font-size:14px;">Review Monitoring</td>
            <td style="padding:10px 8px;font-size:13px;color:#555;">Daily at 6:00 PM</td>
            <td style="padding:10px 8px;font-size:13px;color:#555;">${dbSummary.lastReviewCheckAt ? new Date(dbSummary.lastReviewCheckAt).toLocaleString() : "Never"}</td>
            <td style="padding:10px 8px;">${activeRuns.reviews ? '<span style="color:#f39c12;font-size:13px;font-weight:600;">RUNNING</span>' : '<span style="color:#27ae60;font-size:13px;">Idle</span>'}</td>
          </tr>
          <tr>
            <td style="padding:10px 8px;font-size:14px;">Weekly Digest</td>
            <td style="padding:10px 8px;font-size:13px;color:#555;">Sundays at 8:00 AM</td>
            <td style="padding:10px 8px;font-size:13px;color:#555;">${runHistory.digest[0]?.startedAt ? new Date(runHistory.digest[0].startedAt).toLocaleString() : "Never"}</td>
            <td style="padding:10px 8px;">${activeRuns.digest ? '<span style="color:#f39c12;font-size:13px;font-weight:600;">RUNNING</span>' : '<span style="color:#27ae60;font-size:13px;">Idle</span>'}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Run History -->
    <div class="card">
      <h2>Recent Run History</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;">
        ${["research", "competitors", "reviews", "digest"]
          .map(
            (type) => `
          <div>
            <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#666;margin-bottom:8px;">${type}</h3>
            <table>
              <thead><tr>
                <th>Time</th><th>Status</th><th>Duration</th><th>Result</th>
              </tr></thead>
              <tbody>${historyRows(type)}</tbody>
            </table>
          </div>
        `
          )
          .join("")}
      </div>
    </div>

    <!-- Status Breakdown -->
    ${
      opportunities.length > 0
        ? `
    <div class="card">
      <h2>Opportunities by Status</h2>
      <div class="status-breakdown">
        ${Object.entries(byStatus)
          .map(
            ([status, count]) =>
              `<span class="status-chip" style="background:${statusColor(status)}20;color:${statusColor(status)};border:1px solid ${statusColor(status)}40;">${status}: <strong>${count}</strong></span>`
          )
          .join("")}
      </div>
    </div>
    `
        : ""
    }

    <!-- Top Opportunities -->
    <div class="card">
      <h2>Top Opportunities (by Score)</h2>
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th style="text-align:center;">Score</th>
              <th style="text-align:center;">Price</th>
              <th style="text-align:center;">Margin</th>
              <th style="text-align:center;">BSR</th>
              <th style="text-align:center;">Reviews</th>
              <th style="text-align:center;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${oppRows}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Module Status -->
    <div class="card">
      <h2>Module Status</h2>
      <div class="modules-grid">
        ${Object.entries(moduleStatus)
          .map(([name, status]) => {
            const cls = status === "loaded"
              ? "mod-loaded"
              : status === "loading"
              ? "mod-loading"
              : status.startsWith("error")
              ? "mod-error"
              : "mod-pending";
            return `<div class="module-item">
              <span style="font-weight:500;">${name}</span>
              <span class="mod-status ${cls}">${status}</span>
            </div>`;
          })
          .join("")}
      </div>
    </div>

  </div>

  <script>
    async function trigger(endpoint, statusId) {
      const statusEl = document.getElementById('trigger-status');
      statusEl.textContent = 'Starting ' + endpoint + '...';
      try {
        const res = await fetch(endpoint, { method: 'POST' });
        const data = await res.json();
        statusEl.textContent = 'Started successfully. Refresh page for updates.';
        statusEl.style.color = '#27ae60';
        setTimeout(() => location.reload(), 2000);
      } catch(err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.style.color = '#e74c3c';
      }
    }
    // Auto-refresh every 30s if a run is active
    ${Object.values(activeRuns).some(Boolean) ? "setTimeout(() => location.reload(), 30000);" : ""}
  </script>
</body>
</html>`;

  res.send(html);
});

// POST /run-research
app.post("/run-research", (req, res) => {
  res.json({ started: true, message: "Product research started" });
  runAndTrack("research", runResearch).catch((err) =>
    console.error("[API] Research failed:", err.message)
  );
});

// POST /run-competitors
app.post("/run-competitors", (req, res) => {
  res.json({ started: true, message: "Competitor tracking started" });
  runAndTrack("competitors", runCompetitors).catch((err) =>
    console.error("[API] Competitor check failed:", err.message)
  );
});

// POST /run-reviews
app.post("/run-reviews", (req, res) => {
  res.json({ started: true, message: "Review monitoring started" });
  runAndTrack("reviews", runReviews).catch((err) =>
    console.error("[API] Review check failed:", err.message)
  );
});

// GET /opportunities
app.get("/opportunities", async (req, res) => {
  try {
    const dbMod = await getDB();
    const db = dbMod.loadDB();
    res.json({
      total: db.opportunities.length,
      totalScanned: db.totalScanned,
      lastResearchAt: db.lastResearchAt,
      opportunities: db.opportunities,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /opportunities/:asin
app.get("/opportunities/:asin", async (req, res) => {
  try {
    const dbMod = await getDB();
    const db = dbMod.loadDB();
    const product = db.opportunities.find((o) => o.asin === req.params.asin);
    if (!product) {
      return res.status(404).json({ error: "ASIN not found" });
    }
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helper Functions ─────────────────────────────────────────────────────────

function statusColor(status) {
  const colors = {
    researching: "#2980b9",
    sourcing: "#f39c12",
    launched: "#27ae60",
    passed: "#95a5a6",
    monitoring: "#8e44ad",
  };
  return colors[status] || "#555";
}

function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] Amazon FBA Bot started on port ${PORT}`);
  console.log(`[Server] Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`[Server] Dashboard: http://localhost:${PORT}`);
  console.log("[Server] Crons scheduled:");
  console.log("  - Product Research: daily 6am EDT (10:00 UTC)");
  console.log("  - Competitor Tracking: daily 9am EDT (13:00 UTC)");
  console.log("  - Review Monitoring: daily 6pm EDT (22:00 UTC)");
  console.log("  - Weekly Digest: Sundays 8am EDT (12:00 UTC)");

  // Lazy-load modules in the background after startup
  setTimeout(() => {
    console.log("[Server] Pre-loading modules...");
    Promise.allSettled([
      getDB(),
      getResearcher(),
      getKeywordResearcher(),
      getSupplierFinder(),
      getListingWriter(),
      getCompetitorTracker(),
      getReviewMonitor(),
      getEmailAlerts(),
      getYouTubeScraper(),
      getMovers(),
    ]).then((results) => {
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        console.warn(`[Server] ${failed.length} module(s) failed to pre-load`);
      } else {
        console.log("[Server] All modules loaded successfully");
      }
    });
  }, 3000);
});
