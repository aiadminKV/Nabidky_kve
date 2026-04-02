/**
 * Audit skript: kde přesně selhává pipeline?
 *
 * Pro každou položku klasifikuje selhání jako:
 *   retrieval_miss  — správný produkt se nedostane do candidates
 *   matcher_miss    — je v candidates, ale MATCHER ho vyřadí
 *   selector_wrong  — je v MATCHER shortlistu, ale SELECTOR vybere jiný
 *   ok              — správný produkt vybrán
 *   not_in_catalog  — SAP kód nenalezen v DB (katalogová mezera)
 *
 * Spuštění:
 *   cd backend && npx tsx src/scripts/audit-selector.ts 2>&1 | tee audit-results.txt
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { getAdminClient } from "../services/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { searchPipelineForItem, type PipelineDebugFn } from "../services/searchPipeline.js";

// ── Config ──────────────────────────────────────────────────

const CSV_PATH = path.resolve(__dirname, "../../../docs/general/evaluace-master-final.csv");
const CONCURRENCY = 5;
const SAMPLE_SIZE = 50; // kolik položek auditovat (null = vše)
const PREFS = { offerType: "realizace" as const, stockFilter: "any" as const, branchFilter: null, priceStrategy: "standard" as const };

// ── Types ───────────────────────────────────────────────────

interface CsvRow {
  name: string;
  quantity: number | null;
  unit: string | null;
  expectedSku: string;
}

type FailureType = "ok" | "ok_equivalent" | "retrieval_miss" | "matcher_miss" | "selector_wrong" | "not_in_catalog" | "error";

interface AuditResult {
  name: string;
  quantity: number | null;
  unit: string | null;
  expectedSku: string;
  failure: FailureType;
  selectedSku: string | null;
  matchType: string;
  confidence: number;
  reasoning: string;
  equivalenceReason: string;
  // Debug stages
  inCandidates: boolean;
  candidateRank: number | null;        // pozice v CELÉM merged listu (0-based, z debug allSkus)
  inMatcherShortlist: boolean;
  matcherShortlistRank: number | null; // pozice v MATCHER shortlistu (0-based)
  matcherShortlistSize: number;
  matcherTopSku: string | null;
  matcherTopScore: number | null;
  selectedVsExpectedMatchScore: number | null;
  selectorReasoning: string;
}

// ── CSV Parser ───────────────────────────────────────────────

function parseCsv(filePath: string): CsvRow[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").slice(1); // skip header
  return lines
    .map((line) => {
      const parts = line.trim().split(";");
      if (parts.length < 4 || !parts[0] || !parts[3]) return null;
      return {
        name: parts[0].trim(),
        quantity: parts[1] ? parseFloat(parts[1].replace(",", ".")) || null : null,
        unit: parts[2]?.trim() || null,
        expectedSku: parts[3].trim(),
      };
    })
    .filter((r): r is CsvRow => r !== null);
}

// ── Check if SKU exists in DB ────────────────────────────────

async function skuExistsInDb(sku: string): Promise<boolean> {
  const supabase = getAdminClient();
  const { data } = await supabase
    .from("products_v2")
    .select("sku")
    .eq("sku", sku)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function getProductName(sku: string): Promise<string | null> {
  const supabase = getAdminClient();
  const { data } = await supabase
    .from("products_v2")
    .select("name")
    .eq("sku", sku)
    .limit(1);
  return (data?.[0] as { name?: string } | undefined)?.name ?? null;
}

// ── LLM ekvivalence ─────────────────────────────────────────
/**
 * Zkontroluje, zda je vybraný produkt technicky ekvivalentní k očekávanému.
 * "Ekvivalentní" = stejný typ, stejný průřez/parametry, logika balení sedí na počet.
 * Nezohledňuje barvu, dodavatele ani cenu — jen technika + obal.
 */
async function isEquivalent(
  demand: { name: string; quantity: number | null; unit: string | null },
  selectedName: string,
  expectedName: string,
): Promise<{ equivalent: boolean; reason: string }> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const prompt = `Jsi expert na elektroinstalační produkty. Porovnej dva produkty a urči, zda jsou pro danou poptávku technicky ekvivalentní.

Poptávka: "${demand.name}", množství: ${demand.quantity ?? "?"} ${demand.unit ?? ""}
Vybraný produkt:  "${selectedName}"
Očekávaný produkt: "${expectedName}"

Pravidla pro ekvivalenci:
- Stejný typ kabelu/vodiče (CYKY-J = CYKY-J, CXKH-R-J = CXKH-R-J, CYA = CYA)
- Stejný průřez (5×4 = 5×4, 3×2,5 = 3×2,5, 95mm² = 95mm²)
- Počet žil se musí shodovat
- Pro kabely s množstvím: balení musí dávat smysl (BUBEN pro neDělitelná množství, KRUH pro dělitelná)
- Barva/RAL/dodavatel: IGNORUJ — to není technická ekvivalence
- Typ balení (BUBEN vs BUBEN NEVRATNÝ vs BUBEN DR.800): pokud poptávka nespecifikuje, libovolné BUBEN je OK

Vrať POUZE JSON: {"equivalent": true/false, "reason": "1 věta proč"}`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
    });
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as { equivalent?: boolean; reason?: string };
    return { equivalent: parsed.equivalent ?? false, reason: parsed.reason ?? "" };
  } catch {
    return { equivalent: false, reason: "LLM error" };
  }
}

// ── Run single audit item ────────────────────────────────────

async function auditItem(row: CsvRow, skuExists: boolean): Promise<AuditResult> {
  const base: AuditResult = {
    name: row.name,
    quantity: row.quantity,
    unit: row.unit,
    expectedSku: row.expectedSku,
    failure: "error",
    selectedSku: null,
    matchType: "not_found",
    confidence: 0,
    reasoning: "",
    equivalenceReason: "",
    inCandidates: false,
    candidateRank: null,
    inMatcherShortlist: false,
    matcherShortlistRank: null,
    matcherShortlistSize: 0,
    matcherTopSku: null,
    matcherTopScore: null,
    selectedVsExpectedMatchScore: null,
    selectorReasoning: "",
  };

  if (!skuExists) {
    return { ...base, failure: "not_in_catalog" };
  }

  // Capture debug events
  let mergedAllSkus: string[] = [];           // všechny SKU po merge (celých 60+)
  let matcherShortlist: Array<{ sku: string; matchScore: number }> = [];

  const onDebug: PipelineDebugFn = (entry) => {
    if (entry.step === "merge") {
      const d = entry.data as { allSkus?: string[] };
      if (d.allSkus) mergedAllSkus = d.allSkus;
    }
    if (entry.step === "matcher") {
      const d = entry.data as {
        shortlistSize?: number;
        topMatch?: { sku: string; matchScore: number } | null;
      };
      if (d.topMatch) matcherShortlist = [d.topMatch];
    }
  };

  try {
    const result = await searchPipelineForItem(
      { name: row.name, unit: row.unit, quantity: row.quantity },
      0,
      onDebug,
      PREFS,
    );

    base.selectedSku = result.product?.sku ?? null;
    base.matchType = result.matchType;
    base.confidence = result.confidence;
    base.reasoning = result.reasoning;
    base.selectorReasoning = result.reasoning;

    // Kde je expected SKU v celém merged listu (60+ kandátů)?
    const mergedRank = mergedAllSkus.indexOf(row.expectedSku);
    base.inCandidates = mergedRank !== -1;
    base.candidateRank = mergedRank !== -1 ? mergedRank : null;

    // Matcher shortlist info from debug
    base.matcherShortlistSize = matcherShortlist.length;
    base.matcherTopSku = matcherShortlist[0]?.sku ?? null;
    base.matcherTopScore = matcherShortlist[0]?.matchScore ?? null;
    const slRank = matcherShortlist.findIndex((s) => s.sku === row.expectedSku);
    base.inMatcherShortlist = slRank !== -1;
    base.matcherShortlistRank = slRank !== -1 ? slRank : null;
    base.selectedVsExpectedMatchScore = matcherShortlist.find((s) => s.sku === row.expectedSku)?.matchScore ?? null;

    // Classify failure — teď máme správné informace
    if (result.product?.sku === row.expectedSku) {
      base.failure = "ok";
    } else if (base.inMatcherShortlist && result.product?.sku !== row.expectedSku) {
      base.failure = "selector_wrong";
    } else if (base.inCandidates && !base.inMatcherShortlist) {
      base.failure = "matcher_miss";    // retrieval ok, MATCHER ho vyřadil
    } else {
      base.failure = "retrieval_miss";  // není ani v merged candidates
    }

    // LLM ekvivalence: pokud pipeline vybrala JINÝ produkt, ověř zda je technicky OK
    if (base.failure !== "ok" && base.failure !== "not_in_catalog" && result.product?.sku) {
      const [selectedName, expectedName] = await Promise.all([
        getProductName(result.product.sku),
        getProductName(row.expectedSku),
      ]);
      if (selectedName && expectedName) {
        const equiv = await isEquivalent(
          { name: row.name, quantity: row.quantity, unit: row.unit },
          selectedName,
          expectedName,
        );
        base.equivalenceReason = equiv.reason;
        if (equiv.equivalent) {
          base.failure = "ok_equivalent"; // technicky správně, jen jiný kód
        }
      }
    }

    return base;
  } catch (err) {
    return { ...base, failure: "error", reasoning: String(err) };
  }
}

// ── Parallel runner ──────────────────────────────────────────

async function runParallel<T, R>(
  items: T[],
  fn: (item: T, idx: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("=== Pipeline Audit: Kde selhává? ===\n");

  const allRows = parseCsv(CSV_PATH);
  console.log(`Načteno: ${allRows.length} položek z CSV`);

  // Deduplicate and sample
  const seen = new Set<string>();
  const unique = allRows.filter((r) => {
    const key = `${r.name}|${r.expectedSku}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const sample = SAMPLE_SIZE ? unique.slice(0, SAMPLE_SIZE) : unique;
  console.log(`Auditujeme: ${sample.length} unikátních položek (concurrency: ${CONCURRENCY})\n`);

  // Check which SKUs exist in DB
  console.log("Ověřuji SKU v DB...");
  const skuExistsMap = new Map<string, boolean>();
  const uniqueSkus = [...new Set(sample.map((r) => r.expectedSku))];
  await runParallel(uniqueSkus, async (sku) => {
    const exists = await skuExistsInDb(sku);
    skuExistsMap.set(sku, exists);
  }, 10);

  const notInCatalog = uniqueSkus.filter((s) => !skuExistsMap.get(s));
  console.log(`  SKU v DB: ${uniqueSkus.length - notInCatalog.length}/${uniqueSkus.length}`);
  if (notInCatalog.length > 0) {
    console.log(`  Chybí v katalogu: ${notInCatalog.join(", ")}`);
  }
  console.log();

  // Run audit
  let done = 0;
  const results = await runParallel(sample, async (row, idx) => {
    const skuExists = skuExistsMap.get(row.expectedSku) ?? false;
    const result = await auditItem(row, skuExists);
    done++;
    const icon = result.failure === "ok" ? "✅" : result.failure === "ok_equivalent" ? "🟢" : result.failure === "not_in_catalog" ? "🔵" : result.failure === "retrieval_miss" ? "🔴" : result.failure === "matcher_miss" ? "🟡" : result.failure === "selector_wrong" ? "🟠" : "⚠️";
    console.log(`[${done}/${sample.length}] ${icon} ${result.failure.padEnd(16)} | ${row.name.substring(0, 50)}`);
    return result;
  }, CONCURRENCY);

  // ── Summary ────────────────────────────────────────────────

  const counts = {
    ok: 0,
    ok_equivalent: 0,
    retrieval_miss: 0,
    matcher_miss: 0,
    selector_wrong: 0,
    not_in_catalog: 0,
    error: 0,
  };
  for (const r of results) counts[r.failure]++;

  const auditableTotal = results.filter((r) => r.failure !== "not_in_catalog" && r.failure !== "error").length;
  const okTotal = counts.ok + counts.ok_equivalent;

  console.log("\n" + "═".repeat(70));
  console.log("VÝSLEDKY AUDITU");
  console.log("═".repeat(70));
  console.log(`✅  OK (přesný kód):           ${counts.ok} / ${auditableTotal} (${pct(counts.ok, auditableTotal)})`);
  console.log(`🟢  OK (technicky ekvivalentní): ${counts.ok_equivalent} / ${auditableTotal} (${pct(counts.ok_equivalent, auditableTotal)})`);
  console.log(`    ─── CELKEM správně:         ${okTotal} / ${auditableTotal} (${pct(okTotal, auditableTotal)})`);
  console.log(`🔴  Retrieval miss:            ${counts.retrieval_miss} (${pct(counts.retrieval_miss, auditableTotal)})`);
  console.log(`🟡  Matcher miss:              ${counts.matcher_miss} (${pct(counts.matcher_miss, auditableTotal)})`);
  console.log(`🟠  Selector wrong:            ${counts.selector_wrong} (${pct(counts.selector_wrong, auditableTotal)})`);
  console.log(`🔵  Není v katalogu:           ${counts.not_in_catalog}`);
  console.log(`⚠️   Error:                    ${counts.error}`);
  console.log("═".repeat(70));

  // ── Detail: OK equivalent ─────────────────────────────────

  const okEquiv = results.filter((r) => r.failure === "ok_equivalent");
  if (okEquiv.length > 0) {
    console.log(`\n🟢 OK EKVIVALENTNÍ — pipeline vybrala jiný, ale technicky správný produkt (${okEquiv.length}):`);
    console.log("─".repeat(70));
    for (const r of okEquiv) {
      console.log(`  ${r.name} (${r.quantity}${r.unit ?? ""})`);
      console.log(`  Vybrán: ${r.selectedSku}  |  Expected: ${r.expectedSku}`);
      console.log(`  Důvod: ${r.equivalenceReason}`);
      console.log();
    }
  }

  // ── Detail: Selector wrong ─────────────────────────────────

  const selectorWrong = results.filter((r) => r.failure === "selector_wrong");
  if (selectorWrong.length > 0) {
    console.log(`\n🟠 SELECTOR WRONG — detail (${selectorWrong.length} položek):`);
    console.log("─".repeat(70));
    for (const r of selectorWrong) {
      console.log(`  Poptávka:     ${r.name}`);
      console.log(`  Expected SKU: ${r.expectedSku} (matchScore v shortlistu: ${r.selectedVsExpectedMatchScore ?? "?"}, rank: ${r.matcherShortlistRank ?? "?"})`);
      console.log(`  Selected SKU: ${r.selectedSku} (matchType: ${r.matchType}, conf: ${r.confidence}%)`);
      console.log(`  SELECTOR reasoning: ${r.selectorReasoning}`);
      console.log();
    }
  }

  // ── Detail: Matcher miss ───────────────────────────────────

  const matcherMiss = results.filter((r) => r.failure === "matcher_miss");
  if (matcherMiss.length > 0) {
    console.log(`\n🟡 MATCHER MISS — detail (${matcherMiss.length} položek):`);
    console.log("─".repeat(70));
    for (const r of matcherMiss) {
      console.log(`  Poptávka:     ${r.name}`);
      console.log(`  Expected SKU: ${r.expectedSku} (rank v merged: #${r.candidateRank ?? "?"})`);
      console.log(`  MATCHER top:  ${r.matcherTopSku} (matchScore: ${r.matcherTopScore})`);
      console.log(`  Shortlist size: ${r.matcherShortlistSize}`);
      console.log();
    }
  }

  // ── Detail: Retrieval miss ─────────────────────────────────

  const retrievalMiss = results.filter((r) => r.failure === "retrieval_miss");
  if (retrievalMiss.length > 0) {
    console.log(`\n🔴 RETRIEVAL MISS — seznam (${retrievalMiss.length} položek):`);
    console.log("─".repeat(70));
    for (const r of retrievalMiss) {
      console.log(`  ${r.name} → expected: ${r.expectedSku}`);
    }
  }

  console.log("\nAudit hotov.");
}

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

main().catch(console.error);
