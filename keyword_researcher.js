// keyword_researcher.js — Amazon autocomplete keyword extraction

import axios from "axios";

const MONEY_WORDS = new Set([
  "best", "top", "cheap", "affordable", "premium", "professional", "heavy duty",
  "high quality", "waterproof", "organic", "natural", "durable", "adjustable",
  "portable", "wireless", "rechargeable", "stainless steel", "for women", "for men",
  "for kids", "large", "small", "set of", "pack", "bundle", "gift",
]);

/**
 * Fetch Amazon autocomplete suggestions for a prefix.
 * @param {string} prefix - Search prefix
 * @returns {Array<string>} suggestion strings
 */
async function fetchAutocompleteSuggestions(prefix) {
  if (!prefix || prefix.trim().length < 2) return [];

  try {
    const encoded = encodeURIComponent(prefix.trim().toLowerCase());
    // Randomize session ID to avoid bot detection
    const sessionId = `${Math.floor(Math.random() * 999)}-${Math.floor(Math.random() * 9999999)}-${Math.floor(Math.random() * 9999999)}`;
    const requestId = Math.random().toString(36).slice(2, 12);
    const url =
      `https://completion.amazon.com/api/2017/suggestions` +
      `?session-id=${sessionId}` +
      `&customer-id=&request-id=${requestId}` +
      `&page-type=Gateway` +
      `&lop=en_US` +
      `&site-variant=desktop` +
      `&client-info=amazon-search-ui` +
      `&mid=ATVPDKIKX0DER` +
      `&alias=aps` +
      `&b2b=0` +
      `&fresh=0` +
      `&ks=80` +
      `&prefix=${encoded}` +
      `&event=onkeypress` +
      `&limit=11` +
      `&fb=1` +
      `&suggestion-type=KEYWORD` +
      `&_=1704000000000`;

    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/json, text/javascript, */*",
        Referer: "https://www.amazon.com/",
      },
    });

    const data = response.data;
    if (!data || !Array.isArray(data.suggestions)) return [];

    return data.suggestions
      .filter((s) => s && s.value)
      .map((s) => s.value.trim().toLowerCase())
      .filter(Boolean);
  } catch (err) {
    // Silently skip — autocomplete failures are non-critical
    return [];
  }
}

/**
 * Extract seed keywords from a product title.
 * @param {string} title
 * @returns {Array<string>}
 */
function extractSeeds(title) {
  if (!title) return [];

  // Remove common noise words
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "for", "with", "in", "on", "at", "to", "of",
    "by", "from", "up", "about", "into", "through", "during", "before", "after",
    "above", "below", "between", "out", "off", "over", "under", "again", "further",
    "then", "once", "pack", "set", "pcs", "pieces", "count", "each",
  ]);

  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.split(" ").filter((w) => w.length > 2 && !stopWords.has(w));

  // Build seeds: individual words + bigrams + trigrams
  const seeds = new Set();

  // Full first 3-word phrase
  if (words.length >= 3) seeds.add(words.slice(0, 3).join(" "));
  if (words.length >= 2) seeds.add(words.slice(0, 2).join(" "));

  // Individual meaningful words
  words.slice(0, 6).forEach((w) => seeds.add(w));

  // Bigrams from first 5 words
  for (let i = 0; i < Math.min(words.length - 1, 4); i++) {
    seeds.add(`${words[i]} ${words[i + 1]}`);
  }

  return [...seeds].filter((s) => s.length >= 3).slice(0, 8);
}

/**
 * Score a keyword by relevance signals.
 * @param {string} keyword
 * @param {number} frequency - How many seed queries surfaced this keyword
 * @returns {number}
 */
function scoreKeyword(keyword, frequency) {
  let score = frequency * 10;

  const lower = keyword.toLowerCase();

  // Money words bonus
  for (const word of MONEY_WORDS) {
    if (lower.includes(word)) {
      score += 8;
      break;
    }
  }

  // Longer phrases tend to be more specific / buyer-intent
  const wordCount = keyword.split(" ").length;
  if (wordCount >= 3) score += 5;
  if (wordCount >= 4) score += 3;

  // Penalize very short single words
  if (wordCount === 1 && keyword.length < 6) score -= 5;

  return score;
}

/**
 * Research keywords for a product using Amazon autocomplete.
 * @param {string} productTitle
 * @param {string} asin
 * @returns {{ keywords: Array<string>, backendKeywords: string }}
 */
export async function researchKeywords(productTitle, asin) {
  console.log(`[Keywords] Researching keywords for ASIN ${asin}: "${productTitle.slice(0, 60)}"`);

  const seeds = extractSeeds(productTitle);
  console.log(`[Keywords] Seeds extracted: ${seeds.join(", ")}`);

  const keywordFrequency = new Map();

  for (const seed of seeds) {
    try {
      const suggestions = await fetchAutocompleteSuggestions(seed);
      for (const kw of suggestions) {
        keywordFrequency.set(kw, (keywordFrequency.get(kw) || 0) + 1);
      }
      // Small delay between autocomplete calls
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
    } catch {
      // Continue on individual seed failure
    }
  }

  // Score and sort
  const scored = [...keywordFrequency.entries()]
    .map(([kw, freq]) => ({ keyword: kw, score: scoreKeyword(kw, freq) }))
    .sort((a, b) => b.score - a.score);

  const topKeywords = scored.slice(0, 30).map((s) => s.keyword);

  // Always include the product title words as top keywords
  const titleWords = extractSeeds(productTitle).slice(0, 3);
  const finalKeywords = [...new Set([...titleWords, ...topKeywords])].slice(0, 30);

  const backendKeywords = generateBackendKeywords(finalKeywords, productTitle);

  console.log(`[Keywords] Found ${finalKeywords.length} keywords for ${asin}`);

  return { keywords: finalKeywords, backendKeywords };
}

/**
 * Generate backend search terms string (250 chars max, no repeats from title).
 * @param {Array<string>} keywords
 * @param {string} title
 * @returns {string}
 */
export function generateBackendKeywords(keywords, title) {
  const titleWords = new Set(
    (title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );

  // Filter out words already in title
  const unique = [];
  const usedWords = new Set();

  for (const kw of keywords) {
    const kwWords = kw.toLowerCase().split(/\s+/);
    // Include the keyword if it adds at least one new word not in title
    const hasNewWord = kwWords.some((w) => !titleWords.has(w) && !usedWords.has(w));
    if (hasNewWord) {
      kwWords.forEach((w) => usedWords.add(w));
      unique.push(kw);
    }
  }

  // Build space-separated string up to 249 chars
  let result = "";
  for (const kw of unique) {
    const candidate = result ? `${result} ${kw}` : kw;
    if (candidate.length <= 249) {
      result = candidate;
    } else {
      break;
    }
  }

  return result;
}
