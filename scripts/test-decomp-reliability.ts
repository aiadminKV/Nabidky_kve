/**
 * Decomposition Agent — Hallucination Check
 *
 * Testuje spolehlivost web search agenta při zjišťování katalogových čísel výrobce.
 * Pro každou sadu: web search → kódy → exact lookup v DB → % ověřených kódů.
 *
 * Usage: npx tsx scripts/test-decomp-reliability.ts
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import OpenAI from "openai";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

import { lookupProductsExact } from "../backend/src/services/search.js";

function openai() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
}

// ── Test sady ────────────────────────────────────────────────────────────────

const TEST_SETS = [
  // Schneider Sedna
  { name: "vypínač č.1 Schneider Sedna bílý", hint: "Schneider Sedna single pole switch type 1 white mechanism cover frame catalog numbers" },
  { name: "zásuvka 230V Schneider Sedna bílá", hint: "Schneider Sedna socket outlet 230V white components mechanism frame catalog numbers" },
  // ABB Tango
  { name: "vypínač č.1 ABB Tango bílý", hint: "ABB Tango light switch type 1 white components mechanism cover frame catalog numbers" },
  { name: "zásuvka ABB Tango bílá", hint: "ABB Tango socket outlet white components mechanism cover frame catalog numbers" },
  // Legrand Mosaic
  { name: "vypínač č.1 Legrand Mosaic bílý", hint: "Legrand Mosaic single switch white mechanism cover frame catalog numbers order codes" },
  // Gira System 55
  { name: "vypínač č.1 Gira System 55 bílý", hint: "Gira System 55 switch 1-pole white mechanism cover frame catalog numbers" },
];

// ── Decomposition Prompt ─────────────────────────────────────────────────────

const DECOMP_SYSTEM_PROMPT = `Jsi expert na domovní elektroinstalační materiál.

## Úkol
Rozlož produkt na komponenty prodávané ZVLÁŠŤ v B2B katalozích výrobce.
Pro každou komponentu zjisti pomocí web searche PŘESNÉ katalogové číslo výrobce.

## Kritické pravidlo
- manufacturerCode = katalogové číslo výrobce (IDNLF, objednací číslo)
- Příklady správných formátů: SDN0100121, 2CLA060070A1301, 067601, 501605
- Pokud si NEJSI JISTÝ zdrojem → nastav manufacturerCode: null. NIKDY nevymýšlej.
- EAN je 8 nebo 13-místné číslo, je-li dostupné, vyplň

## Formát odpovědi — VÝHRADNĚ JSON
{
  "components": [
    {
      "name": "popis komponenty",
      "role": "mechanism|cover|frame|other",
      "quantity": 1,
      "manufacturerCode": "CODE_OR_NULL",
      "ean": "EAN_OR_NULL",
      "sourceConfidence": "high|medium|low"
    }
  ]
}

sourceConfidence: high = přesný zdroj z webu výrobce/distributora, medium = pravděpodobné, low = odhad`;

interface ComponentResult {
  name: string;
  role: string;
  manufacturerCode: string | null;
  ean: string | null;
  sourceConfidence: string;
  exactHit: boolean;
  foundProduct?: string;
}

interface SetTestResult {
  setName: string;
  components: ComponentResult[];
  decompMs: number;
  totalCodes: number;
  verifiedCodes: number;
  hallucinations: number;
}

async function decomposeWithWebSearch(setName: string, hint: string): Promise<{ components: Array<{ name: string; role: string; quantity: number; manufacturerCode: string | null; ean: string | null; sourceConfidence: string }>; ms: number }> {
  const t0 = Date.now();

  const client = openai();
  const response = await (client as unknown as { responses: { create: (p: unknown) => Promise<{ output: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> }> } }).responses.create({
    model: "gpt-5-mini",
    reasoning: { effort: "low" },
    tools: [{ type: "web_search_preview" }],
    input: [
      { role: "system", content: DECOMP_SYSTEM_PROMPT },
      { role: "user", content: `Produkt: "${setName}"\nWeb search hint: "${hint}"\n\nNajdi komponenty a jejich katalogová čísla výrobce.` },
    ],
  });

  const ms = Date.now() - t0;

  // Extrahuj text z odpovědi
  let text = "";
  for (const block of response.output) {
    if (block.type === "message" && block.content) {
      for (const c of block.content) {
        if (c.type === "output_text" && c.text) text += c.text;
      }
    }
  }

  // Extrahuj JSON
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { components: [], ms };

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { components: Array<{ name: string; role: string; quantity: number; manufacturerCode: string | null; ean: string | null; sourceConfidence: string }> };
    return { components: parsed.components ?? [], ms };
  } catch {
    return { components: [], ms };
  }
}

async function verifyComponent(comp: { name: string; role: string; quantity: number; manufacturerCode: string | null; ean: string | null; sourceConfidence: string }): Promise<ComponentResult> {
  const lookupCode = comp.manufacturerCode ?? comp.ean ?? null;

  let exactHit = false;
  let foundProduct: string | undefined;

  if (lookupCode) {
    try {
      const results = await lookupProductsExact(lookupCode, 1);
      if (results.length > 0) {
        exactHit = true;
        foundProduct = `${results[0]!.name} (SKU: ${results[0]!.sku})`;
      }
    } catch {
      // lookup failed
    }
  }

  return {
    name: comp.name,
    role: comp.role,
    manufacturerCode: comp.manufacturerCode,
    ean: comp.ean,
    sourceConfidence: comp.sourceConfidence,
    exactHit,
    foundProduct,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║     Decomposition Agent — Hallucination Check         ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  const results: SetTestResult[] = [];

  for (const testSet of TEST_SETS) {
    console.log(`\n🔍 Testuju: "${testSet.name}"`);

    const { components: rawComps, ms } = await decomposeWithWebSearch(testSet.name, testSet.hint);
    console.log(`   Decomp: ${ms}ms, ${rawComps.length} komponent`);

    const verified = await Promise.all(rawComps.map((c) => verifyComponent(c)));

    const totalCodes = verified.filter((c) => c.manufacturerCode !== null || c.ean !== null).length;
    const verifiedCodes = verified.filter((c) => c.exactHit).length;
    const hallucinations = totalCodes - verifiedCodes;

    for (const c of verified) {
      const codeStr = c.manufacturerCode ?? c.ean ?? "–";
      const confIcon = c.sourceConfidence === "high" ? "🟢" : c.sourceConfidence === "medium" ? "🟡" : "🔴";
      const hitIcon = c.exactHit ? "✅" : codeStr === "–" ? "⬜" : "❌";
      console.log(`   ${hitIcon} [${c.role}] ${c.name}`);
      console.log(`      kód: ${codeStr} ${confIcon}(${c.sourceConfidence ?? "?"}) → ${c.foundProduct ?? (codeStr === "–" ? "žádný kód" : "NENALEZENO V DB")}`);
    }

    console.log(`   📊 Kódů s pokusem: ${totalCodes} | Ověřeno v DB: ${verifiedCodes} | Halucinace: ${hallucinations}`);

    results.push({ setName: testSet.name, components: verified, decompMs: ms, totalCodes, verifiedCodes, hallucinations });
  }

  // Souhrnná tabulka
  console.log("\n\n━━━ SOUHRNNÁ STATISTIKA ━━━\n");
  console.log("Produkt".padEnd(45) + "Kódů  Ověřeno  Halucinace  Úspěšnost");
  console.log("─".repeat(85));

  let totalCodes = 0, totalVerified = 0, totalHall = 0;
  for (const r of results) {
    const pct = r.totalCodes > 0 ? Math.round((r.verifiedCodes / r.totalCodes) * 100) : 0;
    const hallIcon = r.hallucinations > 0 ? "⚠️ " : "✅ ";
    console.log(
      r.setName.padEnd(45) +
      String(r.totalCodes).padEnd(6) +
      String(r.verifiedCodes).padEnd(9) +
      hallIcon + String(r.hallucinations).padEnd(10) +
      `${pct}%`
    );
    totalCodes += r.totalCodes;
    totalVerified += r.verifiedCodes;
    totalHall += r.hallucinations;
  }
  console.log("─".repeat(85));
  const totalPct = totalCodes > 0 ? Math.round((totalVerified / totalCodes) * 100) : 0;
  console.log(`${"CELKEM".padEnd(45)}${String(totalCodes).padEnd(6)}${String(totalVerified).padEnd(9)}${String(totalHall).padEnd(12)}${totalPct}%`);
  console.log(`\n Halucinace = kód vrácen, ale nenalezen v DB (chybný nebo neexistující produkt)`);
  console.log(` Bez kódu   = agent správně neuvedl kód (sourceConfidence low)`);
}

main().catch(console.error);
