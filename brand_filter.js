/**
 * brand_filter.js
 * Filters out branded products that can't be private-labeled or sourced from Alibaba.
 * FBA opportunity = generic/unbranded products only.
 */

const KNOWN_BRANDS = [
  // Pet Supplies
  "blue buffalo","purina","royal canin","hill's","science diet","pedigree","iams","eukanuba",
  "merrick","wellness","natural balance","taste of the wild","nutro","fancy feast","friskies",
  "meow mix","whiskas","orijen","acana","rachael ray","cesar","beneful","pro plan",

  // Home & Kitchen
  "instant pot","cuisinart","kitchenaid","ninja","vitamix","keurig","nespresso","breville",
  "hamilton beach","black+decker","black & decker","crock-pot","crockpot","lodge","le creuset",
  "oxo","pyrex","tefal","t-fal","all-clad","calphalon","staub","wüsthof","wusthof","henckels",

  // Sports & Outdoors
  "nike","adidas","under armour","reebok","new balance","puma","columbia","the north face",
  "patagonia","callaway","taylormade","wilson","titleist","spalding","ping","cobra","cleveland",
  "rawlings","easton","mizuno","brooks","asics","saucony","hoka","salomon",

  // Toys & Games
  "lego","hasbro","mattel","fisher-price","nerf","play-doh","hot wheels","barbie","monopoly",
  "pokemon","funko","melissa & doug","melissa and doug","vtech","leapfrog","playmobil",

  // Health & Household
  "tylenol","advil","benadryl","claritin","zyrtec","nyquil","dayquil","theraflu","mucinex",
  "pepto-bismol","pepto bismol","tide","downy","dawn","palmolive","bounty","charmin","kleenex",
  "lysol","clorox","febreze","mr. clean","mr clean","windex","cascade","finish","arm & hammer",
  "arm and hammer","gillette","dove","degree","old spice","speed stick","secret","ban",

  // Beauty & Personal Care
  "cerave","neutrogena","l'oreal","loreal","olay","garnier","pantene","head & shoulders",
  "aveeno","cetaphil","eucerin","la roche-posay","la roche posay","maybelline","revlon",
  "mac","covergirl","e.l.f.","elf cosmetics","nyx","urban decay","tarte","fenty","glossier",
  "the ordinary","paula's choice","paulas choice","bioderma","vichy","mario badescu",

  // Office Products
  "hp","hewlett packard","brother","canon","epson","post-it","3m","sharpie","bic","pilot",
  "expo","scotch","avery","dymo","swingline","staples","mead","at-a-glance",

  // Tools & Home Improvement
  "dewalt","milwaukee","makita","bosch","black & decker","stanley","craftsman","ryobi",
  "dremel","ridgid","hitachi","metabo","porter-cable","kobalt","husky","hart","worx",

  // Electronics (sometimes scraped)
  "apple","samsung","sony","lg","bose","jbl","anker","amazon basics","amazonbasics",
  "google","microsoft","logitech","belkin","otterbox","spigen","asus","acer","dell","hp",
];

/**
 * Returns true if the product title contains a known brand name.
 * @param {string} title
 * @returns {boolean}
 */
export function isBrandedProduct(title) {
  if (!title) return false;
  const lower = title.toLowerCase();
  return KNOWN_BRANDS.some((brand) => lower.includes(brand));
}

/**
 * Filter an array of products to only private-label opportunities.
 * @param {Array} products
 * @returns {Array}
 */
export function filterBranded(products) {
  const before = products.length;
  const filtered = products.filter((p) => !isBrandedProduct(p.title));
  const removed = before - filtered.length;
  if (removed > 0) {
    console.log(`[BrandFilter] Removed ${removed} branded products (${filtered.length} remain)`);
  }
  return filtered;
}
