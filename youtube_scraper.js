// youtube_scraper.js — Fetch recent FBA YouTube video titles + extract product niches via Claude

import axios from "axios";
import * as cheerio from "cheerio";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CHANNEL_IDS = [
  "UCUG5BEHfTZXPLwSHl4NSy3Q",
  "UC4B8ywA2Cz_K95w2oeWxizg",
  "UCGRjlfFeU-5eC-ElShfwYPw",
  "UCpBvckYg2UXArcfzRcjpPjw",
  "UC0iJ3ldvDUGiUPfGiiifzVQ",
  "UClUSEsDS2sdgNJfCcCM_5Uw", // My Amazon Guy
  "UC-JgFJyGEAGTQCDH4yWvZjg",
  "UCrbS0KD_OE2516ZLut1VYGw",
  "UCSsWYJQZT32uUsjBKg9r1qA",
  "UCvYbWjz7350Xc6poxlk-S0A",
];

async function fetchChannelTitles(channelId) {
  try {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const res = await axios.get(url, { timeout: 10000 });
    const $ = cheerio.load(res.data, { xmlMode: true });
    const channelName = $("feed > title").first().text().trim();
    const titles = [];
    $("entry title").each((i, el) => {
      if (i < 15) titles.push($(el).text().trim());
    });
    console.log(`[YouTube] ${channelName || channelId}: ${titles.length} titles fetched`);
    return titles;
  } catch (err) {
    console.error(`[YouTube] Failed to fetch channel ${channelId}:`, err.message);
    return [];
  }
}

export async function extractProductNiches() {
  console.log("[YouTube] Fetching video titles from FBA channels...");

  const results = await Promise.allSettled(CHANNEL_IDS.map((id) => fetchChannelTitles(id)));

  const allTitles = results
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value)
    .filter((t) => t.length > 0);

  if (allTitles.length === 0) {
    console.warn("[YouTube] No titles fetched — skipping niche extraction");
    return [];
  }

  console.log(`[YouTube] Total titles fetched: ${allTitles.length}`);

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `You are an Amazon FBA product researcher. Below are recent video titles from top Amazon FBA YouTube channels. Extract 20 specific product search keywords that represent promising FBA opportunities. Focus on physical, sellable products — not strategies, tutorials, or software tools.

Return ONLY a JSON array of strings. Example: ["bamboo cutting board", "silicone ice cube tray", "LED desk lamp"]

Video titles:
${allTitles.slice(0, 80).join("\n")}`,
        },
      ],
    });

    const text = response.content[0].text.trim();
    const cleaned = text
      .replace(/^```(?:json)?\s*/im, "")
      .replace(/\s*```\s*$/im, "")
      .trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    const niches = JSON.parse(cleaned.slice(start, end + 1));

    if (Array.isArray(niches) && niches.length > 0) {
      console.log(
        `[YouTube] Extracted ${niches.length} product niches: ${niches.slice(0, 5).join(", ")}...`
      );
      return niches;
    }
    return [];
  } catch (err) {
    console.error("[YouTube] Claude extraction failed:", err.message);
    return [];
  }
}
