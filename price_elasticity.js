// price_elasticity.js — Automatically test price points to find the most profitable price

import { Resend } from "resend";
import { updatePrice, getSalesTrafficReport, hasSpApiCredentials } from "./amazon_sp_api.js";
import { calculateMargin } from "./fee_calculator.js";
import { loadDB, saveDB } from "./products_db.js";

const resend = new Resend(process.env.RESEND_API_KEY);

// How long to hold each test price before measuring (days)
const TEST_DURATION_DAYS = 7;
// Price change increments to test
const TEST_STEPS = [-0.10, +0.10, +0.15]; // -10%, +10%, +15%
// Don't touch a product that was adjusted in the last N days
const COOLDOWN_DAYS = 8;
// If conversion drops more than this relative to baseline, revert
const MAX_CVR_DROP = 0.20; // 20% relative drop allowed

/**
 * Pick the next untested price step for this product.
 * Returns null if all steps tested or product is in cooldown.
 */
function getNextTestStep(product) {
  const testedSteps = new Set((product.priceTests || []).map((t) => t.step));
  return TEST_STEPS.find((s) => !testedSteps.has(s)) ?? null;
}

/**
 * Find the best price from all completed tests.
 * "Best" = highest gross profit per unit at acceptable conversion rate.
 */
function findBestPrice(product) {
  const tests = (product.priceTests || []).filter((t) => t.status === "completed");
  const baseline = product.priceTests?.find((t) => t.step === 0 && t.status === "completed");

  if (tests.length === 0) return null;

  // Include baseline if we have one, otherwise use estimated conversion
  const baselineCVR = baseline?.conversionRate || product.baselineConversionRate || 0.08;

  let bestProfit = -Infinity;
  let bestPrice = product.price;

  for (const test of tests) {
    // Penalize if conversion dropped significantly
    const cvrRatio = baselineCVR > 0 ? test.conversionRate / baselineCVR : 1;
    if (cvrRatio < (1 - MAX_CVR_DROP)) continue; // conversion dropped too much

    const { profit } = calculateMargin(
      test.price,
      product.estimatedCOGS || product.price * 0.28,
      product.weightLbs || 1.0,
      product.category || ""
    );

    // Adjust profit by relative conversion to get expected profit per 100 sessions
    const adjustedProfit = profit * cvrRatio;

    if (adjustedProfit > bestProfit) {
      bestProfit = adjustedProfit;
      bestPrice = test.price;
    }
  }

  return bestPrice !== product.price ? bestPrice : null;
}

/**
 * Send price optimization result email.
 */
async function sendElasticityReport(results) {
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL || results.length === 0) return;

  const rows = results
    .map((r) => `
      <tr>
        <td style="padding:10px;font-size:13px;">
          <a href="https://www.amazon.com/dp/${r.asin}" style="color:#0066c0;">${r.title?.slice(0, 50) || r.asin}</a>
        </td>
        <td style="padding:10px;font-size:13px;text-align:center;">$${r.previousPrice.toFixed(2)}</td>
        <td style="padding:10px;font-size:13px;text-align:center;font-weight:bold;color:#27ae60;">$${r.newPrice.toFixed(2)}</td>
        <td style="padding:10px;font-size:13px;text-align:center;color:${r.marginChange >= 0 ? "#27ae60" : "#e74c3c"};">
          ${r.marginChange >= 0 ? "+" : ""}${r.marginChange.toFixed(1)}%
        </td>
        <td style="padding:10px;font-size:13px;text-align:center;color:#555;">${r.action}</td>
      </tr>
    `).join("");

  await resend.emails.send({
    from: process.env.FROM_EMAIL || "bot@yourdomain.com",
    to: process.env.ALERT_EMAIL,
    subject: `Price Optimization: ${results.length} product${results.length > 1 ? "s" : ""} updated for higher profit`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:700px;color:#222;">
        <div style="background:#27ae60;color:white;padding:16px 24px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;">Price Elasticity Optimization</h2>
          <p style="margin:6px 0 0;opacity:0.9;font-size:14px;">Your bot tested price points and found better margins</p>
        </div>
        <div style="border:1px solid #27ae60;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:#f8f8f8;">
                <th style="padding:8px;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">Product</th>
                <th style="padding:8px;text-align:center;font-size:12px;text-transform:uppercase;color:#666;">Old Price</th>
                <th style="padding:8px;text-align:center;font-size:12px;text-transform:uppercase;color:#666;">New Price</th>
                <th style="padding:8px;text-align:center;font-size:12px;text-transform:uppercase;color:#666;">Margin Change</th>
                <th style="padding:8px;text-align:center;font-size:12px;text-transform:uppercase;color:#666;">Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `,
  });
}

/**
 * Run price elasticity tests for all launched products.
 * Each product gets one price change per week — measures conversion rate impact.
 * @param {boolean} dryRun
 * @returns {Array} actions taken
 */
export async function runPriceElasticityTests(dryRun = false) {
  if (!hasSpApiCredentials()) {
    console.log("[Elasticity] SP-API credentials not set — skipping price tests");
    return [];
  }

  console.log("[Elasticity] Running price elasticity engine...");

  const db = loadDB();
  const launched = (db.opportunities || []).filter(
    (p) => p.status === "launched" && p.sku && p.price > 0
  );

  if (launched.length === 0) {
    console.log("[Elasticity] No launched products to test");
    return [];
  }

  // Fetch current conversion rate data from sales/traffic report
  let trafficData = [];
  try {
    trafficData = await getSalesTrafficReport(7);
  } catch (err) {
    console.error("[Elasticity] Failed to fetch traffic report:", err.message);
  }

  const trafficByAsin = {};
  for (const row of trafficData) {
    if (row.asin) trafficByAsin[row.asin] = row;
  }

  const actions = [];

  for (const product of launched) {
    try {
      const now = Date.now();
      const priceTests = product.priceTests || [];
      const activeTest = priceTests.find((t) => t.status === "active");
      const lastAdjustedAt = product.lastPriceTestAt ? new Date(product.lastPriceTestAt).getTime() : 0;
      const daysSinceLastTest = (now - lastAdjustedAt) / (1000 * 60 * 60 * 24);

      // Measure active test if it has been running long enough
      if (activeTest && daysSinceLastTest >= TEST_DURATION_DAYS) {
        const traffic = trafficByAsin[product.asin];
        const conversionRate = traffic?.unitSessionPct || 0;

        console.log(`[Elasticity] ${product.asin} — measuring test (step ${activeTest.step > 0 ? "+" : ""}${(activeTest.step * 100).toFixed(0)}%): CVR=${(conversionRate * 100).toFixed(1)}%`);

        // Mark test as completed with measured CVR
        const updatedTests = priceTests.map((t) =>
          t === activeTest ? { ...t, status: "completed", conversionRate, measuredAt: new Date().toISOString() } : t
        );

        const db2 = loadDB();
        const idx = db2.opportunities.findIndex((o) => o.asin === product.asin);
        if (idx !== -1) {
          db2.opportunities[idx] = {
            ...db2.opportunities[idx],
            priceTests: updatedTests,
            lastPriceTestAt: new Date().toISOString(),
          };
          saveDB(db2);
        }

        // Check if all steps tested — if so, apply the best price
        const allCompleted = TEST_STEPS.every((step) =>
          updatedTests.some((t) => t.step === step && t.status === "completed")
        );

        if (allCompleted) {
          const updatedProduct = { ...product, priceTests: updatedTests };
          const bestPrice = findBestPrice(updatedProduct);

          if (bestPrice && Math.abs(bestPrice - product.price) > 0.50) {
            const { margin: newMargin } = calculateMargin(
              bestPrice,
              product.estimatedCOGS || product.price * 0.28,
              product.weightLbs || 1.0,
              product.category || ""
            );
            const { margin: oldMargin } = calculateMargin(
              product.price,
              product.estimatedCOGS || product.price * 0.28,
              product.weightLbs || 1.0,
              product.category || ""
            );

            console.log(`[Elasticity] ${product.asin} — optimal price: $${bestPrice.toFixed(2)} (was $${product.price.toFixed(2)}, margin ${oldMargin}% → ${newMargin}%)`);

            if (!dryRun) {
              await updatePrice(product.sku, bestPrice);
            }

            actions.push({
              asin: product.asin,
              title: product.title,
              previousPrice: product.price,
              newPrice: bestPrice,
              marginChange: newMargin - oldMargin,
              action: dryRun ? "DRY RUN" : "Applied",
            });

            // Save final price
            const db3 = loadDB();
            const idx3 = db3.opportunities.findIndex((o) => o.asin === product.asin);
            if (idx3 !== -1) {
              db3.opportunities[idx3] = {
                ...db3.opportunities[idx3],
                price: dryRun ? product.price : bestPrice,
                priceOptimizedAt: new Date().toISOString(),
                priceTestsCompleted: true,
              };
              saveDB(db3);
            }
          } else {
            console.log(`[Elasticity] ${product.asin} — current price $${product.price.toFixed(2)} is already optimal`);
          }
        }
        continue;
      }

      // In cooldown or test still running
      if (activeTest) {
        console.log(`[Elasticity] ${product.asin} — active test running (${daysSinceLastTest.toFixed(1)}/${TEST_DURATION_DAYS} days)`);
        continue;
      }

      if (daysSinceLastTest < COOLDOWN_DAYS && lastAdjustedAt > 0) {
        console.log(`[Elasticity] ${product.asin} — in cooldown (${daysSinceLastTest.toFixed(1)}/${COOLDOWN_DAYS} days)`);
        continue;
      }

      // Don't test products that have already been fully optimized
      if (product.priceTestsCompleted) {
        console.log(`[Elasticity] ${product.asin} — price optimization complete`);
        continue;
      }

      // Start next test
      const nextStep = getNextTestStep(product);
      if (nextStep === null) continue;

      // Capture baseline CVR before first test
      if (priceTests.length === 0) {
        const traffic = trafficByAsin[product.asin];
        if (traffic) {
          const db2 = loadDB();
          const idx = db2.opportunities.findIndex((o) => o.asin === product.asin);
          if (idx !== -1) {
            db2.opportunities[idx].baselineConversionRate = traffic.unitSessionPct;
            saveDB(db2);
          }
        }
      }

      // Round to .99 pricing
      const rawTestPrice = product.price * (1 + nextStep);
      const testPrice = Math.round(rawTestPrice) - 0.01;

      // Don't go below floor price (20% minimum margin)
      const { profit } = calculateMargin(
        testPrice,
        product.estimatedCOGS || product.price * 0.28,
        product.weightLbs || 1.0,
        product.category || ""
      );

      if (profit < 0) {
        console.log(`[Elasticity] ${product.asin} — skipping step ${nextStep} (would be unprofitable at $${testPrice.toFixed(2)})`);
        continue;
      }

      console.log(`[Elasticity] ${product.asin} — starting test: $${product.price.toFixed(2)} → $${testPrice.toFixed(2)} (${nextStep > 0 ? "+" : ""}${(nextStep * 100).toFixed(0)}%)`);

      if (!dryRun) {
        await updatePrice(product.sku, testPrice);
      }

      const newTest = {
        step: nextStep,
        price: testPrice,
        startedAt: new Date().toISOString(),
        status: "active",
        conversionRate: null,
      };

      const db2 = loadDB();
      const idx = db2.opportunities.findIndex((o) => o.asin === product.asin);
      if (idx !== -1) {
        db2.opportunities[idx] = {
          ...db2.opportunities[idx],
          priceTests: [...priceTests, newTest],
          lastPriceTestAt: new Date().toISOString(),
        };
        saveDB(db2);
      }

      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`[Elasticity] Error testing ${product.asin}:`, err.message);
    }
  }

  if (actions.length > 0 && !dryRun) {
    try {
      await sendElasticityReport(actions);
    } catch (err) {
      console.error("[Elasticity] Failed to send report email:", err.message);
    }
  }

  console.log(`[Elasticity] Done — ${actions.length} price optimizations applied`);
  return actions;
}
