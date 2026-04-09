/**
 * matcher-eval.ts
 * Vyhodnocení MATCHERu na základě KRITÉRIÍ, ne konkrétního SKU.
 * Pro každý test case definujeme: co agent hledá + pravidla co je "správná odpověď".
 * LLM (gpt-5.4) pak vyhodnotí zda vybraný produkt odpovídá kritériím.
 */

import "dotenv/config";
import { fileURLToPath } from "url";
import * as path from "path";
import OpenAI from "openai";
import { searchPipelineV2ForItem } from "../services/searchPipelineV2.js";
import { DEFAULT_PREFERENCES, type ParsedItem, type PipelineResult } from "../services/types.js";
import { getAdminClient } from "../services/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ── Test cases s kritérii ────────────────────────────────────

interface TestCase {
  demand: string;
  quantity: number;
  unit: string;
  criteria: string;   // přirozený jazyk: co musí vybraný produkt splňovat
  category: string;   // pro reporting
}

const TEST_CASES: TestCase[] = [
  // KABELY — průřez + typ
  {
    demand: "CXKH-R-J 5×1,5",
    quantity: 3310, unit: "m",
    criteria: "Kabel bezhalogenový (CXKH nebo CXKE), kulatý profil (R), s ochranným vodičem (J), 5 žil, průřez 1,5mm². Balení BUBEN nebo metráž.",
    category: "kabel",
  },
  {
    demand: "CXKH-R-J 3×2,5",
    quantity: 18962, unit: "m",
    criteria: "Kabel bezhalogenový (CXKH nebo CXKE), kulatý (R), s PE vodičem (J), 3 žíly, průřez 2,5mm². BUBEN nebo metráž.",
    category: "kabel",
  },
  {
    demand: "CYKY-J 5×4",
    quantity: 106, unit: "m",
    criteria: "Instalační kabel CYKY (NE CXKH, NE CXKE), s PE vodičem (J), 5 žil, průřez 4mm². KRUH 50m nebo větší, BUBEN, nebo metráž.",
    category: "kabel",
  },
  {
    demand: "CYKY-J 3×1,5",
    quantity: 386, unit: "m",
    criteria: "Instalační kabel CYKY, s PE vodičem (J), 3 žíly, průřez 1,5mm². KRUH nebo BUBEN nebo metráž.",
    category: "kabel",
  },

  // VODIČE — průřez + typ CY vs CYA
  {
    demand: "Vodič CYA50",
    quantity: 162, unit: "m",
    criteria: "Vodič CYA (lanovaný, H07V-K), průřez 50mm². Libovolná barva. NE CY (drátový). BUBEN nebo metráž.",
    category: "vodič",
  },
  {
    demand: "Vodič CY 6",
    quantity: 2072, unit: "m",
    criteria: "Vodič CY (drátový, H07V-U), průřez 6mm². Libovolná barva. NE CYA (lanovaný). BUBEN nebo metráž.",
    category: "vodič",
  },

  // JISTIČE — proud, póly, char, kA
  {
    demand: "jistič 1-pólový 16 A vypínací charakteristika B vypínací schopnost 6 kA",
    quantity: 10, unit: "ks",
    criteria: "Jistič (NE pojistka, NE vypínač), 1 pól, jmenovitý proud 16A, charakteristika B, vypínací schopnost 6kA.",
    category: "jistič",
  },
  {
    demand: "jistič 3-pólový 25 A vypínací charakteristika B vypínací schopnost 10 kA",
    quantity: 2, unit: "ks",
    criteria: "Jistič 3-pólový, proud 25A, charakteristika B, vypínací schopnost 10kA.",
    category: "jistič",
  },

  // KRABICE — montáž + hloubka
  {
    demand: "krabice pod omítku PVC přístrojová kruhová D 70mm hluboká",
    quantity: 92, unit: "ks",
    criteria: "Krabice přístrojová, PVC, pod omítku (NE do dutých stěn, NE na povrch), kruhová, průměr cca 68-70mm, HLUBOKÁ (NE mělká, NE standardní). KPR 68 je OK.",
    category: "krabice",
  },
  {
    demand: "krabice do dutých stěn PVC přístrojová kruhová D 70mm hluboká",
    quantity: 7, unit: "ks",
    criteria: "Krabice přístrojová do DUTÝCH STĚN (NE pod omítku), PVC, kruhová, průměr cca 68-70mm, hluboká.",
    category: "krabice",
  },

  // TRUBKY — průměr + typ + třída
  {
    demand: "Trubka ohebná 32mm 320N",
    quantity: 1, unit: "ks",
    criteria: "Trubka ohebná (NE tuhá, NE pevná), průměr 32mm, třída odolnosti 320N (NE 750N, NE 720N).",
    category: "trubka",
  },

  // ZÁSUVKY
  {
    demand: "zásuvka s víčkem 230V 16A IP44",
    quantity: 1, unit: "ks",
    criteria: "Zásuvka s víčkem (NE bez víčka), 230V, 16A, IP44 (NE IP20, NE IP54).",
    category: "zásuvka",
  },

  // SPÍNAČE
  {
    demand: "spínač nástěnný jednopólový, řazení 1, IP54, bezšroubové svorky",
    quantity: 1, unit: "ks",
    criteria: "Spínač jednopólový řazení 1, nástěnný, IP54 (NE IP20), bezšroubové svorky.",
    category: "spínač",
  },

  // ŽLABY
  {
    demand: "žlab neperforovaný 50x50",
    quantity: 1, unit: "ks",
    criteria: "Kabelový žlab NEPERFOROVANÝ (NE perforovaný, NE drátěný), rozměr 50×50mm.",
    category: "žlab",
  },

  // DATOVÉ KABELY
  {
    demand: "Datový kabel UTP CAT6 LSOH",
    quantity: 22620, unit: "m",
    criteria: "Datový kabel UTP (NE FTP, NE STP), kategorie CAT6 (NE CAT5e), plášť LSOH. BUBEN nebo metráž.",
    category: "datový kabel",
  },
];

// ── LLM evaluátor ────────────────────────────────────────────

async function evaluateResult(
  demand: string,
  criteria: string,
  selectedProduct: { sku: string; name: string } | null,
  topCandidates: Array<{ sku: string; name: string }>,
): Promise<{ verdict: "pass" | "fail" | "no_product"; confidence: string; reason: string }> {
  if (!selectedProduct) {
    return { verdict: "no_product", confidence: "n/a", reason: "Pipeline nevybrala žádný produkt." };
  }

  const prompt = `Jsi nezávislý hodnotitel kvality vyhledávání elektroinstalačních produktů.

Poptávka zákazníka: "${demand}"

Kritéria pro správný produkt:
${criteria}

Pipeline vybrala tento produkt:
SKU: ${selectedProduct.sku}
Název: ${selectedProduct.name}

Dalších 5 kandidátů (pro kontext):
${topCandidates.slice(0, 5).map((c) => `  ${c.sku}: ${c.name}`).join("\n")}

Otázka: Splňuje vybraný produkt (${selectedProduct.name}) VŠECHNA kritéria?

Vrať JSON:
{
  "verdict": "pass" nebo "fail",
  "confidence": "high" nebo "medium" nebo "low",
  "reason": "1-2 věty proč"
}`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
    });
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as {
      verdict?: string; confidence?: string; reason?: string;
    };
    return {
      verdict: (parsed.verdict === "pass" ? "pass" : "fail") as "pass" | "fail",
      confidence: parsed.confidence ?? "?",
      reason: parsed.reason ?? "",
    };
  } catch {
    return { verdict: "fail", confidence: "?", reason: "LLM evaluator error" };
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  MATCHER EVAL — Kritéria-based, ne SKU-based                ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const results: Array<{
    demand: string;
    category: string;
    verdict: "pass" | "fail" | "no_product";
    confidence: string;
    matchType: string;
    pipelineConfidence: number;
    selectedSku: string | null;
    selectedName: string | null;
    reason: string;
  }> = [];

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i]!;
    process.stdout.write(`[${i + 1}/${TEST_CASES.length}] ${tc.demand}... `);

    let pipelineResult: PipelineResult;
    try {
      pipelineResult = await searchPipelineV2ForItem(
        { name: tc.demand, quantity: tc.quantity, unit: tc.unit },
        0,
        undefined,
        DEFAULT_PREFERENCES,
      );
    } catch (e) {
      console.log("❌ pipeline error");
      results.push({
        demand: tc.demand, category: tc.category,
        verdict: "fail", confidence: "?", matchType: "error",
        pipelineConfidence: 0, selectedSku: null, selectedName: null,
        reason: `Pipeline error: ${e}`,
      });
      continue;
    }

    const selected = pipelineResult.product;
    const topCandidates = pipelineResult.candidates.map((c) => ({
      sku: c.sku ?? "", name: c.name ?? "",
    }));

    const evalResult = await evaluateResult(
      tc.demand,
      tc.criteria,
      selected ? { sku: selected.sku ?? "", name: selected.name ?? "" } : null,
      topCandidates,
    );

    const icon = evalResult.verdict === "pass" ? "✅" :
                 evalResult.verdict === "no_product" ? "⚪" : "❌";

    console.log(`${icon} ${pipelineResult.matchType}(${pipelineResult.confidence}%) → ${selected?.sku ?? "null"}`);

    results.push({
      demand: tc.demand,
      category: tc.category,
      verdict: evalResult.verdict,
      confidence: evalResult.confidence,
      matchType: pipelineResult.matchType,
      pipelineConfidence: pipelineResult.confidence,
      selectedSku: selected?.sku ?? null,
      selectedName: selected?.name ?? null,
      reason: evalResult.reason,
    });
  }

  // Summary
  const total = results.length;
  const pass = results.filter((r) => r.verdict === "pass").length;
  const fail = results.filter((r) => r.verdict === "fail").length;
  const noProduct = results.filter((r) => r.verdict === "no_product").length;

  console.log(`\n${"═".repeat(70)}`);
  console.log("VÝSLEDKY");
  console.log("═".repeat(70));
  console.log(`✅ PASS:       ${pass}/${total} (${Math.round(pass / total * 100)}%)`);
  console.log(`❌ FAIL:       ${fail}/${total} (${Math.round(fail / total * 100)}%)`);
  console.log(`⚪ No product: ${noProduct}/${total}`);

  // Per category
  const categories = [...new Set(results.map((r) => r.category))];
  console.log("\nPo kategoriích:");
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    const catPass = catResults.filter((r) => r.verdict === "pass").length;
    console.log(`  ${cat}: ${catPass}/${catResults.length} pass`);
  }

  // Detail failures
  const failures = results.filter((r) => r.verdict !== "pass");
  if (failures.length > 0) {
    console.log("\n❌ DETAILY SELHÁNÍ:");
    console.log("─".repeat(70));
    for (const f of failures) {
      console.log(`  ${f.demand}`);
      console.log(`  Vybrán: ${f.selectedSku ?? "null"} | ${f.selectedName ?? "nic"}`);
      console.log(`  matchType: ${f.matchType} | confidence: ${f.pipelineConfidence}%`);
      console.log(`  Hodnocení: ${f.verdict} (${f.confidence}) — ${f.reason}`);
      console.log();
    }
  }

  // Pass with details
  const passes = results.filter((r) => r.verdict === "pass");
  if (passes.length > 0) {
    console.log("\n✅ PASS DETAILY:");
    console.log("─".repeat(70));
    for (const p of passes) {
      console.log(`  ${p.demand} → ${p.selectedSku} (${p.confidence}): ${p.reason}`);
    }
  }
}

main().catch(console.error);
