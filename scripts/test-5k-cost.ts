/**
 * Cost test: clean descriptions + generate embeddings for 5K products.
 *
 * Measures actual OpenAI token usage and calculates real cost.
 *
 * Usage: npx tsx scripts/test-5k-cost.ts
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../.env") });

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIMENSIONS = 1536;
const CLEAN_BATCH_SIZE = 20;
const EMBED_BATCH_SIZE = 100;
const DESC_CLEAN_THRESHOLD = 150;
const DESC_MAX_LENGTH = 500;

const PRICE_GPT_INPUT = 0.40;
const PRICE_GPT_OUTPUT = 1.60;
const PRICE_EMBED = 0.13;

const CLEAN_SYSTEM_PROMPT = `Vyčisti technické popisy produktů z elektrotechnického katalogu.

Pravidla:
- Zachovej POUZE: technické parametry, rozměry, funkce, kompatibilitu, materiál, normy
- Odstraň: marketing, popisy firem ("O společnosti..."), cross-selling ("V naší nabídce..."), doporučení, SEO text, obecné fráze
- Pokud popis neobsahuje žádné tech. info, vrať ""
- Max 500 znaků na popis
- Zachovej odborné termíny a čísla přesně

Příklady:

Vstup: "Mechanické blokování ABB VM4 je kvalitní příslušenství pro elektroinstalace. Umožňuje blokování vypínače, zabraňuje nechtěnému spuštění. Kompatibilní s ABB řady Tmax XT a Tmax T. Snadno montovatelné. Shrnutí a doporučení produktu... O společnosti ABB ABB je švédsko-švýcarská korporace..."
Výstup: "Mechanické blokování pro vypínače ABB řady Tmax XT a Tmax T. Zabraňuje nechtěnému spuštění. Snadno montovatelné a demontovatelné."

Vstup: "LED driver AC/DC transformátor. POZOR! Při záměně driverů může dojít k poškození svítidel. Součet příkonů napájených žárovek musí být min. o 20% menší než příkon driveru. Podívejte se na kompletní sortiment výrobků na našem e-shopu."
Výstup: "LED driver AC/DC. Při záměně driverů může dojít k poškození svítidel. Součet příkonů napájených žárovek musí být min. o 20% menší než příkon driveru."

Vrať JSON: {"items": [{"sku": "...", "description": "..."}]}`;

interface Product {
  id: string;
  sku: string;
  name: string;
  name_secondary: string | null;
  description: string | null;
  manufacturer_code: string | null;
  manufacturer: string | null;
  category: string | null;
  subcategory: string | null;
  sub_subcategory: string | null;
}

interface CostTracker {
  cleanInputTokens: number;
  cleanOutputTokens: number;
  cleanRequests: number;
  embedInputTokens: number;
  embedRequests: number;
}

function buildEmbeddingText(p: Product): string {
  const lines: string[] = [p.name];
  if (p.name_secondary) lines.push(p.name_secondary);

  const mfrParts = [
    p.manufacturer ? `Výrobce: ${p.manufacturer}` : null,
    p.manufacturer_code ? `Kód: ${p.manufacturer_code}` : null,
  ].filter(Boolean);
  if (mfrParts.length > 0) lines.push(mfrParts.join(" | "));

  const cats = [p.category, p.subcategory, p.sub_subcategory].filter(Boolean);
  if (cats.length > 0) lines.push(`Kategorie: ${cats.join(" > ")}`);

  if (p.description) lines.push(`Popis: ${p.description.slice(0, DESC_MAX_LENGTH)}`);

  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getOpenAICosts(): Promise<{ total: number; byModel: Record<string, number> } | null> {
  const now = Math.floor(Date.now() / 1000);
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const startTime = Math.floor(startOfMonth.getTime() / 1000);

  try {
    const res = await fetch(
      `https://api.openai.com/v1/organization/costs?start_time=${startTime}&end_time=${now}&group_by[]=line_item&limit=30`,
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } },
    );

    if (!res.ok) {
      console.log(`  OpenAI costs API returned ${res.status}: ${await res.text()}`);
      return null;
    }

    const json = await res.json();
    let total = 0;
    const byModel: Record<string, number> = {};

    for (const bucket of json.data ?? []) {
      for (const result of bucket.results ?? []) {
        const value = result.amount?.value ?? 0;
        total += value;
        const lineItem = result.line_item ?? "unknown";
        byModel[lineItem] = (byModel[lineItem] ?? 0) + value;
      }
    }

    return { total, byModel };
  } catch (err) {
    console.log(`  OpenAI costs API error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function main() {
  const TARGET = 5000;
  const costs: CostTracker = {
    cleanInputTokens: 0,
    cleanOutputTokens: 0,
    cleanRequests: 0,
    embedInputTokens: 0,
    embedRequests: 0,
  };

  console.log("━".repeat(80));
  console.log("💰 STEP 1: CHECK OPENAI COSTS BEFORE");
  console.log("━".repeat(80));

  const costsBefore = await getOpenAICosts();
  if (costsBefore) {
    console.log(`  Month-to-date total: $${costsBefore.total.toFixed(4)}`);
    for (const [model, cost] of Object.entries(costsBefore.byModel).sort((a, b) => b[1] - a[1])) {
      if (cost > 0.0001) console.log(`    ${model}: $${cost.toFixed(4)}`);
    }
  } else {
    console.log("  (costs API not available - will track via token counts)");
  }

  console.log("\n" + "━".repeat(80));
  console.log(`📦 STEP 2: FETCH ${TARGET} PRODUCTS WITHOUT EMBEDDINGS`);
  console.log("━".repeat(80));

  const allProducts: Product[] = [];
  let offset = 0;
  const PAGE = 1000;

  while (allProducts.length < TARGET) {
    const { data, error } = await supabase
      .from("products")
      .select("id, sku, name, name_secondary, description, manufacturer_code, manufacturer, category, subcategory, sub_subcategory")
      .is("embedding", null)
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(`DB fetch error: ${error.message}`);
    if (!data || data.length === 0) break;
    allProducts.push(...data);
    offset += PAGE;
  }

  const products = allProducts.slice(0, TARGET);
  const withDesc = products.filter((p) => p.description && p.description.length > 0);
  const needsCleaning = withDesc.filter((p) => p.description!.length > DESC_CLEAN_THRESHOLD);

  console.log(`  Fetched: ${products.length} products`);
  console.log(`  With description: ${withDesc.length} (${Math.round(withDesc.length / products.length * 100)}%)`);
  console.log(`  Need cleaning (>${DESC_CLEAN_THRESHOLD} chars): ${needsCleaning.length}`);
  console.log(`  Without description: ${products.length - withDesc.length}`);

  console.log("\n" + "━".repeat(80));
  console.log("🧹 STEP 3: CLEAN DESCRIPTIONS (GPT-4.1-mini)");
  console.log("━".repeat(80));

  const cleanedMap = new Map<string, string>();
  const cleanStart = Date.now();
  let cleanedCount = 0;

  for (const p of withDesc) {
    if (p.description!.length <= DESC_CLEAN_THRESHOLD) {
      cleanedMap.set(p.sku, p.description!);
    }
  }

  const batches = Math.ceil(needsCleaning.length / CLEAN_BATCH_SIZE);
  console.log(`  Batches to process: ${batches} (${CLEAN_BATCH_SIZE} items/batch)`);

  for (let i = 0; i < needsCleaning.length; i += CLEAN_BATCH_SIZE) {
    const batch = needsCleaning.slice(i, i + CLEAN_BATCH_SIZE);
    const batchNum = Math.floor(i / CLEAN_BATCH_SIZE) + 1;

    const userMessage = JSON.stringify(
      batch.map((p) => ({
        sku: p.sku,
        name: p.name,
        description: p.description!.slice(0, 2000),
      })),
    );

    const batchStart = Date.now();
    console.log(`  [${batchNum}/${batches}] calling GPT-4.1-mini (${userMessage.length} chars input)...`);

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: CLEAN_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: CLEAN_BATCH_SIZE * 200,
      });

      console.log(`  [${batchNum}/${batches}] done in ${Date.now() - batchStart}ms`);

      costs.cleanInputTokens += response.usage?.prompt_tokens ?? 0;
      costs.cleanOutputTokens += response.usage?.completion_tokens ?? 0;
      costs.cleanRequests++;

      const content = response.choices[0]?.message?.content;
      if (content) {
        const parsed = JSON.parse(content);
        for (const item of parsed.items ?? []) {
          if (item.sku && typeof item.description === "string") {
            cleanedMap.set(item.sku, item.description.slice(0, DESC_MAX_LENGTH));
            cleanedCount++;
          }
        }
      }

      for (const p of batch) {
        if (!cleanedMap.has(p.sku)) {
          cleanedMap.set(p.sku, p.description!.slice(0, DESC_MAX_LENGTH));
        }
      }
    } catch (err) {
      console.log(`  ⚠ Batch ${batchNum} error: ${err instanceof Error ? err.message : err}`);
      for (const p of batch) {
        cleanedMap.set(p.sku, p.description!.slice(0, DESC_MAX_LENGTH));
      }
    }

    if (batchNum % 5 === 0 || batchNum === batches || batchNum === 1) {
      console.log(`  [${batchNum}/${batches}] cleaned ${cleanedCount} descriptions | tokens: ${costs.cleanInputTokens} in, ${costs.cleanOutputTokens} out`);
    }

    if (i + CLEAN_BATCH_SIZE < needsCleaning.length) await sleep(200);
  }

  const cleanMs = Date.now() - cleanStart;
  console.log(`\n  Cleaning done in ${(cleanMs / 1000).toFixed(1)}s`);
  console.log(`  Descriptions cleaned: ${cleanedCount}`);
  console.log(`  Total tokens: ${costs.cleanInputTokens} input + ${costs.cleanOutputTokens} output`);

  console.log("\n" + "━".repeat(80));
  console.log("🔢 STEP 4: GENERATE EMBEDDINGS (text-embedding-3-large, 1536d)");
  console.log("━".repeat(80));

  const embedStart = Date.now();
  let embedded = 0;
  let storeErrors = 0;
  const embedBatches = Math.ceil(products.length / EMBED_BATCH_SIZE);

  for (let i = 0; i < products.length; i += EMBED_BATCH_SIZE) {
    const batch = products.slice(i, i + EMBED_BATCH_SIZE);
    const batchNum = Math.floor(i / EMBED_BATCH_SIZE) + 1;

    const texts = batch.map((p) => {
      const cleaned = { ...p, description: cleanedMap.get(p.sku) ?? p.description };
      return buildEmbeddingText(cleaned);
    });

    try {
      const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        input: texts,
      });

      costs.embedInputTokens += response.usage.total_tokens;
      costs.embedRequests++;

      for (let j = 0; j < batch.length; j++) {
        const embedding = response.data[j].embedding;
        const cleanedDesc = cleanedMap.get(batch[j].sku);

        const updatePayload: Record<string, unknown> = {
          embedding: JSON.stringify(embedding),
        };
        if (cleanedDesc !== undefined && cleanedDesc !== batch[j].description) {
          updatePayload.description = cleanedDesc || null;
        }

        const { error: updateError } = await supabase
          .from("products")
          .update(updatePayload)
          .eq("id", batch[j].id);

        if (updateError) {
          storeErrors++;
        } else {
          embedded++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠ Embed batch ${batchNum} error: ${msg}`);
      if (msg.includes("rate_limit")) {
        console.log("  Waiting 60s for rate limit...");
        await sleep(60_000);
        i -= EMBED_BATCH_SIZE;
        continue;
      }
    }

    if (batchNum % 10 === 0 || batchNum === embedBatches) {
      console.log(`  [${batchNum}/${embedBatches}] embedded ${embedded} products | tokens: ${costs.embedInputTokens}`);
    }

    if (i + EMBED_BATCH_SIZE < products.length) await sleep(300);
  }

  const embedMs = Date.now() - embedStart;
  console.log(`\n  Embedding done in ${(embedMs / 1000).toFixed(1)}s`);
  console.log(`  Products embedded: ${embedded}`);
  console.log(`  Store errors: ${storeErrors}`);
  console.log(`  Total tokens: ${costs.embedInputTokens}`);

  console.log("\n" + "━".repeat(80));
  console.log("💰 STEP 5: CHECK OPENAI COSTS AFTER");
  console.log("━".repeat(80));

  await sleep(5000);
  const costsAfter = await getOpenAICosts();
  if (costsAfter) {
    console.log(`  Month-to-date total: $${costsAfter.total.toFixed(4)}`);
    for (const [model, cost] of Object.entries(costsAfter.byModel).sort((a, b) => b[1] - a[1])) {
      if (cost > 0.0001) console.log(`    ${model}: $${cost.toFixed(4)}`);
    }
    if (costsBefore) {
      console.log(`\n  DIFFERENCE: $${(costsAfter.total - costsBefore.total).toFixed(4)}`);
    }
  }

  console.log("\n" + "━".repeat(80));
  console.log("📊 FINAL COST REPORT (calculated from token usage)");
  console.log("━".repeat(80));

  const cleanInputCost = (costs.cleanInputTokens / 1_000_000) * PRICE_GPT_INPUT;
  const cleanOutputCost = (costs.cleanOutputTokens / 1_000_000) * PRICE_GPT_OUTPUT;
  const embedCost = (costs.embedInputTokens / 1_000_000) * PRICE_EMBED;

  console.log(`\n  CLEANING (GPT-4.1-mini):`);
  console.log(`    API calls:     ${costs.cleanRequests}`);
  console.log(`    Input tokens:  ${costs.cleanInputTokens.toLocaleString()} → $${cleanInputCost.toFixed(4)}`);
  console.log(`    Output tokens: ${costs.cleanOutputTokens.toLocaleString()} → $${cleanOutputCost.toFixed(4)}`);
  console.log(`    Subtotal:      $${(cleanInputCost + cleanOutputCost).toFixed(4)}`);

  console.log(`\n  EMBEDDINGS (text-embedding-3-large):`);
  console.log(`    API calls:     ${costs.embedRequests}`);
  console.log(`    Input tokens:  ${costs.embedInputTokens.toLocaleString()} → $${embedCost.toFixed(4)}`);
  console.log(`    Subtotal:      $${embedCost.toFixed(4)}`);

  const totalCost = cleanInputCost + cleanOutputCost + embedCost;
  console.log(`\n  TOTAL FOR ${products.length} PRODUCTS:  $${totalCost.toFixed(4)}`);

  const totalProducts = 471_220;
  const extrapolated = (totalCost / products.length) * totalProducts;
  console.log(`\n  EXTRAPOLATION TO ${totalProducts.toLocaleString()} PRODUCTS:`);
  console.log(`    Estimated total: $${extrapolated.toFixed(2)}`);
  console.log(`    Per product:     $${(totalCost / products.length).toFixed(6)}`);
  console.log("━".repeat(80));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
