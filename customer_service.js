// customer_service.js — Claude reads and replies to all Amazon buyer messages

import Anthropic from "@anthropic-ai/sdk";
import { getRecentOrders, getBuyerMessages, replyToBuyer } from "./amazon_sp_api.js";
import { hasSpApiCredentials } from "./amazon_auth.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a professional, friendly Amazon seller customer service agent.
Your goal is to resolve buyer issues quickly and keep them happy to avoid negative reviews.
Guidelines:
- Be warm, empathetic, and solution-focused
- For shipping delays: apologize and give a realistic timeline
- For damaged/wrong items: immediately offer a replacement or full refund, no questions asked
- For "where is my order": check if tracking was provided and reassure them
- For product questions: answer helpfully based on the product title
- Keep replies concise (3-5 sentences max)
- Never mention you are an AI
- Sign off as "The [Brand] Team"`;

/**
 * Generate a Claude reply to a buyer message.
 */
async function generateReply(productTitle, messageThread) {
  const lastMessage = messageThread[messageThread.length - 1];

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Product: "${productTitle}"

Buyer message: "${lastMessage.text}"

Write a helpful customer service reply.`,
      },
    ],
  });

  return response.content[0].text.trim();
}

/**
 * Check all recent orders for unanswered buyer messages and reply with Claude.
 * @param {boolean} dryRun
 * @returns {Array} list of replied message summaries
 */
export async function handleBuyerMessages(dryRun = false) {
  if (!hasSpApiCredentials()) {
    console.log("[CS] SP-API credentials not set — skipping customer service");
    return [];
  }

  console.log("[CS] Checking for buyer messages...");

  const orders = await getRecentOrders(30);
  console.log(`[CS] Checking ${orders.length} recent orders for messages`);

  const replied = [];

  for (const order of orders) {
    try {
      const messages = await getBuyerMessages(order.AmazonOrderId);
      if (messages.length === 0) continue;

      // Only reply to messages where the last message is from the buyer
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.participant?.role !== "buyer") continue;

      // Get product title from order
      const productTitle = order.OrderItems?.[0]?.Title || "our product";

      const reply = await generateReply(productTitle, messages);

      if (!dryRun) {
        await replyToBuyer(order.AmazonOrderId, reply);
        console.log(`[CS] Replied to buyer for order ${order.AmazonOrderId}`);
      } else {
        console.log(`[CS] DRY RUN — would reply to order ${order.AmazonOrderId}: "${reply.slice(0, 80)}..."`);
      }

      replied.push({
        orderId: order.AmazonOrderId,
        buyerMessage: lastMsg.text?.slice(0, 100),
        reply: reply.slice(0, 100),
      });

      // Small delay between replies
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.error(`[CS] Error handling messages for order ${order.AmazonOrderId}:`, err.message);
    }
  }

  console.log(`[CS] Replied to ${replied.length} buyer messages`);
  return replied;
}
