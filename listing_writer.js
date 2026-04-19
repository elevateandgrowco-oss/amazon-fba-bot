// listing_writer.js — Claude Sonnet writes full Amazon listings

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Strip markdown code fences and extract JSON from a Claude response.
 * @param {string} text
 * @returns {string} cleaned JSON string
 */
function parseJSON(text) {
  if (!text) return "{}";

  // Remove markdown code fences
  let cleaned = text
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```\s*$/im, "")
    .trim();

  // Find the outermost { ... } block
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }

  return cleaned;
}

/**
 * Build a concise summary of competitor review themes.
 * @param {Array} reviews
 * @returns {string}
 */
function buildReviewContext(reviews) {
  if (!reviews || reviews.length === 0) return "No competitor reviews available.";

  const negative = reviews.filter((r) => r.rating <= 2);
  const positive = reviews.filter((r) => r.rating >= 4);

  const themes = [];
  if (negative.length > 0) {
    const negTitles = negative.slice(0, 3).map((r) => r.title).join("; ");
    themes.push(`Common complaints: ${negTitles}`);
  }
  if (positive.length > 0) {
    const posTitles = positive.slice(0, 3).map((r) => r.title).join("; ");
    themes.push(`What customers love: ${posTitles}`);
  }

  return themes.join("\n") || "Mixed reviews.";
}

/**
 * Build supplier price context for the listing.
 * @param {Array} suppliers
 * @returns {string}
 */
function buildSupplierContext(suppliers) {
  if (!suppliers || suppliers.length === 0) return "No supplier data available.";
  const top = suppliers.slice(0, 3);
  return top
    .map((s) => `${s.name}: ${s.priceRange} (MOQ: ${s.moq})`)
    .join("\n");
}

/**
 * Write a complete Amazon listing using Claude Sonnet.
 * @param {object} product - Product data including title, price, category, reviews
 * @param {object} keywordData - { keywords: [], backendKeywords: string }
 * @param {Array} suppliers - Supplier objects
 * @returns {object} listing object with title, bullets, description, backendKeywords, suggestedPrice
 */
export async function writeListing(product, keywordData, suppliers) {
  const { title, price, category, bsr, reviewCount, rating, estimatedMonthlySales, margin } = product;
  const keywords = keywordData?.keywords || [];
  const reviewContext = buildReviewContext(product.recentReviews || []);
  const supplierContext = buildSupplierContext(suppliers);

  const topKeywords = keywords.slice(0, 15).join(", ");

  const prompt = `You are an expert Amazon FBA seller and listing copywriter. Write a complete, high-converting Amazon product listing for the following product opportunity.

PRODUCT DETAILS:
- Category: ${category}
- Current competitor title: "${title}"
- Current price point: $${price}
- BSR: ${bsr || "unknown"}
- Competitor review count: ${reviewCount}
- Competitor average rating: ${rating}/5
- Estimated monthly sales at this BSR: ${estimatedMonthlySales} units
- Estimated margin: ${margin}%

TOP KEYWORDS TO INCLUDE (from Amazon autocomplete):
${topKeywords}

COMPETITOR REVIEW INSIGHTS:
${reviewContext}

SUPPLIER COST INFO (for reference):
${supplierContext}

AMAZON LISTING BEST PRACTICES:
- Title: 200 chars max, front-load the #1 keyword, include brand placeholder "[Brand]", include key features
- Bullets: 5 bullets, start with ALL CAPS benefit header, be specific with numbers/claims, 200 chars each max
- Description: 1000 chars, no HTML tags, story-driven, paint the picture of the ideal customer and their problem
- Backend keywords: 249 chars max, space-separated, NO words already in the title, no punctuation
- Suggested price: based on competitor price and your margin analysis, suggest optimal entry price

Write the listing so it:
1. Solves the pain points competitors are failing at (based on their negative reviews)
2. Highlights what customers love (amplify the positive themes)
3. Naturally includes the top keywords throughout
4. Has a compelling, benefit-driven angle that differentiates from competitors

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "title": "...",
  "bullets": ["...", "...", "...", "...", "..."],
  "description": "...",
  "backendKeywords": "...",
  "suggestedPrice": 29.99
}`;

  console.log(`[Listing] Writing listing for: "${title.slice(0, 60)}"`);

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }],
    });

    const rawText = message.content?.[0]?.text || "{}";
    const cleanedJSON = parseJSON(rawText);

    let listing;
    try {
      listing = JSON.parse(cleanedJSON);
    } catch (parseErr) {
      console.error("[Listing] Failed to parse Claude response as JSON:", parseErr.message);
      console.error("[Listing] Raw response snippet:", rawText.slice(0, 300));
      return buildFallbackListing(product, keywords);
    }

    // Validate and truncate fields to Amazon limits
    if (!listing.title) listing.title = title.slice(0, 200);
    else listing.title = listing.title.slice(0, 200);

    if (!Array.isArray(listing.bullets) || listing.bullets.length < 5) {
      listing.bullets = buildFallbackBullets(product);
    } else {
      listing.bullets = listing.bullets.slice(0, 5).map((b) => b.slice(0, 200));
    }

    if (!listing.description) listing.description = "";
    else listing.description = listing.description.slice(0, 1000);

    if (!listing.backendKeywords) {
      listing.backendKeywords = keywordData?.backendKeywords || "";
    }
    listing.backendKeywords = listing.backendKeywords.slice(0, 249);

    if (!listing.suggestedPrice || listing.suggestedPrice <= 0) {
      listing.suggestedPrice = Math.round(price * 0.95 * 100) / 100;
    }

    console.log(`[Listing] Successfully wrote listing — title: "${listing.title.slice(0, 60)}..."`);
    return listing;
  } catch (err) {
    console.error("[Listing] Claude API error:", err.message);
    return buildFallbackListing(product, keywords);
  }
}

/**
 * Build a minimal fallback listing when Claude is unavailable.
 */
function buildFallbackListing(product, keywords) {
  const kw = keywords[0] || product.title.split(" ").slice(0, 3).join(" ");
  return {
    title: `[Brand] ${product.title.slice(0, 185)}`,
    bullets: buildFallbackBullets(product),
    description: `High-quality ${product.category} product. ${product.title}. Designed for customers who demand the best. Order with confidence.`,
    backendKeywords: keywords.slice(1, 20).join(" ").slice(0, 249),
    suggestedPrice: Math.round(product.price * 0.95 * 100) / 100,
  };
}

function buildFallbackBullets(product) {
  return [
    `PREMIUM QUALITY: Crafted with high-quality materials for lasting durability and performance`,
    `PERFECT FIT: Designed specifically for ${product.category} enthusiasts who demand reliability`,
    `EASY TO USE: Simple setup and intuitive design means you spend less time figuring out and more time enjoying`,
    `SATISFACTION GUARANTEED: We stand behind every product with our 100% satisfaction guarantee`,
    `GREAT VALUE: Get professional-grade quality at an affordable price — without compromising on performance`,
  ];
}
