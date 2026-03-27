/**
 * Diagnostic test: proč agenti nenašli položku 1512509 (PREDRADNIK GREENLUX GXRE165)
 *
 * Spustit: cd backend && tsx src/scripts/test-search-1512509.ts
 *
 * Testuje každý krok pipeline pro vstup:
 *   "Constant Current LED Driver GREENLUX model GXRE165, Input 180-265V 50/60Hz, Output 90-120V 330mA, Max 44W"
 */

import { lookupProductsExact, searchProductsFulltext, searchProductsSemantic } from "../services/search.js";
import { generateQueryEmbedding } from "../services/embedding.js";
import { extractProductCodes } from "../services/searchPipeline.js";

const TARGET_SKU = "1512509";
const ORIGINAL_QUERY =
  "Constant Current LED Driver GREENLUX model GXRE165, Input 180-265V 50/60Hz, Output 90-120V 330mA, Max 44W";
const EXTRACTED_CODE = "GXRE165"; // model kód obsažený v popisu

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function ok(msg: string) {
  console.log(`  ✅ ${msg}`);
}
function fail(msg: string) {
  console.log(`  ❌ ${msg}`);
}
function info(msg: string) {
  console.log(`  ℹ️  ${msg}`);
}
function section(title: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`📋 ${title}`);
  console.log("─".repeat(60));
}

function foundTarget(results: Array<{ sku: string }>, label: string): boolean {
  const found = results.some((r) => r.sku === TARGET_SKU);
  if (found) {
    ok(`Produkt ${TARGET_SKU} NALEZEN přes ${label}`);
  } else {
    fail(`Produkt ${TARGET_SKU} NENALEZEN přes ${label}`);
  }
  return found;
}

// ────────────────────────────────────────────────────────────
// Testy
// ────────────────────────────────────────────────────────────

async function run() {
  console.log("🔍 Diagnostický test: položka 1512509 (PREDRADNIK GREENLUX GXRE165)");
  console.log(`   Vstup z poptávky: "${ORIGINAL_QUERY}"`);

  // ── Test 1: Exact lookup s plným popisem (jak to pipeline dělá) ──
  section("Test 1: lookupProductsExact s PLNÝM popisem (aktuální chování pipeline)");
  info(`Dotaz: "${ORIGINAL_QUERY}"`);
  const exactFull = await lookupProductsExact(ORIGINAL_QUERY, 10);
  info(`Výsledků: ${exactFull.length}`);
  const found1 = foundTarget(exactFull, "exact lookup (plný popis)");
  if (!found1) {
    console.log("\n  DIAGNÓZA: Funkce lookup_products_v2_exact hledá, zda identifier_value");
    console.log("  OBSAHUJE dotaz (identifier ILIKE '%dotaz%').");
    console.log("  Ale 'GXRE165' neobsahuje celý popis — musí to být naopak.");
    console.log("  → Pipeline exact lookup selže, produkt spadne pouze na fulltext/sémantiku.");
  }

  // ── Test 2: Exact lookup s extrahovaným kódem (jak by to mělo fungovat) ──
  section("Test 2: lookupProductsExact s EXTRAHOVANÝM KÓDEM 'GXRE165'");
  info(`Dotaz: "${EXTRACTED_CODE}"`);
  const exactCode = await lookupProductsExact(EXTRACTED_CODE, 10);
  info(`Výsledků: ${exactCode.length}`);
  const found2 = foundTarget(exactCode, "exact lookup (GXRE165)");
  if (found2) {
    const match = exactCode.find((r) => r.sku === TARGET_SKU)!;
    info(`match_type: ${(match as any).match_type}, matched_value: ${(match as any).matched_value}`);
    console.log("\n  ZÁVĚR: Pokud by pipeline extrahovala kód 'GXRE165' z popisu");
    console.log("  a použila ho pro exact lookup, produkt by byl nalezen okamžitě.");
  }

  // ── Test 3: Fulltext s plným popisem ──
  section("Test 3: searchProductsFulltext s PLNÝM popisem");
  info(`Dotaz: "${ORIGINAL_QUERY}"`);
  const ftFull = await searchProductsFulltext(ORIGINAL_QUERY, 30);
  info(`Výsledků: ${ftFull.length}`);
  const found3 = foundTarget(ftFull, "fulltext (plný popis)");
  if (found3) {
    const match = ftFull.find((r) => r.sku === TARGET_SKU)!;
    const rank = (match as any).rank;
    const sim = (match as any).similarity_score;
    const position = ftFull.findIndex((r) => r.sku === TARGET_SKU) + 1;
    info(`Pořadí: #${position}/${ftFull.length}, rank: ${rank}, similarity_score: ${sim}`);
    if (position > 5) {
      fail(`Nízké pořadí (#${position}) — bude daleko od top kandidátů pro MATCHER`);
    }
  }

  // ── Test 4: Fulltext s dotazem obsahujícím český termín ──
  section("Test 4: searchProductsFulltext s dotazem v ČESKÉ terminologii");
  const czechQuery = "předřadník GREENLUX GXRE165 LED driver konstantní proud 330mA 44W";
  info(`Dotaz: "${czechQuery}"`);
  const ftCzech = await searchProductsFulltext(czechQuery, 30);
  info(`Výsledků: ${ftCzech.length}`);
  const found4 = foundTarget(ftCzech, "fulltext (česky)");
  if (found4) {
    const match = ftCzech.find((r) => r.sku === TARGET_SKU)!;
    const rank = (match as any).rank;
    const sim = (match as any).similarity_score;
    const position = ftCzech.findIndex((r) => r.sku === TARGET_SKU) + 1;
    info(`Pořadí: #${position}/${ftCzech.length}, rank: ${rank}, similarity_score: ${sim}`);
  }

  // ── Test 5: Fulltext pouze s kódem GXRE165 ──
  section("Test 5: searchProductsFulltext jen s kódem 'GXRE165'");
  const ftCode = await searchProductsFulltext(EXTRACTED_CODE, 10);
  info(`Výsledků: ${ftCode.length}`);
  foundTarget(ftCode, "fulltext (GXRE165)");
  if (ftCode.length > 0) {
    info(`Top výsledek: ${ftCode[0].sku} — ${ftCode[0].name}`);
  }

  // ── Test 6: Sémantika s plným anglickým popisem ──
  section("Test 6: searchProductsSemantic s PLNÝM anglickým popisem (jak pipeline spustí)");
  info(`Dotaz: "${ORIGINAL_QUERY}"`);
  const embRaw = await generateQueryEmbedding(ORIGINAL_QUERY);
  const semRaw = await searchProductsSemantic(embRaw, 50, 0.35);
  info(`Výsledků nad prahem 0.35: ${semRaw.length}`);
  const found6 = foundTarget(semRaw, "semantic (plný anglický popis)");
  if (found6) {
    const match = semRaw.find((r) => r.sku === TARGET_SKU)!;
    const pos = semRaw.findIndex((r) => r.sku === TARGET_SKU) + 1;
    info(`Pořadí: #${pos}/50, cosine_similarity: ${match.cosine_similarity.toFixed(4)}`);
  } else {
    info(`Top 5 výsledků (co sémantika nabídla místo toho):`);
    semRaw.slice(0, 5).forEach((r, i) => {
      info(`  #${i + 1} [${r.sku}] ${r.name} (sim: ${r.cosine_similarity.toFixed(4)})`);
    });
  }

  // ── Test 7: Sémantika s reformulovaným dotazem ──
  section("Test 7: searchProductsSemantic s ČESKOU reformulací");
  const reformQuery = "PREDRADNIK GREENLUX GXRE165 LED driver konstantní proud 330mA 44W předřadník";
  info(`Dotaz: "${reformQuery}"`);
  const embRef = await generateQueryEmbedding(reformQuery);
  const semRef = await searchProductsSemantic(embRef, 50, 0.35);
  info(`Výsledků nad prahem 0.35: ${semRef.length}`);
  const found7 = foundTarget(semRef, "semantic (česká reformulace)");
  if (found7) {
    const match = semRef.find((r) => r.sku === TARGET_SKU)!;
    const pos = semRef.findIndex((r) => r.sku === TARGET_SKU) + 1;
    info(`Pořadí: #${pos}/50, cosine_similarity: ${match.cosine_similarity.toFixed(4)}`);
  } else {
    info(`Top 5 výsledků:`);
    semRef.slice(0, 5).forEach((r, i) => {
      info(`  #${i + 1} [${r.sku}] ${r.name} (sim: ${r.cosine_similarity.toFixed(4)})`);
    });
  }

  // ── Test 9 (nový): AI extrakce kódů ──
  section("Test 9: extractProductCodes — AI extrakce kódů z textu (nová funkce)");

  const extractionTests: Array<{ input: string; expectCodes: string[]; expectEmpty?: boolean }> = [
    {
      input: ORIGINAL_QUERY,
      expectCodes: ["GXRE165"],
    },
    {
      input: "jistič ABB S201-B16 1-pólový 16A charakteristika B",
      expectCodes: ["S201-B16"],
    },
    {
      input: "kabel CYKY-J 3x1,5 instalační 100m",
      expectCodes: [],
      expectEmpty: true,
    },
    {
      input: "Zásuvka Schneider Electric Sedna SDN3502121 bílá 2x230V",
      expectCodes: ["SDN3502121"],
    },
    {
      input: "chránič OEZ PFGM-16/2/003-B 16A 2P 30mA typ B",
      expectCodes: ["PFGM-16/2/003-B"],
    },
    {
      input: "svítidlo LED panel 60x60 40W 4000K IP44",
      expectCodes: [],
      expectEmpty: true,
    },
    {
      input: "proudový chránič 1+N 16A 30mA typ B 230V",
      expectCodes: [],
      expectEmpty: true,
    },
  ];

  let extractOk = 0;
  let extractFail = 0;
  for (const t of extractionTests) {
    const codes = await extractProductCodes(t.input);
    const codesStr = codes.length > 0 ? `[${codes.join(", ")}]` : "[]";
    if (t.expectEmpty) {
      if (codes.length === 0) {
        ok(`Prázdný výsledek správně pro: "${t.input.slice(0, 60)}"`);
        extractOk++;
      } else {
        fail(`Falešný pozitiv — extrahovalo ${codesStr} z: "${t.input.slice(0, 60)}"`);
        extractFail++;
      }
    } else {
      const allFound = t.expectCodes.every((c) => codes.includes(c));
      if (allFound) {
        ok(`Extrahovalo ${codesStr} z: "${t.input.slice(0, 60)}"`);
        extractOk++;
      } else {
        fail(`Čekalo ${JSON.stringify(t.expectCodes)}, dostalo ${codesStr} z: "${t.input.slice(0, 60)}"`);
        extractFail++;
      }
    }
  }
  info(`Výsledek: ${extractOk}/${extractionTests.length} správně`);

  // ── Test 10 (nový): End-to-end — extrahovej kód a použij pro lookup ──
  section("Test 10: End-to-end — extractProductCodes → lookupProductsExact (nový flow)");
  info(`Vstup: "${ORIGINAL_QUERY}"`);
  const e2eCodes = await extractProductCodes(ORIGINAL_QUERY);
  info(`AI extrahovala kódy: [${e2eCodes.join(", ")}]`);

  if (e2eCodes.length === 0) {
    fail("AI nevytáhla žádný kód → fix nefunguje");
  } else {
    let anyFound = false;
    for (const code of e2eCodes) {
      const results = await lookupProductsExact(code, 5);
      const target = results.find((r) => r.sku === TARGET_SKU);
      if (target) {
        ok(`Kód "${code}" → nalezen produkt ${TARGET_SKU} via ${(target as any).match_type}`);
        anyFound = true;
      } else {
        info(`Kód "${code}" → ${results.length} výsledků, produkt ${TARGET_SKU} nenalezen`);
        if (results.length > 0) {
          info(`  Top: ${results[0].sku} — ${results[0].name}`);
        }
      }
    }
    if (!anyFound) {
      fail(`Žádný z kódů [${e2eCodes.join(", ")}] nenalezl produkt ${TARGET_SKU}`);
    } else {
      console.log("\n  ✅ FIX FUNGUJE: AI extrahuje kód z popisu → exact lookup najde produkt spolehlivě.");
    }
  }

  // ── Test 8: Jaká je cosine similarity produktu 1512509 pro různé dotazy ──
  section("Test 8: Přímá cosine similarity produktu 1512509 pro různé dotazy (threshold 0.0)");
  const queries = [
    ORIGINAL_QUERY,
    EXTRACTED_CODE,
    reformQuery,
    "LED driver constant current 44W",
    "předřadník LED driver",
  ];
  for (const q of queries) {
    const emb = await generateQueryEmbedding(q);
    const results = await searchProductsSemantic(emb, 500, 0.0);
    const match = results.find((r) => r.sku === TARGET_SKU);
    if (match) {
      const pos = results.findIndex((r) => r.sku === TARGET_SKU) + 1;
      info(`"${q.slice(0, 50)}..." → sim: ${match.cosine_similarity.toFixed(4)}, pořadí: #${pos}/${results.length}`);
    } else {
      info(`"${q.slice(0, 50)}..." → produkt nenalezen ani s threshold 0.0`);
    }
  }

  // ── Shrnutí ──
  section("SHRNUTÍ DIAGNÓZY");
  console.log(`
  Produkt: ${TARGET_SKU} — PREDRADNIK GREENLUX GXRE165
  Vstup z poptávky: "${ORIGINAL_QUERY}"

  PŘÍČINY SELHÁNÍ:
  1. EXACT LOOKUP (kritický bug):
     - Pipeline volá lookupProductsExact(normalizedName) s CELÝM popisem
     - Funkce hledá: identifier_value ILIKE '%celý popis%' → NEMATCH
     - Správný identifikátor 'GXRE165' je kratší než dotaz → nikdy nenajde
     - FIX: extrahovat kódy z popisu (regex pro vzor [A-Z]{2,}[0-9]{2,}) před lookup
       NEBO přidat do funkce reverzní check: query ILIKE '%' || identifier_value || '%'

  2. FULLTEXT SEARCH:
     - Katalogový název: "PREDRADNIK" (česky) vs dotaz: "LED Driver" (anglicky)
     - Fulltext tokenizace nenajde shodu v klíčových slovech
     - GXRE165 se v dotazu vyskytuje → pomáhá, ale skóre je nízké

  3. SÉMANTICKÉ VYHLEDÁVÁNÍ:
     - Embedding "Constant Current LED Driver" ≠ embedding "PREDRADNIK"
     - Produkt pravděpodobně nespadne do top výsledků sémantického vektoru

  DOPORUČENÝ FIX:
  V searchPipelineForItem() extrahovat alfanumerické kódy výrobce z normalizedName
  a pro každý kód spustit lookupProductsExact → merge do poolu před MATCHER.
  `);
}

run().catch(console.error);
