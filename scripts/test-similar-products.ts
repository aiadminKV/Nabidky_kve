/**
 * Test semantic search on clusters of SIMILAR products.
 *
 * Tests: Can semantic search find alternatives and similar products?
 * Includes products WITH and WITHOUT descriptions.
 *
 * Usage: npx tsx scripts/test-similar-products.ts
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
const CLEAN_MODEL = "gpt-4.1-mini";
const DESC_MAX_LENGTH = 500;

const TEST_SKUS = [
  // Cluster 1: Circuit breakers 3P 160A (different manufacturers)
  "1311273",    // JISTIC EB2 250/3E 160A 3P – ETI, NO description
  "1322497",    // JISTIC 3POL IN=160A NZMN2-M160 – EATON, HAS description (376 chars)
  "1322480",    // JISTIC 3POL IN=160A NZMC2-S160 – EATON, short desc (77 chars)
  "1322473",    // JISTIC 3POL IN=160A NZMC2-A160 – EATON, short desc (71 chars)

  // Cluster 2: Cables CYKY 3x2,5 (variants)
  "1257420003", // KABEL CYKY-J 3x2,5, KRUH 50M – HAS description (1268 chars)
  "1216685",    // KABEL CYKYZ 3CX2,5 – NO description
  "1257454002", // KABEL CYKYLO-J 3x2,5, KRUH 100M – NO description
  "1210679",    // KABEL CYKY 3Ax2,5 (CYKY-O 3X2,5) – HAS description (782 chars)

  // Cluster 3: LED panels (different sizes, manufacturers)
  "1511691",    // LED PANEL SN6 6W 120x120MM – NO description
  "1725098",    // LED PANEL PL PFM 600 30W – LEDVANCE, HAS description (1136 chars)
  "2058494",    // LED PANEL C 625 34W – SLV, NO description
  "1790864",    // VT-12031 29W LED PANEL 1200x300MM – NO description

  // Keep the 5 products from previous test for reference
  "1705662",    // JISTIC 3VA1040 (already embedded)
  "1224460",    // HMOZDINKA (already embedded, unrelated product)
];

const CLEAN_SYSTEM_PROMPT = `Vyčisti technické popisy produktů z elektrotechnického katalogu.

Pravidla:
- Zachovej POUZE: technické parametry, rozměry, funkce, kompatibilitu, materiál, normy
- Odstraň: marketing, popisy firem ("O společnosti..."), cross-selling ("V naší nabídce..."), doporučení, SEO text, obecné fráze
- Pokud popis neobsahuje žádné tech. info, vrať ""
- Max 500 znaků na popis
- Zachovej odborné termíny a čísla přesně

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

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  // Step 1: Fetch products
  console.log("━".repeat(80));
  console.log("📦 FETCHING TEST PRODUCTS (3 clusters × ~4 products)");
  console.log("━".repeat(80));

  const { data: products, error } = await supabase
    .from("products")
    .select("id, sku, name, name_secondary, description, manufacturer_code, manufacturer, category, subcategory, sub_subcategory")
    .in("sku", TEST_SKUS);

  if (error || !products) {
    console.error("Failed:", error?.message);
    return;
  }

  const clusterLabels: Record<string, string> = {
    "1311273": "CB", "1322497": "CB", "1322480": "CB", "1322473": "CB",
    "1257420003": "CABLE", "1216685": "CABLE", "1257454002": "CABLE", "1210679": "CABLE",
    "1511691": "LED", "1725098": "LED", "2058494": "LED", "1790864": "LED",
    "1705662": "CB-prev", "1224460": "OTHER",
  };

  for (const p of products) {
    const cluster = clusterLabels[p.sku] || "?";
    const hasDesc = p.description && p.description.length > 0;
    console.log(`  [${cluster.padEnd(7)}] ${p.sku} | ${p.name.slice(0, 45).padEnd(45)} | desc: ${hasDesc ? `${p.description!.length} chars` : "NONE"}`);
  }

  // Step 2: Clean descriptions
  console.log("\n" + "━".repeat(80));
  console.log("🧹 CLEANING DESCRIPTIONS");
  console.log("━".repeat(80));

  const withDesc = products.filter(
    (p) => p.description && p.description.length > 150,
  );

  if (withDesc.length > 0) {
    const userMessage = JSON.stringify(
      withDesc.map((p) => ({
        sku: p.sku,
        name: p.name,
        description: p.description!.slice(0, 2000),
      })),
    );

    const cleanResponse = await openai.chat.completions.create({
      model: CLEAN_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CLEAN_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      temperature: 0.1,
      max_tokens: 4000,
    });

    const cleanContent = cleanResponse.choices[0]?.message?.content;
    if (cleanContent) {
      const parsed = JSON.parse(cleanContent);
      for (const item of parsed.items ?? []) {
        const product = products.find((p) => p.sku === item.sku);
        if (product && typeof item.description === "string") {
          const before = product.description?.length ?? 0;
          product.description = item.description.slice(0, DESC_MAX_LENGTH) || null;
          const after = product.description?.length ?? 0;
          console.log(`  ${item.sku}: ${before} → ${after} chars (-${Math.round((1 - after / before) * 100)}%)`);
        }
      }
    }

    console.log(`  💰 Tokens: ${cleanResponse.usage?.prompt_tokens} in / ${cleanResponse.usage?.completion_tokens} out`);
  }

  // Step 3: Build embedding texts
  console.log("\n" + "━".repeat(80));
  console.log("📝 EMBEDDING TEXTS (showing with/without description difference)");
  console.log("━".repeat(80));

  const embeddingTexts: { sku: string; text: string; cluster: string }[] = [];
  for (const p of products) {
    const text = buildEmbeddingText(p as Product);
    const cluster = clusterLabels[p.sku] || "?";
    embeddingTexts.push({ sku: p.sku, text, cluster });

    const hasDesc = p.description && p.description.length > 0;
    console.log(`\n  [${cluster}] SKU ${p.sku} (${hasDesc ? "WITH desc" : "NO desc"}, ${text.length} chars):`);
    console.log(`  ${text.split("\n").join("\n  ")}`);
  }

  // Step 4: Generate embeddings
  console.log("\n" + "━".repeat(80));
  console.log("🔢 GENERATING EMBEDDINGS");
  console.log("━".repeat(80));

  const embedResponse = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    input: embeddingTexts.map((e) => e.text),
  });

  console.log(`  ✅ ${embedResponse.data.length} vectors × ${EMBEDDING_DIMENSIONS}d`);
  console.log(`  💰 Tokens: ${embedResponse.usage.total_tokens}`);

  // Step 5: Store in DB
  console.log("\n" + "━".repeat(80));
  console.log("💾 STORING IN DB");
  console.log("━".repeat(80));

  for (let i = 0; i < products.length; i++) {
    const embedding = embedResponse.data[i].embedding;
    const updatePayload: Record<string, unknown> = {
      embedding: JSON.stringify(embedding),
    };
    if (products[i].description !== undefined) {
      updatePayload.description = products[i].description;
    }

    const { error: updateError } = await supabase
      .from("products")
      .update(updatePayload)
      .eq("id", products[i].id);

    console.log(updateError
      ? `  ❌ ${products[i].sku}: ${updateError.message}`
      : `  ✅ ${products[i].sku}`);
  }

  // Step 6: Semantic search tests
  console.log("\n" + "━".repeat(80));
  console.log("🔍 SEMANTIC SEARCH TESTS");
  console.log("━".repeat(80));

  const testQueries = [
    {
      query: "třípólový výkonový jistič 160A",
      expectCluster: "CB",
      description: "Should find circuit breakers (with AND without descriptions)",
    },
    {
      query: "silový instalační kabel měděný 3 žíly 2,5mm pro pevné uložení",
      expectCluster: "CABLE",
      description: "Should find CYKY cables (with AND without descriptions)",
    },
    {
      query: "LED panel čtvercový 600x600mm do podhledu pro kanceláře",
      expectCluster: "LED",
      description: "Should find LED panels (with AND without descriptions)",
    },
    {
      query: "jistič motorový ochrana strojního zařízení 40A Siemens",
      expectCluster: "CB",
      description: "Should find similar circuit breaker (cross-cluster to existing 1705662)",
    },
    {
      query: "plochý kabel do elektroinstalace měděný",
      expectCluster: "CABLE",
      description: "Vague query – should still find cables as closest match",
    },
  ];

  for (const test of testQueries) {
    console.log(`\n  ── "${test.query}" ──`);
    console.log(`  Expected: ${test.expectCluster} | ${test.description}`);

    const qResp = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      input: test.query,
    });

    const { data: results, error: searchError } = await supabase.rpc(
      "search_products_semantic",
      {
        query_embedding: JSON.stringify(qResp.data[0].embedding),
        max_results: 8,
        similarity_threshold: 0.2,
      },
    );

    if (searchError) {
      console.log(`  ❌ ${searchError.message}`);
      continue;
    }

    if (!results || results.length === 0) {
      console.log("  (no results)");
      continue;
    }

    for (const r of results as Array<{ sku: string; name: string; cosine_similarity: number; description: string | null }>) {
      const cluster = clusterLabels[r.sku] || "?";
      const hasDesc = r.description && r.description.length > 0;
      const match = cluster === test.expectCluster ? "✅" : "⬜";
      console.log(`  ${match} [${cluster.padEnd(7)}] ${r.sku} | ${r.name.slice(0, 42).padEnd(42)} | sim: ${r.cosine_similarity.toFixed(4)} | desc: ${hasDesc ? "YES" : "NO"}`);
    }
  }

  // Step 7: Cross-similarity matrix within clusters
  console.log("\n" + "━".repeat(80));
  console.log("📊 CROSS-SIMILARITY: Circuit breakers (with vs without desc)");
  console.log("━".repeat(80));

  const cbSkus = ["1311273", "1322497", "1322480", "1322473", "1705662"];
  const cbProducts = embeddingTexts.filter((e) => cbSkus.includes(e.sku));
  const cbVecs = cbProducts.map((e) => {
    const idx = embeddingTexts.findIndex((x) => x.sku === e.sku);
    return embedResponse.data[idx].embedding;
  });

  const cosineSim = (a: number[], b: number[]) => {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  };

  console.log(`\n  ${"".padEnd(10)} ${cbProducts.map((p) => p.sku.slice(-6).padStart(8)).join("")}`);
  for (let i = 0; i < cbProducts.length; i++) {
    const hasDesc = products.find((p) => p.sku === cbProducts[i].sku)?.description;
    const label = `${cbProducts[i].sku.slice(-6)}${hasDesc ? "*" : " "}`;
    const sims = cbVecs.map((v, j) =>
      i === j ? "   ---" : cosineSim(cbVecs[i], v).toFixed(3).padStart(8),
    );
    console.log(`  ${label.padEnd(10)} ${sims.join("")}`);
  }
  console.log("\n  (* = has description)");

  console.log("\n" + "━".repeat(80));
  console.log("✅ TEST COMPLETE");
  console.log("━".repeat(80));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
