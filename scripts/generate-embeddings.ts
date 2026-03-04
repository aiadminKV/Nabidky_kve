/**
 * Generate OpenAI embeddings for products that don't have one yet.
 *
 * Uses text-embedding-3-large at 1536 dimensions (Matryoshka).
 * Processes in batches with rate-limit aware delays.
 *
 * Usage: npm run generate-embeddings [-- --batch-size=100 --limit=1000 --clean-descriptions]
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

config({ path: resolve(import.meta.dirname, "../.env") });
import OpenAI from "openai";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

const DEFAULT_BATCH_SIZE = 100;
const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIMENSIONS = 1536;
const DELAY_BETWEEN_BATCHES_MS = 300;

const CLEAN_MODEL = "gpt-4.1-mini";
const CLEAN_BATCH_SIZE = 20;
const DESC_CLEAN_THRESHOLD = 150;
const DESC_MAX_LENGTH = 500;

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
    lines.push(`Popis: ${p.description.slice(0, DESC_MAX_LENGTH)}`);
  }

  return lines.join("\n");
}

function parseArg(name: string, defaultValue: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? parseInt(arg.split("=")[1], 10) : defaultValue;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function cleanDescriptions(
  openai: OpenAI,
  supabase: ReturnType<typeof createClient>,
) {
  console.log("\n🧹 Phase 1: Cleaning product descriptions with AI...\n");

  let totalCleaned = 0;
  let totalSkipped = 0;
  let offset = 0;
  const PAGE_SIZE = 200;

  while (true) {
    const { data: products, error } = await supabase
      .from("products")
      .select("sku, name, description")
      .not("description", "is", null)
      .gt("description", "")
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`DB read failed: ${error.message}`);
    if (!products || products.length === 0) break;

    const toLLMClean = products.filter(
      (p: { description: string }) => p.description.length > DESC_CLEAN_THRESHOLD,
    );
    totalSkipped += products.length - toLLMClean.length;

    for (let i = 0; i < toLLMClean.length; i += CLEAN_BATCH_SIZE) {
      const batch = toLLMClean.slice(i, i + CLEAN_BATCH_SIZE);

      const userMessage = JSON.stringify(
        batch.map((p: { sku: string; name: string; description: string }) => ({
          sku: p.sku,
          name: p.name,
          description: p.description.slice(0, 2000),
        })),
      );

      try {
        const response = await openai.chat.completions.create({
          model: CLEAN_MODEL,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: CLEAN_SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
          temperature: 0.1,
          max_tokens: CLEAN_BATCH_SIZE * 200,
        });

        const content = response.choices[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content);
          for (const item of parsed.items ?? []) {
            if (item.sku && typeof item.description === "string") {
              const cleanDesc = item.description.slice(0, DESC_MAX_LENGTH) || null;
              await supabase
                .from("products")
                .update({ description: cleanDesc })
                .eq("sku", item.sku);
              totalCleaned++;
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ❌ Clean batch failed: ${msg}`);
      }

      if (totalCleaned % 200 === 0 && totalCleaned > 0) {
        console.log(`  ✓ ${totalCleaned} descriptions cleaned...`);
      }

      await sleep(200);
    }

    offset += PAGE_SIZE;
  }

  console.log(`\n✅ Description cleaning complete:`);
  console.log(`   Cleaned: ${totalCleaned}`);
  console.log(`   Skipped (short): ${totalSkipped}`);
}

async function generateEmbeddings(
  openai: OpenAI,
  supabase: ReturnType<typeof createClient>,
  batchSize: number,
  limit: number,
) {
  console.log(`\n🔢 Phase 2: Generating embeddings (model=${EMBEDDING_MODEL}, dim=${EMBEDDING_DIMENSIONS})...\n`);

  let totalProcessed = 0;
  let totalErrors = 0;

  while (true) {
    if (limit > 0 && totalProcessed >= limit) break;

    const currentBatchSize = limit > 0
      ? Math.min(batchSize, limit - totalProcessed)
      : batchSize;

    const { data: products, error } = await supabase
      .from("products")
      .select("id, sku, name, name_secondary, description, manufacturer_code, manufacturer, category, subcategory, sub_subcategory")
      .is("embedding", null)
      .limit(currentBatchSize);

    if (error) throw new Error(`DB read failed: ${error.message}`);
    if (!products || products.length === 0) {
      console.log("  ✅ No more products without embeddings.");
      break;
    }

    const texts = products.map((p) => buildEmbeddingText(p as Product));

    try {
      const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        input: texts,
      });

      // Save embeddings in groups of 10 to stay well within Supabase lock/statement timeouts
      const SAVE_CHUNK = 10;
      let batchErrors = 0;
      for (let j = 0; j < products.length; j += SAVE_CHUNK) {
        const chunk = products.slice(j, j + SAVE_CHUNK);
        const updates = chunk.map((p, k) => ({
          id: p.id,
          embedding: JSON.stringify(response.data[j + k].embedding),
        }));
        const { error: rpcError } = await supabase.rpc("bulk_update_embeddings", {
          updates,
        });
        if (rpcError) {
          console.error(`  ❌ Chunk update failed: ${rpcError.message}`);
          batchErrors += chunk.length;
        }
        if (j + SAVE_CHUNK < products.length) await sleep(50);
      }
      totalErrors += batchErrors;

      totalProcessed += products.length;

      if (totalProcessed % (batchSize * 10) === 0 || products.length < currentBatchSize) {
        console.log(`  ✓ ${totalProcessed} products embedded (${totalErrors} errors)`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ OpenAI API error: ${message}`);
      totalErrors += products.length;

      if (message.includes("rate_limit")) {
        console.log("  ⏳ Rate limited, waiting 60s...");
        await sleep(60_000);
        continue;
      }
    }

    await sleep(DELAY_BETWEEN_BATCHES_MS);
  }

  console.log(`\n✅ Embedding generation complete:`);
  console.log(`   Processed: ${totalProcessed}`);
  console.log(`   Errors: ${totalErrors}`);
}

async function main() {
  const batchSize = parseArg("batch-size", DEFAULT_BATCH_SIZE);
  const limit = parseArg("limit", 0);
  const shouldClean = hasFlag("clean-descriptions");

  console.log(`🔧 Config: batch=${batchSize}, limit=${limit || "all"}, clean=${shouldClean}`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  if (shouldClean) {
    await cleanDescriptions(openai, supabase);
  }

  await generateEmbeddings(openai, supabase, batchSize, limit);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
