/**
 * Set Assembly Prototype Test
 *
 * Testuje celý flow end-to-end:
 *   1. Planning Agent (rozšířený) — detekuje isSet pro každou položku
 *   2. Decomposition Agent (gpt-5-mini + web_search_preview) — rozloží sadu na komponenty
 *   3. searchPipelineForItem — pro každou komponentu paralelně (existující pipeline)
 *
 * Také porovnává decomp S web searchem vs. BEZ (domain knowledge only fallback).
 *
 * Usage: npx tsx scripts/test-set-assembly.ts
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import OpenAI from "openai";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

import {
  searchPipelineForItem,
  type SearchPreferences,
  type PipelineResult,
} from "../backend/src/services/searchPipeline.js";
import { lookupProductsExact } from "../backend/src/services/search.js";

// ── Config ──────────────────────────────────────────────────────────────────

const PIPELINE_MODEL = "gpt-5-mini";

function openai(): OpenAI {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
}

const TEST_PREFERENCES: SearchPreferences = {
  offerType: "realizace",
  stockFilter: "any",
  branchFilter: null,
  priceStrategy: "standard",
};

// ── Test Input ───────────────────────────────────────────────────────────────

const TEST_ITEMS = [
  { name: "vypínač č.6 Schneider Sedna bílý", quantity: 3, unit: "ks" },
  { name: "rámeček 3-násobný ABB Tango bílý", quantity: 1, unit: "ks" },
  { name: "jistič B16 1P ABB", quantity: 5, unit: "ks" },
  { name: "kabel CYKY 3x2,5 100m", quantity: 2, unit: "ks" },
  { name: "zásuvka 230V Schneider Sedna bílá", quantity: 4, unit: "ks" },
];

// ── Types ────────────────────────────────────────────────────────────────────

interface EnrichedItem {
  index: number;
  name: string;
  unit: string | null;
  quantity: number | null;
  instruction: string | null;
  isSet: boolean;
  setHint: string | null;
  suggestedManufacturer: string | null;
  suggestedLine: string | null;
}

interface SetComponent {
  name: string;
  role: "mechanism" | "cover" | "frame" | "module" | "socket" | "other";
  quantity: number;
  manufacturerCode?: string | null;  // výrobcovo katalogové číslo (source_idnlf_raw v DB)
  ean?: string | null;               // EAN pokud web search vrátí
  note?: string;
}

interface SetResult {
  originalItem: (typeof TEST_ITEMS)[0];
  components: SetComponent[];
  pipelineResults: Array<PipelineResult & { exactHit: boolean; lookupCode?: string }>;
  totalPrice: number | null;
  decompositionMs: number;
  webSearchUsed: boolean;
}

interface NormalResult {
  originalItem: (typeof TEST_ITEMS)[0];
  pipelineResult: PipelineResult;
}

// ── Step 1: Planning Agent (s isSet detekcí) ─────────────────────────────────

const PLANNING_WITH_SET_PROMPT = `Jsi plánovací agent pro B2B elektroinstalační katalog KV Elektro.

## Tvůj úkol
Analyzuj seznam položek z poptávky. Pro každou položku urči:
1. Zda jde o CELOU SADU (isSet: true) nebo jednu komponentu / jiný produkt (isSet: false)
2. Pokud je to sada, vytvoř setHint pro web search
3. Navrhni výrobce a řadu (pokud lze odvodit)
4. Přidej instrukci pro vyhledávací pipeline

## Detekce sad (isSet)

SADA = produkt, který se v B2B katalozích prodává jako VÍCE SAMOSTATNÝCH POLOŽEK:
- **vypínač** (č.1, č.6, č.7...) → isSet: true (přístroj/strojek + kryt + rámeček jsou zvlášť)
- **zásuvka 230V** (ne IP44 průmyslová) → isSet: true (přístroj + kryt + rámeček jsou zvlášť)
- **datová zásuvka** (RJ45, CAT5/6) → isSet: true (modul + kryt + rámeček jsou zvlášť)
- **spínač s dálkovým ovládáním** → isSet: true
- **termostat podlahový/pokojový** → isSet: true

NENÍ SADA (isSet: false):
- **rámeček** (1-násobný, 2-násobný...) → jen komponenta
- **strojek / přístroj / mechanismus** → jen komponenta
- **kryt spínače / zásuvky** → jen komponenta
- **jistič, chránič, stykač** → modulový přístroj, ne sada
- **kabel, vodič** → jen kabel
- **svítidlo, LED** → samostatný produkt
- **zásuvka IP44 / IP54 / IP65** → průmyslová, prodává se jako celek

## setHint — pro web search
Krátký anglický nebo český dotaz pro web search agenta:
- Příklad: "Schneider Sedna vypínač č.6 bílý komponenty jak složit"
- Příklad: "ABB Tango socket 230V components frame mechanism cover"

## Formát odpovědi
Vrať VÝHRADNĚ JSON:
{
  "enrichedItems": [
    {
      "index": 0,
      "isSet": true,
      "setHint": "Schneider Sedna light switch type 6 components white",
      "suggestedManufacturer": "Schneider Electric",
      "suggestedLine": "Sedna",
      "instruction": "Hledej přístroj/strojek pro spínač Schneider Sedna"
    }
  ]
}

### Pravidla
- Každá položka musí mít záznam v enrichedItems (i s isSet: false)
- instruction = null pokud není co dodat
- setHint = null pokud isSet: false`;

async function detectSets(items: typeof TEST_ITEMS): Promise<EnrichedItem[]> {
  const payload = items.map((item, i) => ({ index: i, name: item.name, unit: item.unit, quantity: item.quantity }));

  const params = {
    model: PIPELINE_MODEL,
    reasoning_effort: "minimal" as const,
    max_completion_tokens: 4000,
    response_format: { type: "json_object" as const },
    messages: [
      { role: "system" as const, content: PLANNING_WITH_SET_PROMPT },
      { role: "user" as const, content: JSON.stringify(payload) },
    ],
  };

  const res = await openai().chat.completions.create(
    params as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
  );

  const content = res.choices[0]?.message?.content;
  if (!content) throw new Error("Planning agent vrátil prázdnou odpověď");

  const parsed = JSON.parse(content) as { enrichedItems: EnrichedItem[] };
  return parsed.enrichedItems.map((e) => ({
    ...e,
    name: items[e.index]?.name ?? "",
    unit: items[e.index]?.unit ?? null,
    quantity: items[e.index]?.quantity ?? null,
  }));
}

// ── Step 2a: Decomposition Agent (s web searchem) ────────────────────────────

const DECOMP_SYSTEM_PROMPT = `Jsi expert na domovní elektroinstalační materiál (spínače, zásuvky, rámečky).

## Tvůj úkol
Rozlož elektroinstalační produkt (spínač, zásuvka apod.) na KOMPONENTY, které se prodávají ZVLÁŠŤ v B2B katalozích.

## Doménové znalosti
Domovní elektroinstalační systémy (Schneider, ABB, Legrand, Gira, Berker...) se skládají z:
1. **Přístroj/strojek** (mechanism) — funkční část (spínací mechanismus, zásuvkový přístroj, datový modul)
2. **Kryt/čelní deska** (cover) — dekorativní část zakrývající přístroj (u některých výrobců součást rámečku)
3. **Rámeček** (frame) — rámeček pro upevnění a estetiku (1-násobný, 2-násobný...)

## KRITICKÉ — hledej katalogová čísla výrobce
Použij web search pro nalezení PŘESNÝCH katalogových čísel výrobce (ne SAP/interní čísla KV).
Příklady katalogových čísel:
- Schneider Sedna: SDN1500260, SDD111107L, SDD211107
- ABB Tango: 2CLA060070A1301, 2CLA863000A1301, 3901A-B31B
- Legrand Mosaic: 067601, 067801, 080251

Tato čísla se vyhledávají v databázi B2B distributorů. Vrať je do pole "manufacturerCode".
Pokud najdeš EAN, vrať ho do "ean".

## Formát odpovědi
Vrať VÝHRADNĚ JSON:
{
  "components": [
    {
      "name": "strojek spínače č.6 Schneider Sedna bílý",
      "role": "mechanism",
      "quantity": 1,
      "manufacturerCode": "SDN1500221",
      "ean": "8690495052961",
      "note": "spínač schodišťový polar/bílý"
    },
    {
      "name": "kryt spínače Schneider Sedna bílý",
      "role": "cover",
      "quantity": 1,
      "manufacturerCode": "SDN5200121",
      "ean": null
    },
    {
      "name": "rámeček 1-násobný Schneider Sedna bílý",
      "role": "frame",
      "quantity": 1,
      "manufacturerCode": "SDN5800121",
      "ean": null
    }
  ]
}

Pokud katalogové číslo nemůžeš spolehlivě zjistit z web searche, nastav manufacturerCode: null — NEVYMÝŠLEJ čísla.`;

async function decomposeSetWithWebSearch(hint: string): Promise<{ components: SetComponent[]; webText: string }> {
  const response = await openai().responses.create({
    model: PIPELINE_MODEL,
    reasoning: { effort: "low" },
    tools: [{ type: "web_search_preview" }],
    instructions: DECOMP_SYSTEM_PROMPT,
    input: `Rozlož na komponenty: "${hint}"\n\nVrať VÝHRADNĚ JSON s polem "components".`,
  } as unknown as Parameters<typeof openai.prototype.responses.create>[0]);

  const text = response.output_text ?? "";

  // Extrahuj JSON z textu (může obsahovat prose + JSON)
  const jsonMatch = text.match(/\{[\s\S]*"components"[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn("    ⚠ Web search decomp: nenalezen JSON v odpovědi, použiju fallback");
    return { components: [], webText: text };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { components: SetComponent[] };
    return { components: parsed.components ?? [], webText: text };
  } catch {
    return { components: [], webText: text };
  }
}

// ── Step 2b: Decomposition Agent (BEZ web searche — domain knowledge only) ──

async function decomposeSetWithoutWebSearch(itemName: string, hint: string): Promise<SetComponent[]> {
  const params = {
    model: PIPELINE_MODEL,
    reasoning_effort: "minimal" as const,
    max_completion_tokens: 2000,
    response_format: { type: "json_object" as const },
    messages: [
      { role: "system" as const, content: DECOMP_SYSTEM_PROMPT },
      {
        role: "user" as const,
        content: `Rozlož na komponenty (BEZ web searche, použij jen doménové znalosti): "${itemName}"\nHint: "${hint}"\n\nVrať JSON s polem "components".`,
      },
    ],
  };

  const res = await openai().chat.completions.create(
    params as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
  );
  const content = res.choices[0]?.message?.content;
  if (!content) return [];

  try {
    const parsed = JSON.parse(content) as { components: SetComponent[] };
    return parsed.components ?? [];
  } catch {
    return [];
  }
}

// ── Step 3: Pipeline pro komponenty (exact lookup first) ─────────────────────

/**
 * Pro každou komponentu:
 *   1. Pokud má manufacturerCode/EAN → zkus exact lookup → pokud hit, skoč na výsledek
 *   2. Jinak standard searchPipelineForItem (semantic/fulltext)
 */
async function runPipelineForComponents(
  components: SetComponent[],
  manufacturer: string | null,
  line: string | null,
  basePosition: number,
): Promise<Array<PipelineResult & { exactHit: boolean; lookupCode?: string }>> {
  return Promise.all(
    components.map(async (comp, i) => {
      const lookupCode = comp.manufacturerCode ?? comp.ean ?? null;

      // Exact lookup přes výrobcovo katalogové číslo
      if (lookupCode) {
        try {
          const exactResults = await lookupProductsExact(lookupCode, 3);
          if (exactResults.length > 0) {
            const hit = exactResults[0]!;
            return {
              position: basePosition + i,
              originalName: comp.name,
              unit: "ks",
              quantity: comp.quantity,
              matchType: "match" as const,
              confidence: 100,
              product: hit as unknown as PipelineResult["product"],
              candidates: exactResults.slice(1) as unknown as PipelineResult["candidates"],
              reasoning: `Přímý exact lookup přes katalogové číslo výrobce: ${lookupCode}`,
              priceNote: null,
              reformulatedQuery: lookupCode,
              pipelineMs: 0,
              exactLookupAttempted: true,
              exactLookupFound: true,
              exactHit: true,
              lookupCode,
            };
          }
        } catch {
          // exact lookup selhal, fallback na pipeline
        }
      }

      // Fallback: standard pipeline
      const result = await searchPipelineForItem(
        {
          name: comp.name,
          unit: "ks",
          quantity: comp.quantity,
          // Přidáme katalogové číslo do instruction jako hint
          instruction: lookupCode
            ? `Hledej produkt s katalog. číslem výrobce: ${lookupCode}`
            : null,
        },
        basePosition + i,
        undefined,
        TEST_PREFERENCES,
        { preferredManufacturer: manufacturer, preferredLine: line },
      );

      return { ...result, exactHit: false, lookupCode: lookupCode ?? undefined };
    }),
  );
}

// ── Formatting ───────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  mechanism: "Strojek/přístroj",
  cover: "Kryt",
  frame: "Rámeček",
  module: "Modul",
  socket: "Zásuvkový přístroj",
  other: "Ostatní",
};

function matchIcon(matchType: string): string {
  switch (matchType) {
    case "match": return "✅";
    case "uncertain": return "🟡";
    case "multiple": return "🔵";
    case "alternative": return "🟠";
    default: return "❌";
  }
}

function formatPrice(p: number | undefined | null): string {
  if (p == null) return "–";
  return `${p.toFixed(2)} Kč`;
}

function printSetResult(item: typeof TEST_ITEMS[0], setResult: SetResult) {
  console.log(`\n  📦 [SADA] ${item.name} (×${item.quantity})`);
  console.log(`     Decomposition: ${setResult.decompositionMs}ms | Web search: ${setResult.webSearchUsed ? "ANO" : "NE"}`);
  console.log(`     Komponenty (${setResult.components.length}):`);

  setResult.components.forEach((comp, i) => {
    const res = setResult.pipelineResults[i] as (PipelineResult & { exactHit?: boolean; lookupCode?: string }) | undefined;
    if (!res) return;
    const icon = matchIcon(res.matchType);
    const role = ROLE_LABELS[comp.role] ?? comp.role;
    const sku = res.product?.sku ?? "–";
    const name = res.product?.name ?? "nenalezeno";
    const price = formatPrice(res.product?.list_price);
    const method = res.exactHit ? "🎯 EXACT" : "🔍 semantic";
    const codeLabel = comp.manufacturerCode ? `katčíslo: ${comp.manufacturerCode}` : comp.ean ? `EAN: ${comp.ean}` : "bez kódu";
    console.log(`     ${icon} [${role}] ${comp.name} (${codeLabel})`);
    console.log(`        ${method} → ${name} | SAP SKU: ${sku} | ${price} | conf: ${res.confidence}%`);
  });

  if (setResult.totalPrice != null) {
    console.log(`     💰 Celková cena sady: ${formatPrice(setResult.totalPrice)} × ${item.quantity} = ${formatPrice(setResult.totalPrice * item.quantity)}`);
  } else {
    console.log(`     💰 Cena: nelze spočítat (některé komponenty nenalezeny)`);
  }
}

function printNormalResult(item: typeof TEST_ITEMS[0], result: NormalResult) {
  const r = result.pipelineResult;
  const icon = matchIcon(r.matchType);
  const sku = r.product?.sku ?? "–";
  const name = r.product?.name ?? "nenalezeno";
  const price = formatPrice(r.product?.list_price);
  console.log(`\n  ${icon} ${item.name}`);
  console.log(`     → ${name} | SKU: ${sku} | ${price} | conf: ${r.confidence}%`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔═════════════════════════════════════════════════════════════╗");
  console.log("║          Set Assembly Prototype Test                        ║");
  console.log("╚═════════════════════════════════════════════════════════════╝");
  console.log("\nInput:");
  TEST_ITEMS.forEach((i, idx) => console.log(`  ${idx + 1}. ${i.name} (${i.quantity}× ${i.unit})`));

  // ── KROK 1: Planning Agent ──
  console.log("\n━━━ KROK 1: Planning Agent — isSet detekce ━━━");
  const t0 = Date.now();
  const enriched = await detectSets(TEST_ITEMS);
  console.log(`Planning: ${Date.now() - t0}ms`);

  enriched.forEach((e) => {
    const badge = e.isSet ? "🔲 SADA" : "📦 item";
    console.log(`  ${badge} [${e.index}] ${e.name} → výrobce: ${e.suggestedManufacturer ?? "?"} / řada: ${e.suggestedLine ?? "?"}`);
    if (e.isSet) console.log(`        setHint: "${e.setHint}"`);
  });

  const setSummary = { sets: enriched.filter((e) => e.isSet).length, items: enriched.filter((e) => !e.isSet).length };
  console.log(`\nCelkem: ${setSummary.sets} sad, ${setSummary.items} normálních položek`);

  // ── KROK 2 + 3: Decomposition + Pipeline ──
  console.log("\n━━━ KROK 2+3: Decomposition + Pipeline pro každou položku ━━━");

  const normalResults: NormalResult[] = [];
  const setResults: SetResult[] = [];
  let positionCounter = 0;

  // Zpracuj všechny položky
  const tasks = enriched.map(async (e) => {
    const item = TEST_ITEMS[e.index]!;

    if (!e.isSet) {
      // Normální pipeline
      const result = await searchPipelineForItem(
        { name: item.name, unit: item.unit, quantity: item.quantity, instruction: e.instruction },
        positionCounter++,
        undefined,
        TEST_PREFERENCES,
        e.suggestedManufacturer || e.suggestedLine
          ? { preferredManufacturer: e.suggestedManufacturer ?? null, preferredLine: e.suggestedLine ?? null }
          : undefined,
      );
      normalResults[e.index] = { originalItem: item, pipelineResult: result };
    } else {
      // Set: decompose + pipeline
      const hint = e.setHint ?? item.name;
      const tDecomp = Date.now();

      // Web search decomposition
      const { components: webComponents, webText } = await decomposeSetWithWebSearch(hint);
      const decompositionMs = Date.now() - tDecomp;

      const finalComponents = webComponents.length > 0 ? webComponents : [];

      let pipelineResults: PipelineResult[] = [];
      if (finalComponents.length > 0) {
        const basePos = positionCounter;
        positionCounter += finalComponents.length;
        pipelineResults = await runPipelineForComponents(
          finalComponents,
          e.suggestedManufacturer ?? null,
          e.suggestedLine ?? null,
          basePos,
        );
      }

      // Celková cena
      const prices = pipelineResults.map((r) => r.product?.list_price).filter((p): p is number => p != null);
      const totalPrice = prices.length === pipelineResults.length && prices.length > 0
        ? prices.reduce((a, b) => a + b, 0)
        : null;

      setResults[e.index] = {
        originalItem: item,
        components: finalComponents,
        pipelineResults,
        totalPrice,
        decompositionMs,
        webSearchUsed: true,
      };

      // Web search text pro výpis
      if (webText) {
        console.log(`\n  🌐 Web search výsledek pro "${hint}":`);
        console.log(`     ${webText.slice(0, 300).replace(/\n/g, "\n     ")}...`);
      }
    }
  });

  // Pozor: positionCounter není thread-safe v Promise.all — zpracujeme sekvenčně
  for (const task of tasks) {
    await task;
  }

  // ── Výsledky ──
  console.log("\n━━━ VÝSLEDKY ━━━");
  enriched.forEach((e) => {
    const item = TEST_ITEMS[e.index]!;
    if (e.isSet) {
      const sr = setResults[e.index];
      if (sr) printSetResult(item, sr);
    } else {
      const nr = normalResults[e.index];
      if (nr) printNormalResult(item, nr);
    }
  });

  // ── KROK 3: Srovnání s web search vs. bez ──
  console.log("\n━━━ KROK 3: Srovnání web search vs. domain knowledge only ━━━");
  const setItems = enriched.filter((e) => e.isSet);

  for (const e of setItems) {
    const item = TEST_ITEMS[e.index]!;
    const hint = e.setHint ?? item.name;
    console.log(`\n  Produkt: "${item.name}"`);

    // Domain knowledge only
    const t1 = Date.now();
    const domainComponents = await decomposeSetWithoutWebSearch(item.name, hint);
    const domainMs = Date.now() - t1;

    console.log(`\n  📚 Domain knowledge only (${domainMs}ms):`);
    domainComponents.forEach((c) => {
      const role = ROLE_LABELS[c.role] ?? c.role;
      console.log(`     [${role}] ${c.name}`);
    });

    const webResult = setResults[e.index];
    console.log(`\n  🌐 Web search (${webResult?.decompositionMs ?? 0}ms):`);
    webResult?.components.forEach((c) => {
      const role = ROLE_LABELS[c.role] ?? c.role;
      console.log(`     [${role}] ${c.name}`);
    });

    // Srovnání počtu komponent
    const domainCount = domainComponents.length;
    const webCount = webResult?.components.length ?? 0;
    console.log(`\n  Počet komponent: domain=${domainCount}, web=${webCount}`);
  }

  // ── Souhrn ──
  console.log("\n━━━ SOUHRN ━━━");
  const setDetected = enriched.filter((e) => e.isSet).length;
  const setWithAllFound = setResults
    .filter(Boolean)
    .filter((sr) => sr && sr.pipelineResults.every((r) => r.matchType !== "not_found")).length;
  const normalFound = normalResults
    .filter(Boolean)
    .filter((nr) => nr && nr.pipelineResult.matchType !== "not_found").length;
  const normalTotal = normalResults.filter(Boolean).length;

  console.log(`  Sady detekovány: ${setDetected}/${TEST_ITEMS.length}`);
  console.log(`  Sady plně nalezeny (všechny komponenty): ${setWithAllFound}/${setDetected}`);
  console.log(`  Normální položky nalezeny: ${normalFound}/${normalTotal}`);
}

main().catch(console.error);
