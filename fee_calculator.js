// fee_calculator.js — FBA fee + margin calculations (pure utility, no external calls)

export const REFERRAL_FEES = {
  "Home & Kitchen": 0.15,
  "Sports & Outdoors": 0.15,
  "Toys & Games": 0.15,
  "Health & Household": 0.08,
  "Beauty & Personal Care": 0.08,
  "Office Products": 0.15,
  "Pet Supplies": 0.15,
  "Tools & Home Improvement": 0.12,
  default: 0.15,
};

// Standard-size FBA fulfillment fees by weight tier (2024 rates)
export const FBA_FULFILLMENT_FEES = [
  { maxWeightLbs: 0.25, fee: 3.22, label: "Small standard (<= 4oz)" },
  { maxWeightLbs: 0.5,  fee: 3.40, label: "Small standard (<= 8oz)" },
  { maxWeightLbs: 0.75, fee: 3.58, label: "Small standard (<= 12oz)" },
  { maxWeightLbs: 1.0,  fee: 3.77, label: "Small standard (<= 1lb)" },
  { maxWeightLbs: 2.0,  fee: 4.75, label: "Large standard (<= 2lb)" },
  { maxWeightLbs: 3.0,  fee: 5.40, label: "Large standard (<= 3lb)" },
  { maxWeightLbs: 4.0,  fee: 5.69, label: "Large standard (<= 4lb)" },
  { maxWeightLbs: 5.0,  fee: 6.10, label: "Large standard (<= 5lb)" },
  { maxWeightLbs: 10.0, fee: 7.17, label: "Large standard (<= 10lb)" },
  { maxWeightLbs: 20.0, fee: 8.40, label: "Large standard (<= 20lb)" },
];

// Fallback fee for oversize items
const OVERSIZE_BASE_FEE = 9.73;

/**
 * Calculate FBA fees for a product.
 * @param {number} price - Selling price
 * @param {number} weightLbs - Item weight in pounds
 * @param {string} category - Amazon category name
 * @returns {{ referralFee, fulfillmentFee, totalFees }}
 */
export function calculateFBAFees(price, weightLbs, category) {
  const referralRate = REFERRAL_FEES[category] ?? REFERRAL_FEES.default;
  const referralFee = parseFloat((price * referralRate).toFixed(2));

  let fulfillmentFee = OVERSIZE_BASE_FEE;
  for (const tier of FBA_FULFILLMENT_FEES) {
    if (weightLbs <= tier.maxWeightLbs) {
      fulfillmentFee = tier.fee;
      break;
    }
  }

  const totalFees = parseFloat((referralFee + fulfillmentFee).toFixed(2));
  return { referralFee, fulfillmentFee, totalFees };
}

/**
 * Full margin calculation including COGS and FBA fees.
 * @param {number} price - Selling price
 * @param {number} cogs - Cost of goods (unit landed cost)
 * @param {number} weightLbs - Item weight in pounds
 * @param {string} category - Amazon category name
 * @returns {{ profit, margin, roi, totalFees, referralFee, fulfillmentFee }}
 */
export function calculateMargin(price, cogs, weightLbs, category) {
  const { referralFee, fulfillmentFee, totalFees } = calculateFBAFees(price, weightLbs, category);
  const profit = parseFloat((price - cogs - totalFees).toFixed(2));
  const margin = price > 0 ? parseFloat(((profit / price) * 100).toFixed(1)) : 0;
  const roi = cogs > 0 ? parseFloat(((profit / cogs) * 100).toFixed(1)) : 0;
  return { profit, margin, roi, totalFees, referralFee, fulfillmentFee };
}

/**
 * Rough BSR → estimated monthly sales curve.
 * Based on empirical data for general categories.
 * @param {number} bsr - Best Seller Rank
 * @returns {number} estimated monthly units
 */
export function bsrToMonthlySales(bsr) {
  if (!bsr || bsr <= 0) return 0;
  if (bsr <= 100)    return 3000;
  if (bsr <= 500)    return 1500;
  if (bsr <= 1000)   return 900;
  if (bsr <= 3000)   return 500;
  if (bsr <= 5000)   return 300;
  if (bsr <= 10000)  return 180;
  if (bsr <= 20000)  return 100;
  if (bsr <= 50000)  return 50;
  if (bsr <= 100000) return 25;
  if (bsr <= 200000) return 10;
  return 5;
}

/**
 * Score a product opportunity 0–100 based on key metrics.
 * @param {object} product - Product object with price, reviews, rating, bsr, margin fields
 * @returns {number} opportunity score 0–100
 */
export function scoreProduct(product) {
  let score = 0;
  const { price, reviewCount, rating, bsr, margin } = product;

  // --- Price range ---
  if (price >= 15 && price <= 80) {
    if (price >= 20 && price <= 50) score += 20; // sweet spot
    else score += 15;
  } else if (price >= 10 && price < 15) {
    score += 5;
  } else if (price > 80 && price <= 120) {
    score += 8;
  }
  // Outside $10-$120: 0 pts

  // --- Review count (lower = less competition) ---
  if (reviewCount < 200)  score += 30;
  else if (reviewCount < 500)  score += 20;
  else if (reviewCount < 1000) score += 10;
  else if (reviewCount < 3000) score += 3;

  // --- Rating (room to compete vs. already dominant) ---
  if (rating >= 3.8 && rating <= 4.2) score += 20;
  else if (rating > 4.2 && rating < 4.5) score += 10;
  else if (rating < 3.8) score += 5; // poor product — you can beat it
  else if (rating >= 4.5) score += 5; // very dominant, harder to enter

  // --- BSR (lower = more sales) ---
  if (bsr > 0) {
    if (bsr <= 5000)        score += 25;
    else if (bsr <= 20000)  score += 15;
    else if (bsr <= 50000)  score += 5;
  }

  // --- Margin ---
  if (margin >= 40) score += 25;
  else if (margin >= 30) score += 15;
  else if (margin >= 20) score += 5;

  return Math.min(100, Math.max(0, score));
}
