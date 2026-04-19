// fee_calculator.js — FBA fee + margin calculations (pure utility, no external calls)
// Updated to 2025 Amazon FBA fee rates

export const REFERRAL_FEES = {
  "Home & Kitchen": 0.15,
  "Sports & Outdoors": 0.15,
  "Toys & Games": 0.15,
  "Health & Household": 0.08,
  "Beauty & Personal Care": 0.08,
  "Office Products": 0.15,
  "Pet Supplies": 0.15,
  "Tools & Home Improvement": 0.12,
  "YouTube Lead": 0.15,
  default: 0.15,
};

// 2025 FBA fulfillment fees by weight tier
export const FBA_FULFILLMENT_FEES = [
  { maxWeightLbs: 0.25, fee: 3.56, label: "Small standard (<= 4oz)" },
  { maxWeightLbs: 0.5,  fee: 3.69, label: "Small standard (<= 8oz)" },
  { maxWeightLbs: 0.75, fee: 3.90, label: "Small standard (<= 12oz)" },
  { maxWeightLbs: 1.0,  fee: 4.11, label: "Small standard (<= 1lb)" },
  { maxWeightLbs: 2.0,  fee: 5.00, label: "Large standard (<= 2lb)" },
  { maxWeightLbs: 3.0,  fee: 5.65, label: "Large standard (<= 3lb)" },
  { maxWeightLbs: 4.0,  fee: 5.99, label: "Large standard (<= 4lb)" },
  { maxWeightLbs: 5.0,  fee: 6.49, label: "Large standard (<= 5lb)" },
  { maxWeightLbs: 10.0, fee: 7.65, label: "Large standard (<= 10lb)" },
  { maxWeightLbs: 20.0, fee: 9.45, label: "Large standard (<= 20lb)" },
];

// Monthly storage fees per cubic foot (Jan-Sep vs Oct-Dec peak)
const STORAGE_FEE_STANDARD = 0.87;  // Jan-Sep per cubic ft/mo
const STORAGE_FEE_PEAK = 2.40;       // Oct-Dec per cubic ft/mo

// Oversize fallback
const OVERSIZE_BASE_FEE = 10.30;

/**
 * Calculate FBA fees for a product.
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
 * Full margin calculation including COGS, FBA fees, and estimated storage.
 */
export function calculateMargin(price, cogs, weightLbs, category) {
  const { referralFee, fulfillmentFee, totalFees } = calculateFBAFees(price, weightLbs, category);

  // Estimate monthly storage (assume 0.1 cubic ft per lb — rough but reasonable)
  const month = new Date().getMonth();
  const storageFeeRate = month >= 9 ? STORAGE_FEE_PEAK : STORAGE_FEE_STANDARD;
  const estimatedCubicFt = Math.max(0.1, weightLbs * 0.1);
  const monthlyStorage = parseFloat((estimatedCubicFt * storageFeeRate).toFixed(2));

  const profit = parseFloat((price - cogs - totalFees - monthlyStorage).toFixed(2));
  const margin = price > 0 ? parseFloat(((profit / price) * 100).toFixed(1)) : 0;
  const roi = cogs > 0 ? parseFloat(((profit / cogs) * 100).toFixed(1)) : 0;
  return { profit, margin, roi, totalFees, referralFee, fulfillmentFee, monthlyStorage };
}

/**
 * Category-specific BSR → estimated monthly sales.
 * Based on Jungle Scout 2024/2025 data.
 */
export function bsrToMonthlySales(bsr, category = "default") {
  if (!bsr || bsr <= 0) return 0;

  // Category multipliers — high-velocity categories sell more at same BSR
  const categoryMultipliers = {
    "Home & Kitchen": 1.4,
    "Sports & Outdoors": 1.1,
    "Toys & Games": 1.2,
    "Health & Household": 1.3,
    "Beauty & Personal Care": 1.3,
    "Office Products": 0.8,
    "Pet Supplies": 1.0,
    "Tools & Home Improvement": 0.9,
    default: 1.0,
  };

  const multiplier = categoryMultipliers[category] ?? categoryMultipliers.default;

  // Base sales curve (Home & Kitchen baseline)
  let baseSales;
  if (bsr <= 100)     baseSales = 2500;
  else if (bsr <= 300)  baseSales = 1400;
  else if (bsr <= 500)  baseSales = 900;
  else if (bsr <= 1000) baseSales = 600;
  else if (bsr <= 2000) baseSales = 380;
  else if (bsr <= 3000) baseSales = 260;
  else if (bsr <= 5000) baseSales = 180;
  else if (bsr <= 10000) baseSales = 110;
  else if (bsr <= 20000) baseSales = 60;
  else if (bsr <= 50000) baseSales = 30;
  else if (bsr <= 100000) baseSales = 14;
  else if (bsr <= 200000) baseSales = 7;
  else baseSales = 3;

  return Math.round(baseSales * multiplier);
}

/**
 * Score a product opportunity 0–100.
 */
export function scoreProduct(product) {
  let score = 0;
  const { price, reviewCount, rating, bsr, margin, category } = product;

  // Price sweet spot ($20-$60 best for FBA)
  if (price >= 20 && price <= 60) score += 20;
  else if (price >= 15 && price < 20) score += 12;
  else if (price > 60 && price <= 80) score += 12;
  else if (price >= 10 && price < 15) score += 5;
  else if (price > 80 && price <= 120) score += 8;

  // Review count — lower = easier to compete
  if (reviewCount < 100)  score += 30;
  else if (reviewCount < 200)  score += 25;
  else if (reviewCount < 500)  score += 18;
  else if (reviewCount < 1000) score += 10;
  else if (reviewCount < 3000) score += 3;

  // Rating — 3.8-4.3 means room to improve and win
  if (rating >= 3.5 && rating <= 4.3) score += 20;
  else if (rating > 4.3 && rating < 4.6) score += 10;
  else if (rating < 3.5) score += 8; // poor product — you can beat it
  else if (rating >= 4.6) score += 4; // very dominant

  // BSR
  if (bsr > 0) {
    if (bsr <= 3000)        score += 25;
    else if (bsr <= 10000)  score += 18;
    else if (bsr <= 30000)  score += 10;
    else if (bsr <= 50000)  score += 4;
  }

  // Margin (including 2025 fees + storage)
  if (margin >= 40) score += 25;
  else if (margin >= 30) score += 18;
  else if (margin >= 25) score += 10;
  else if (margin >= 20) score += 4;

  return Math.min(100, Math.max(0, score));
}
