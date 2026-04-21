// youtube_scraper.js — Scrape Amazon New Releases + Reddit r/FulfillmentByAmazon for product niches
// Replaces YouTube RSS (blocked on Railway) with two sources that actually work

import axios from "axios";
import * as cheerio from "cheerio";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ─── Source 1: Amazon New Releases ───────────────────────────────────────────
const NEW_RELEASE_URLS = [
  { cat: "Home & Kitchen",           url: "https://www.amazon.com/gp/new-releases/home-garden" },
  { cat: "Sports & Outdoors",        url: "https://www.amazon.com/gp/new-releases/sporting-goods" },
  { cat: "Toys & Games",             url: "https://www.amazon.com/gp/new-releases/toys-and-games" },
  { cat: "Health & Household",       url: "https://www.amazon.com/gp/new-releases/hpc" },
  { cat: "Pet Supplies",             url: "https://www.amazon.com/gp/new-releases/pet-supplies" },
  { cat: "Office Products",          url: "https://www.amazon.com/gp/new-releases/office-products" },
];

async function scrapeNewReleases() {
  const titles = [];
  for (const { cat, url } of NEW_RELEASE_URLS) {
    try {
      const res = await axios.get(url, {
        headers: { "User-Agent": UA },
        timeout: 12000,
      });
      const $ = cheerio.load(res.data);
      $(".p13n-sc-truncate, .p13n-sc-truncated, [class*='p13n-sc-line-clamp'], .a-link-normal .a-text-normal").each((i, el) => {
        const t = $(el).text().trim();
        if (t.length > 10 && t.length < 150) titles.push(t);
      });
      console.log(`[Niches] New Releases (${cat}): ${titles.length} total so far`);
    } catch (err) {
      console.log(`[Niches] New Releases (${cat}) failed: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  return [...new Set(titles)].slice(0, 60);
}

// ─── Source 2: Reddit r/FulfillmentByAmazon hot posts ────────────────────────
async function scrapeRedditFBA() {
  try {
    const res = await axios.get("https://www.reddit.com/r/FulfillmentByAmazon/hot.json?limit=30", {
      headers: { "User-Agent": "FBA-Bot/1.0" },
      timeout: 10000,
    });
    const posts = res.data?.data?.children || [];
    return posts
      .map(p => p.data?.title)
      .filter(t => t && t.length > 10);
  } catch (err) {
    console.log(`[Niches] Reddit FBA failed: ${err.message}`);
    return [];
  }
}

// ─── Source 3: Amazon Movers & Shakers titles (already scraped — reuse signal)
const EVERGREEN_NICHES = [
  "portable blender", "bamboo cutting board", "silicone baking mat", "insulated tumbler",
  "foam roller", "resistance bands", "LED desk lamp", "cable organizer", "air purifier",
  "dog puzzle toy", "cat scratcher", "reusable water bottle", "electric toothbrush head",
  "shower caddy", "bath mat", "kitchen organizer", "under bed storage", "closet dividers",
  "outdoor string lights", "solar garden lights", "bird feeder", "plant pot",
];

export async function extractProductNiches() {
  console.log("[Niches] Gathering product signals from Amazon + Reddit...");

  const [newReleaseTitles, redditPosts] = await Promise.all([
    scrapeNewReleases(),
    scrapeRedditFBA(),
  ]);

  const allSignals = [...newReleaseTitles, ...redditPosts];

  if (allSignals.length === 0) {
    console.warn("[Niches] No signals fetched — using evergreen niches");
    return EVERGREEN_NICHES;
  }

  console.log(`[Niches] ${newReleaseTitles.length} new release titles + ${redditPosts.length} Reddit posts`);

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `You are an Amazon FBA product researcher. Below are Amazon new release product titles and Reddit FBA community posts. Extract 20 specific product search keywords representing promising FBA opportunities — physical products with low competition potential.

Focus on: products under $50, everyday use items, items with repeat purchase potential, NOT branded products (no brand-specific names).

Return ONLY a JSON array of strings. Example: ["bamboo cutting board", "silicone ice cube tray", "LED desk lamp"]

Signals:
${allSignals.slice(0, 80).join("\n")}`,
      }],
    });

    const text = response.content[0].text.trim()
      .replace(/^```(?:json)?\s*/im, "")
      .replace(/\s*```\s*$/im, "")
      .trim();
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    const niches = JSON.parse(text.slice(start, end + 1));

    if (Array.isArray(niches) && niches.length > 0) {
      console.log(`[Niches] Extracted ${niches.length} niches: ${niches.slice(0, 5).join(", ")}...`);
      return niches;
    }
    return EVERGREEN_NICHES;
  } catch (err) {
    console.error("[Niches] Claude extraction failed:", err.message);
    return EVERGREEN_NICHES;
  }
}
