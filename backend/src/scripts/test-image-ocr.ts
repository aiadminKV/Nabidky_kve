/**
 * Test: Extrakce položek z obrázku (ceník/objednávka s objednacími kódy a EAN)
 *
 * Spustit: cd backend && npx tsx src/scripts/test-image-ocr.ts
 *
 * Co testuje:
 *   1. OCR extrakce textu z obrázku (GPT-5.4 vision)
 *   2. Identifikace objednacích kódů v OCR výstupu
 *   3. extractProductCodes – extrahuje kódy z řádků OCR textu
 *   4. lookupProductsExact – vyhledání produktů přes objednací kódy
 *   5. searchPipelineForItem – plný pipeline s objednacím kódem v názvu
 */

import fs from "fs";
import path from "path";
import { extractTextFromImage } from "../services/imageOcr.js";
import { extractProductCodes } from "../services/searchPipeline.js";
import { searchPipelineV2ForItem } from "../services/searchPipelineV2.js";
import { lookupProductsExact } from "../services/search.js";

// ── Helpers ──────────────────────────────────────────────────

function ok(msg: string) { console.log(`  ✅ ${msg}`); }
function fail(msg: string) { console.log(`  ❌ ${msg}`); }
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }
function warn(msg: string) { console.log(`  ⚠️  ${msg}`); }
function section(title: string) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${title}`);
  console.log("═".repeat(70));
}
function sub(title: string) {
  console.log(`\n  ${"─".repeat(60)}`);
  console.log(`  ${title}`);
}

// ── Testovací data (z obrázku) ────────────────────────────────
// Položky viditelné na obrázku: PLU | Název | MJ | Objednací č. | Množství

const EXPECTED_ITEMS = [
  { plu: "9888",  name: "ABB PRAKTIK zás.1x konc. 5518-2929 šedá",    orderCode: "5518-2929S",     qty: 10, unit: "ks" },
  { plu: "9881",  name: "ABB TANGO kon.zásuvka RJ45 do masky DAT",     orderCode: "KEJ-C5E-U-BK",   qty: 3,  unit: "ks" },
  { plu: "9139",  name: "ABB TANGO kryt sp.1x 3558-A651B bílá",        orderCode: "3558A-A651B",    qty: 20, unit: "ks" },
  { plu: "9141",  name: "ABB TANGO rám.1x vodorov.3901-B10B bílá",     orderCode: "3901A-B10B",     qty: 20, unit: "ks" },
  { plu: "9145",  name: "ABB TANGO rám.2x svislý 3901-B21B bílá",      orderCode: "3901A-B21B",     qty: 10, unit: "ks" },
  { plu: "9142",  name: "ABB TANGO rám.2x vodorov.3901-B20B bílá",     orderCode: "3901A-B20B",     qty: 10, unit: "ks" },
  { plu: "8217",  name: "ABB TANGO rám.3x svislý 3901-B31B bílá",      orderCode: "3901A-B31B",     qty: 2,  unit: "ks" },
  { plu: "9144",  name: "ABB TANGO rám.4x vodorov.3901-B40B bílá",     orderCode: "3901A-B40B",     qty: 2,  unit: "ks" },
  { plu: "8938",  name: "ABB TANGO stroj.sp.f1 3559-01345",            orderCode: "3559-A01345",    qty: 10, unit: "ks" },
  { plu: "10060", name: "ABB TANGO zás.1x pero 5519-2357C slon",       orderCode: "5519A-A02357C",  qty: 5,  unit: "ks" },
  { plu: "9937",  name: "Bužírka spirálová SPC 10 černá 10m",          orderCode: "SPC10T",         qty: 1,  unit: "ks" },
];

// ── Test 1: OCR – extrakce textu z obrázku ────────────────────

async function testOcr(imagePath: string): Promise<string | null> {
  section("TEST 1: OCR – extrakce textu z obrázku (GPT-5.4 vision)");
  info(`Soubor: ${path.basename(imagePath)}`);

  if (!fs.existsSync(imagePath)) {
    fail(`Soubor nenalezen: ${imagePath}`);
    return null;
  }

  const imageBuffer = fs.readFileSync(imagePath);
  const base64 = imageBuffer.toString("base64");
  const mimeType = "image/png";

  info("Volám extractTextFromImage...");
  const t0 = Date.now();
  const ocrText = await extractTextFromImage(base64, mimeType);
  const elapsed = Date.now() - t0;
  info(`OCR dokončeno za ${elapsed}ms`);

  console.log("\n  --- OCR výstup (první 800 znaků) ---");
  console.log(ocrText.slice(0, 800));
  if (ocrText.length > 800) info(`... (celkem ${ocrText.length} znaků)`);

  // Zkontroluj přítomnost objednacích kódů v OCR výstupu
  sub("Kontrola přítomnosti objednacích kódů v OCR textu:");
  let foundCodes = 0;
  for (const item of EXPECTED_ITEMS) {
    const codeBase = item.orderCode.replace(/[()]/g, "").split(" ")[0];
    const found = ocrText.includes(codeBase) || ocrText.toLowerCase().includes(codeBase.toLowerCase());
    if (found) {
      ok(`${codeBase} — nalezen v OCR výstupu`);
      foundCodes++;
    } else {
      fail(`${codeBase} — CHYBÍ v OCR výstupu`);
    }
  }
  info(`Nalezeno ${foundCodes}/${EXPECTED_ITEMS.length} objednacích kódů v OCR`);

  // Zkontroluj přítomnost množství
  sub("Kontrola přítomnosti množství v OCR textu:");
  const quantities = ["10.000", "3.000", "20.000", "2.000", "5.000", "1.000"];
  for (const q of quantities) {
    const found = ocrText.includes(q) || ocrText.includes(q.replace(".000", ""));
    if (found) ok(`Množství ${q} nalezeno`);
    else warn(`Množství ${q} nenalezeno`);
  }

  return ocrText;
}

// ── Test 2: extractProductCodes – extrakce z OCR řádků ────────

async function testCodeExtraction(ocrText: string) {
  section("TEST 2: extractProductCodes – extrakce kódů z OCR textu");
  info("Testuje schopnost pipeline rozeznat objednací kódy z řádků OCR");

  const testLines = [
    "9888 ABB PRAKTIK zás.1x konc. 5518-2929 šedá  ks  5518-2929S  10.000",
    "9881 ABB TANGO kon.zásuvka RJ45 do masky DAT  ks  KEJ-C5E-U-BK  3.000",
    "9139 ABB TANGO kryt sp.1x 3558-A651B bílá  ks  3558A-A651B  20.000",
    "9141 ABB TANGO rám.1x vodorov.3901-B10B bílá  ks  3901A-B10B  20.000",
    "8938 ABB TANGO stroj.sp.f1 3559-01345  ks  3559-A01345  10.000",
  ];

  for (const line of testLines) {
    const codes = await extractProductCodes(line);
    const hasCode = codes.length > 0;
    if (hasCode) {
      ok(`"${line.slice(0, 50)}..."\n       → kódy: ${codes.join(", ")}`);
    } else {
      fail(`"${line.slice(0, 50)}..."\n       → žádné kódy extrahovány!`);
    }
  }

  // Zkus i celý OCR text
  sub("Extrakce kódů z celého OCR výstupu:");
  const allCodes = await extractProductCodes(ocrText.slice(0, 2000));
  if (allCodes.length > 0) {
    ok(`Extrahovány kódy: ${allCodes.join(", ")}`);
  } else {
    fail("Z celého OCR textu nebyly extrahovány žádné kódy");
  }
}

// ── Test 3: lookupProductsExact – přímé vyhledání kódem ──────

async function testExactLookup() {
  section("TEST 3: lookupProductsExact – vyhledání přes objednací kód");
  info("Testuje schopnost DB najít produkty přes objednací čísla výrobce");

  const lookupCodes = [
    { code: "5518-2929S",    expected: "ABB PRAKTIK zásuvka" },
    { code: "KEJ-C5E-U-BK",  expected: "ABB TANGO RJ45" },
    { code: "3558A-A651B",   expected: "ABB TANGO kryt" },
    { code: "3901A-B10B",    expected: "ABB TANGO rám 1x" },
    { code: "3901A-B21B",    expected: "ABB TANGO rám 2x svislý" },
    { code: "3901A-B31B",    expected: "ABB TANGO rám 3x" },
    { code: "3559-A01345",   expected: "ABB TANGO stroj.sp." },
    { code: "SPC10T",        expected: "Bužírka spirálová SPC10" },
  ];

  let found = 0;
  let notFound = 0;

  for (const { code, expected } of lookupCodes) {
    const results = await lookupProductsExact(code, 5);
    if (results.length > 0) {
      ok(`${code} → "${results[0].name}" (SKU: ${results[0].sku})`);
      found++;
    } else {
      fail(`${code} → nic nenalezeno  [očekáváno: ${expected}]`);
      notFound++;
    }
  }

  info(`Výsledek: ${found}/${lookupCodes.length} kódů úspěšně dohledáno`);
  return { found, total: lookupCodes.length };
}

// ── Test 4: Plný pipeline s objednacím kódem v názvu ─────────

async function testPipelineWithCodes() {
  section("TEST 4: searchPipelineForItem – pipeline s kódem v názvu");
  info("Simuluje chování agenta: název produktu obsahuje objednací kód");

  const scenarios = [
    {
      label: "Kód v názvu (formát SKU: ...)",
      name: "ABB PRAKTIK zás.1x konc. šedá (SKU: 5518-2929S)",
      unit: "ks",
      quantity: 10,
      expectedCode: "5518-2929S",
    },
    {
      label: "Jen objednací kód bez názvu",
      name: "5518-2929S",
      unit: "ks",
      quantity: 10,
      expectedCode: "5518-2929S",
    },
    {
      label: "ABB TANGO kryt s kódem",
      name: "ABB TANGO kryt sp.1x 3558A-A651B bílá",
      unit: "ks",
      quantity: 20,
      expectedCode: "3558A-A651B",
    },
    {
      label: "ABB TANGO rám 1x s kódem",
      name: "ABB TANGO rám.1x vodorov. 3901A-B10B bílá",
      unit: "ks",
      quantity: 20,
      expectedCode: "3901A-B10B",
    },
  ];

  const results: Array<{ label: string; ok: boolean; found: string }> = [];

  for (const s of scenarios) {
    sub(`Scénář: "${s.label}"`);
    info(`Vstup: "${s.name}" ${s.quantity} ${s.unit}`);

    const result = await searchPipelineV2ForItem(
      { name: s.name, unit: s.unit, quantity: s.quantity },
      0,
    );

    const foundCode = result.product?.manufacturer_code ?? result.product?.sku ?? null;
    const nameHasCode = result.product?.name?.includes(s.expectedCode.slice(0, 6)) ?? false;
    const isMatch = result.matchType === "match" || result.matchType === "exact";
    const isGood = isMatch && result.confidence >= 80;

    if (isGood) {
      ok(`Nalezen: "${result.product?.name}" (SKU: ${result.product?.sku})`);
      ok(`matchType: ${result.matchType}, confidence: ${result.confidence}%`);
    } else {
      fail(`matchType: ${result.matchType}, confidence: ${result.confidence}%`);
      if (result.product) info(`Nalezen: "${result.product.name}" (SKU: ${result.product.sku})`);
      else fail("Žádný produkt nenalezen");
    }
    info(`reasoning: ${result.reasoning?.slice(0, 120) ?? "—"}`);
    info(`exactLookupAttempted: ${result.exactLookupAttempted}, exactLookupFound: ${result.exactLookupFound}`);

    results.push({ label: s.label, ok: isGood, found: result.product?.name ?? "—" });
  }

  return results;
}

// ── Hlavní runner ─────────────────────────────────────────────

const IMAGE_PATH =
  "/Users/ondrejhanigovsky/.cursor/projects/Users-ondrejhanigovsky-Coding-KV-Offer-Manager/assets/image-a5669674-8b2f-4137-9efd-e2f4553a60e5.png";

async function main() {
  console.log("\n🔍 Test: Extrakce položek z obrázku + vyhledávání přes objednací kódy");
  console.log("   Obrázek: ABB TANGO ceník/objednávka s PLU, názvy, kódy, EAN, množství\n");

  const ocrText = await testOcr(IMAGE_PATH);

  if (ocrText) {
    await testCodeExtraction(ocrText);
  }

  const lookupResult = await testExactLookup();
  const pipelineResults = await testPipelineWithCodes();

  // ── Finální shrnutí ──
  section("SHRNUTÍ");

  console.log("\n  lookupProductsExact (přímý dotaz přes kód):");
  info(`${lookupResult.found}/${lookupResult.total} kódů nalezeno v DB`);

  console.log("\n  searchPipelineForItem (plný pipeline):");
  for (const r of pipelineResults) {
    if (r.ok) ok(`${r.label} → "${r.found}"`);
    else fail(`${r.label} → nenalezeno správně`);
  }

  const pipelineOk = pipelineResults.filter((r) => r.ok).length;
  console.log(`\n  Výsledek pipeline: ${pipelineOk}/${pipelineResults.length}`);

  // ── Identifikace problémů ──
  section("IDENTIFIKOVANÉ PROBLÉMY A DOPORUČENÍ");

  console.log(`
  1. OCR prompt (imageOcr.ts)
     Aktuální prompt: obecná extrakce textu
     Problém: není instrukce pro strukturované rozpoznání sloupce "Objednací č."
     → Doporučení: přidat instrukci zachovat tabulkovou strukturu a označit kódy

  2. Offer agent prompt (agent/index.ts)
     Pro Excel: "Sloupce jako CISLO, SKU, KÓD = kód produktu → použij v name formou (SKU: kód)"
     Pro obrázky: tato instrukce CHYBÍ!
     → Doporučení: přidat stejné pravidlo i pro obrázky s tabulkovým obsahem

  3. parse_items_from_text + process_items
     Nemají pole pro objednací kód (jen name, quantity, unit)
     → Možnost: přidat volitelné pole "orderCode" a použít ho v exactLookup

  4. extractProductCodes
     Příklady v promptu zahrnují "3558A-A651 B" — funguje pro ABB kódy?
     → Testuje Test 2
  `);
}

main().catch(console.error);
