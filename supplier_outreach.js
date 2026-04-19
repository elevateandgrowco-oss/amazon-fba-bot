// supplier_outreach.js — Auto-email top Alibaba suppliers when a product is validated

import { Resend } from "resend";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@yourdomain.com";
const SELLER_EMAIL = process.env.ALERT_EMAIL;

function getResend() {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not set");
  return new Resend(RESEND_API_KEY);
}

/**
 * Generate a professional RFQ email body for a supplier.
 */
function buildRFQEmail(product, supplier) {
  const productName = product.title?.split(/[,|(]/)[0].trim() || "your product";
  const targetPrice = product.price ? `$${(product.price * 0.25).toFixed(2)}` : "competitive";

  return `
<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; max-width: 600px;">
  <p>Hello,</p>

  <p>My name is ${process.env.SELLER_NAME || "Alex"} and I run an e-commerce business selling products on Amazon USA. I found your company on Alibaba and I'm interested in sourcing <strong>${productName}</strong>.</p>

  <p><strong>Product details I'm looking for:</strong></p>
  <ul>
    <li>Product: ${productName}</li>
    <li>Target selling price on Amazon: $${product.price?.toFixed(2) || "TBD"}</li>
    <li>Target unit cost: ${targetPrice} per unit</li>
    <li>Initial order quantity: 200–500 units (sample order first)</li>
    <li>Ongoing monthly orders: 200–1,000+ units if quality is good</li>
  </ul>

  <p><strong>I'm specifically looking for:</strong></p>
  <ul>
    <li>High quality manufacturing with QC inspection available</li>
    <li>Private label / custom packaging (logo + branded box)</li>
    <li>FBA-ready packaging (individual polybag or box, barcode label)</li>
    <li>Sample order available before bulk order</li>
  </ul>

  <p>Could you please send me:</p>
  <ol>
    <li>Your product catalog / specifications</li>
    <li>Unit price at MOQ 200 and 500 units</li>
    <li>Sample cost and lead time</li>
    <li>Production lead time for bulk orders</li>
    <li>Your Trade Assurance status on Alibaba</li>
  </ol>

  <p>I look forward to building a long-term partnership with the right supplier. Please reply to this email or message me on Alibaba.</p>

  <p>Best regards,<br>
  ${process.env.SELLER_NAME || "Alex"}<br>
  ${process.env.COMPANY_NAME || "Amazon FBA Seller"}</p>
</div>
  `.trim();
}

/**
 * Send RFQ emails to the top 3 suppliers for a validated product.
 * @param {object} product - The validated product opportunity
 * @param {boolean} dryRun
 * @returns {Array} sent email records
 */
export async function contactTopSuppliers(product, dryRun = false) {
  const suppliers = (product.suppliers || []).slice(0, 3);

  if (suppliers.length === 0) {
    console.log("[Outreach] No suppliers found for product — skipping outreach");
    return [];
  }

  console.log(`[Outreach] Contacting ${suppliers.length} suppliers for: ${product.title?.slice(0, 50)}`);

  const sent = [];

  for (const supplier of suppliers) {
    const supplierEmail = supplier.email || supplier.contactEmail;

    if (!supplierEmail) {
      console.log(`[Outreach] No email for supplier "${supplier.name}" — skipping`);
      continue;
    }

    const subject = `RFQ: ${product.title?.split(/[,|(]/)[0].trim().slice(0, 60)} — Amazon FBA Seller`;
    const html = buildRFQEmail(product, supplier);

    if (dryRun) {
      console.log(`[Outreach] DRY RUN — would email "${supplier.name}" <${supplierEmail}>`);
      sent.push({ supplier: supplier.name, email: supplierEmail, status: "dry_run" });
      continue;
    }

    try {
      const resend = getResend();
      await resend.emails.send({
        from: FROM_EMAIL,
        to: supplierEmail,
        replyTo: SELLER_EMAIL,
        subject,
        html,
      });

      console.log(`[Outreach] RFQ sent to "${supplier.name}" <${supplierEmail}>`);
      sent.push({ supplier: supplier.name, email: supplierEmail, status: "sent" });

      // Small delay between emails
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.error(`[Outreach] Failed to email supplier "${supplier.name}":`, err.message);
      sent.push({ supplier: supplier.name, email: supplierEmail, status: "failed", error: err.message });
    }
  }

  return sent;
}
