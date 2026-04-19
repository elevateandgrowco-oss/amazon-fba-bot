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
};

// ─── Run History ─────────────────────────────────────────────────────────────
const runHistory = {
  research: [],
  competitors: [],
  reviews: [],
  digest: [],
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

  console.log("[Research] Finding product leads...");
  const leads = await researcher.findLeads(20);

  db.totalScanned = (db.totalScanned || 0) + leads.length + 50; // 50 = rough estimate of discarded candidates

  const newProducts = [];

  for (const lead of leads) {
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

      const productEntry = {
        ...lead,
        keywords: keywordData.keywords,
        suppliers,
        listing,
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

  // Send opportunity alert if new products found
  if (newProducts.length > 0 && !DRY_RUN) {
    try {
      await emailAlerts.sendOpportunityAlert(newProducts);
    } catch (err) {
      console.error("[Research] Failed to send opportunity alert:", err.message);
    }
  }

  return newProducts;
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
