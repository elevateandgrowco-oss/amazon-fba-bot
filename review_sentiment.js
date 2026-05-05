// review_sentiment.js — Analyze competitor reviews with Claude to find product gaps

import axios from "axios";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Fetch up to 50 Amazon reviews for an ASIN using the public review endpoint.
 * Returns an array of { rating, title, body } objects.
 */
async function fetchReviews(asin) {
  const reviews = [];

  try {
    // Amazon's public review page (no auth required, paginated)
    for (let page = 1; page <= 5; page++) {
      const url = `https://www.amazon.com/product-reviews/${asin}/ref=cm_cr_dp_d_show_all_btm?ie=UTF8&reviewerType=all_reviews&pageNumber=${page}&sortBy=recent`;

      const res = await axios.get(url, {
        timeout: 12000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      const html = res.data;

      // Extract reviews via regex (faster than full DOM parse)
      const ratingMatches = [...html.matchAll(/class="a-icon-alt"[^>]*>(\d(?:\.\d)?) out of 5 stars/g)];
      const titleMatches = [...html.matchAll(/class="a-size-base a-link-normal review-title[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/g)];
      const bodyMatches = [...html.matchAll(/class="reviewText review-text-content[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/g)];

      const count = Math.min(ratingMatches.length, bodyMatches.length, 10);
      for (let i = 0; i < count; i++) {
        const rating = parseFloat(ratingMatches[i]?.[1] || "0");
        const title = titleMatches[i]?.[1]?.replace(/<[^>]+>/g, "").trim() || "";
        const body = bodyMatches[i]?.[1]?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || "";
        if (body.length > 20) {
          reviews.push({ rating, title, body: body.slice(0, 300) });
        }
      }

      if (reviews.length >= 40) break;

      // Rate limit between pages
      await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));
    }
  } catch (err) {
    console.error(`[Sentiment] Failed to fetch reviews for ${asin}:`, err.message);
  }

  return reviews;
}

/**
 * Use Claude to extract actionable insights from competitor reviews.
 * Returns structured analysis: complaints, praise, product gaps, and sourcing brief additions.
 */
async function claudeAnalyzeReviews(asin, productTitle, reviews) {
  if (reviews.length === 0) return null;

  const negativeReviews = reviews.filter((r) => r.rating <= 3);
  const positiveReviews = reviews.filter((r) => r.rating >= 4);

  const negText = negativeReviews
    .slice(0, 15)
    .map((r) => `[${r.rating}★] ${r.title}: ${r.body}`)
    .join("\n");

  const posText = positiveReviews
    .slice(0, 10)
    .map((r) => `[${r.rating}★] ${r.title}: ${r.body}`)
    .join("\n");

  const prompt = `You are analyzing Amazon competitor reviews for a product I'm considering sourcing.

Product: "${productTitle}" (ASIN: ${asin})
Total reviews analyzed: ${reviews.length} (${negativeReviews.length} negative, ${positiveReviews.length} positive)

NEGATIVE REVIEWS (1-3 stars):
${negText || "(none)"}

POSITIVE REVIEWS (4-5 stars):
${posText || "(none)"}

Provide a JSON response with this exact structure:
{
  "topComplaints": ["complaint 1", "complaint 2", "complaint 3"],
  "topPraise": ["praise 1", "praise 2", "praise 3"],
  "productGaps": ["specific improvement 1", "specific improvement 2", "specific improvement 3"],
  "sourcingBrief": "2-3 sentence brief for Alibaba supplier describing exactly what improvements to request",
  "listingTips": ["tip 1 to highlight in listing to address competitor weakness", "tip 2"],
  "riskFlags": ["any red flag that suggests this product is hard to get right"],
  "overallSentiment": "positive|mixed|negative",
  "competitorWeaknessScore": 0-10
}

Be specific and actionable. Focus on what I can DO differently when sourcing.`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error(`[Sentiment] Claude analysis failed for ${asin}:`, err.message);
    return null;
  }
}

/**
 * Analyze competitor reviews for a product to find gaps and weaknesses.
 * @param {string} asin
 * @param {string} productTitle
 * @returns {object|null} analysis with complaints, gaps, sourcing brief
 */
export async function analyzeCompetitorReviews(asin, productTitle) {
  console.log(`[Sentiment] Analyzing competitor reviews for ${asin}: "${productTitle.slice(0, 50)}"`);

  const reviews = await fetchReviews(asin);
  if (reviews.length < 5) {
    console.log(`[Sentiment] Not enough reviews for ${asin} (${reviews.length} found) — skipping`);
    return null;
  }

  console.log(`[Sentiment] Fetched ${reviews.length} reviews — sending to Claude`);
  const analysis = await claudeAnalyzeReviews(asin, productTitle, reviews);

  if (analysis) {
    console.log(`[Sentiment] ${asin} — competitor weakness score: ${analysis.competitorWeaknessScore}/10`);
    console.log(`[Sentiment] Top gap: ${analysis.productGaps?.[0] || "none"}`);
  }

  return analysis;
}
