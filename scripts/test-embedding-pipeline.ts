/**
 * Test the embedding pipeline on 5 sample products.
 *
 * Tests: description cleaning (GPT-4.1-mini) + embedding text composition + embedding generation.
 *
 * Usage: npx tsx scripts/test-embedding-pipeline.ts
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../.env") });

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIMENSIONS = 1536;

const TEST_SKUS = [
  "1649224", // Zásuvková skříň – long desc with marketing
  "1636438", // Výbojka HCI-TS – technical with specs
  "2033806", // Svítidlo ZUMA – marketing/design focused
  "1224460", // Hmoždinka – cross-selling text
  "1705662", // Jistič Siemens – clean technical desc
];

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

function buildEmbeddingText(p: Product): string {
  const lines: string[] = [p.name];

  if (p.name_secondary) {
    lines.push(p.name_secondary);
  }

  const mfrParts = [
    p.manufacturer ? `Výrobce: ${p.manufacturer}` : null,
    p.manufacturer_code ? `Kód: ${p.manufacturer_code}` : null,
  ].filter(Boolean);
  if (mfrParts.length > 0) lines.push(mfrParts.join(" | "));

  const cats = [p.category, p.subcategory, p.sub_subcategory].filter(Boolean);
  if (cats.length > 0) {
    lines.push(`Kategorie: ${cats.join(" > ")}`);
  }

  if (p.description) {
    lines.push(`Popis: ${p.description.slice(0, 500)}`);
  }

  return lines.join("\n");
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  // Step 1: Fetch 5 test products
  console.log("━".repeat(80));
  console.log("📦 FETCHING 5 TEST PRODUCTS");
  console.log("━".repeat(80));

  const { data: products, error } = await supabase
    .from("products")
    .select("id, sku, name, name_secondary, description, manufacturer_code, manufacturer, category, subcategory, sub_subcategory")
    .in("sku", TEST_SKUS);

  if (error || !products) {
    console.error("Failed to fetch products:", error?.message);
    return;
  }

  for (const p of products) {
    console.log(`\n  SKU: ${p.sku}`);
    console.log(`  Name: ${p.name}`);
    console.log(`  Manufacturer: ${p.manufacturer ?? "(none)"} | Code: ${p.manufacturer_code ?? "(none)"}`);
    console.log(`  Category: ${[p.category, p.subcategory, p.sub_subcategory].filter(Boolean).join(" > ")}`);
    console.log(`  Description (${p.description?.length ?? 0} chars): ${p.description?.slice(0, 150) ?? "(none)"}...`);
  }

  // Step 2: Clean descriptions via GPT-4.1-mini
  console.log("\n" + "━".repeat(80));
  console.log("🧹 CLEANING DESCRIPTIONS (GPT-4.1-mini)");
  console.log("━".repeat(80));

  const productsWithDesc = products.filter(
    (p) => p.description && p.description.length > 0,
  );

  const userMessage = JSON.stringify(
    productsWithDesc.map((p) => ({
      sku: p.sku,
      name: p.name,
      description: p.description!.slice(0, 2000),
    })),
  );

  const cleanStart = Date.now();
  const cleanResponse = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: CLEAN_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    temperature: 0.1,
    max_tokens: 4000,
  });
  const cleanMs = Date.now() - cleanStart;

  const cleanContent = cleanResponse.choices[0]?.message?.content;
  const cleanParsed = cleanContent ? JSON.parse(cleanContent) : { items: [] };
  const cleanedMap = new Map<string, string>();
  for (const item of cleanParsed.items ?? []) {
    cleanedMap.set(item.sku, item.description);
  }

  console.log(`\n  ⏱  Cleaning took: ${cleanMs}ms`);
  console.log(`  💰 Tokens: ${cleanResponse.usage?.prompt_tokens} in / ${cleanResponse.usage?.completion_tokens} out`);

  for (const p of productsWithDesc) {
    const original = p.description!;
    const cleaned = cleanedMap.get(p.sku) ?? "(cleaning failed)";
    const reduction = original.length > 0
      ? Math.round((1 - cleaned.length / original.length) * 100)
      : 0;

    console.log(`\n  ── SKU ${p.sku}: ${p.name} ──`);
    console.log(`  ORIGINAL (${original.length} chars):`);
    console.log(`    ${original.slice(0, 200)}${original.length > 200 ? "..." : ""}`);
    console.log(`  CLEANED (${cleaned.length} chars, -${reduction}%):`);
    console.log(`    ${cleaned}`);
  }

  // Step 3: Build embedding texts (using cleaned descriptions)
  console.log("\n" + "━".repeat(80));
  console.log("📝 BUILDING EMBEDDING TEXTS");
  console.log("━".repeat(80));

  const embeddingTexts: { sku: string; text: string }[] = [];

  for (const p of products) {
    const productWithCleanDesc = {
      ...p,
      description: cleanedMap.get(p.sku) ?? p.description,
    };
    const text = buildEmbeddingText(productWithCleanDesc as Product);
    embeddingTexts.push({ sku: p.sku, text });

    console.log(`\n  ── SKU ${p.sku} ──`);
    console.log(`  ${text.split("\n").join("\n  ")}`);
    console.log(`  (${text.length} chars)`);
  }

  // Step 4: Generate embeddings
  console.log("\n" + "━".repeat(80));
  console.log("🔢 GENERATING EMBEDDINGS (text-embedding-3-large, 1536d)");
  console.log("━".repeat(80));

  const embedStart = Date.now();
  const embedResponse = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    input: embeddingTexts.map((e) => e.text),
  });
  const embedMs = Date.now() - embedStart;

  console.log(`\n  ⏱  Embedding generation took: ${embedMs}ms`);
  console.log(`  💰 Tokens: ${embedResponse.usage.total_tokens}`);
  console.log(`  📊 Vectors: ${embedResponse.data.length} × ${EMBEDDING_DIMENSIONS} dimensions`);

  for (let i = 0; i < embeddingTexts.length; i++) {
    const vec = embedResponse.data[i].embedding;
    console.log(`  SKU ${embeddingTexts[i].sku}: [${vec.slice(0, 5).map((v) => v.toFixed(4)).join(", ")}, ...] (${vec.length}d)`);
  }

  // Step 5: Store embeddings in DB
  console.log("\n" + "━".repeat(80));
  console.log("💾 STORING EMBEDDINGS IN DB");
  console.log("━".repeat(80));

  let stored = 0;
  for (let i = 0; i < products.length; i++) {
    const embedding = embedResponse.data[i].embedding;
    const cleanedDesc = cleanedMap.get(products[i].sku);

    const updatePayload: Record<string, unknown> = {
      embedding: JSON.stringify(embedding),
    };

    if (cleanedDesc !== undefined) {
      updatePayload.description = cleanedDesc || null;
    }

    const { error: updateError } = await supabase
      .from("products")
      .update(updatePayload)
      .eq("id", products[i].id);

    if (updateError) {
      console.log(`  ❌ SKU ${products[i].sku}: ${updateError.message}`);
    } else {
      console.log(`  ✅ SKU ${products[i].sku}: embedding + cleaned description saved`);
      stored++;
    }
  }

  // Step 6: Verify with a test semantic search
  console.log("\n" + "━".repeat(80));
  console.log("🔍 TEST SEMANTIC SEARCH");
  console.log("━".repeat(80));

  const testQueries = [
    "třípólový výkonový jistič 40A pro strojní zařízení",
    "natloukací hmoždinka do betonu",
    "zásuvková skříň venkovní IP65 s chráničem",
  ];

  for (const query of testQueries) {
    console.log(`\n  Query: "${query}"`);

    const qEmbedStart = Date.now();
    const qEmbedResponse = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      input: query,
    });
    const queryEmbedding = qEmbedResponse.data[0].embedding;
    const qEmbedMs = Date.now() - qEmbedStart;

    const { data: results, error: searchError } = await supabase.rpc(
      "search_products_semantic",
      {
        query_embedding: JSON.stringify(queryEmbedding),
        max_results: 3,
        similarity_threshold: 0.2,
      },
    );

    if (searchError) {
      console.log(`  ❌ Search error: ${searchError.message}`);
      continue;
    }

    console.log(`  ⏱  Query embedding: ${qEmbedMs}ms`);

    if (!results || results.length === 0) {
      console.log("  (no results above threshold)");
      continue;
    }

    for (const r of results) {
      console.log(`  → ${r.sku} | ${r.name} | similarity: ${(r.cosine_similarity as number).toFixed(4)}`);
    }
  }

  // Summary
  console.log("\n" + "━".repeat(80));
  console.log("📊 SUMMARY");
  console.log("━".repeat(80));
  console.log(`  Products tested: ${products.length}`);
  console.log(`  Descriptions cleaned: ${cleanedMap.size}`);
  console.log(`  Embeddings stored: ${stored}`);
  console.log(`  Cleaning time: ${cleanMs}ms`);
  console.log(`  Embedding time: ${embedMs}ms`);
  console.log(`  Cleaning cost: ~$${((cleanResponse.usage?.prompt_tokens ?? 0) * 0.4 / 1_000_000 + (cleanResponse.usage?.completion_tokens ?? 0) * 1.6 / 1_000_000).toFixed(5)}`);
  console.log(`  Embedding cost: ~$${(embedResponse.usage.total_tokens * 0.13 / 1_000_000).toFixed(5)}`);
  console.log("━".repeat(80));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
