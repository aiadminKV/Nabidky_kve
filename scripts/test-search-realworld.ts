/**
 * Real-world search test using product_embeddings table.
 *
 * Takes queries from a real project specification and searches
 * via search_product_embeddings_semantic RPC (joins product_embeddings + products by SKU).
 *
 * Usage:
 *   cd scripts && npx tsx test-search-realworld.ts
 *   cd scripts && npx tsx test-search-realworld.ts --threshold=0.3
 *   cd scripts && npx tsx test-search-realworld.ts --top=5
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const MODEL = "text-embedding-3-small";
const DIMS = 256;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

// Queries extracted from real project specification (electrical installation offer)
const QUERIES = [
  "Rozvodnice RK - uprava zapojení stávající",
  "Jistič B3x16",
  "Jistič B1x16",
  "Proudový chránič s nadproudovou ochranou 0,03A/1B1x10A",
  "Napěťová spoušť",
  "Světidlo čtvercové 23,1W 2850 lm LED IP 54",
  "Světidlo lineární 38,4W 5360 lm LED IP 54",
  "Světidlo lineární 52,8W 7360 lm LED IP 54",
  "Světidlo nouzové s vlastní bateriovým zdrojem záloha 30 minut",
  "Vypínač řazení 6",
  "Vypínač IP44 řazení 1",
  "Vypínač IP44 řazení 6",
  "Tlačítko bezpečnosti s omezeným přístupem",
  "Zásuvka 230V 16A dvojnásobná",
  "Zásuvka 230V 16A IP44",
  "Zásuvka 400V 16A IP44",
  "Vypínač 3F 25A",
  "Krabice KO8",
  "Svorka WAGO",
  "Ochranné pospojení vývod",
  "Svorka s páskem CU",
  "Vodič CY 10",
  "Vodič CY 4",
  "Kabel CYKY 3x1,5",
  "Kabel CYKY 3x2,5",
  "Kabel CYKY 5x2,5",
  "Kabel CYKY 5x4",
  "Kabel CYKY 2x1,5",
  "Kabel UTP cat5",
  "Kabel CGSG J5x2,5",
];

function parseArg(name: string, defaultValue: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? parseFloat(arg.split("=")[1]) : defaultValue;
}

interface SearchResult {
  sku: string;
  name: string;
  manufacturer: string | null;
  category: string | null;
  subcategory: string | null;
  cosine_similarity: number;
}

async function searchQuery(
  supabase: ReturnType<typeof createClient>,
  embedding: number[],
  threshold: number,
  top: number,
): Promise<SearchResult[]> {
  const { data, error } = await supabase.rpc("search_product_embeddings_semantic", {
    query_embedding: JSON.stringify(embedding),
    max_results: top,
    similarity_threshold: threshold,
  });

  if (error) throw new Error(`RPC error: ${error.message}`);
  return (data ?? []) as SearchResult[];
}

async function main() {
  const threshold = parseArg("threshold", 0.35);
  const top = parseArg("top", 3);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENAI_API_KEY) {
    console.error("Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY");
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Real-world search test — product_embeddings table`);
  console.log(`Model: ${MODEL} @ ${DIMS} dims | threshold: ${threshold} | top: ${top}`);
  console.log(`${"=".repeat(70)}\n`);

  let totalHits = 0;
  let totalMissed = 0;
  const latencies: number[] = [];

  for (const query of QUERIES) {
    // Generate embedding
    const embResp = await openai.embeddings.create({
      model: MODEL,
      dimensions: DIMS,
      input: query,
    });
    const embedding = embResp.data[0].embedding;

    const start = Date.now();
    let results: SearchResult[] = [];
    try {
      results = await searchQuery(supabase, embedding, threshold, top);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR for "${query}": ${msg}`);
    }
    const latency = Date.now() - start;
    latencies.push(latency);

    console.log(`Query: "${query}"  (${latency}ms)`);

    if (results.length === 0) {
      console.log(`  ⚠️  No results above threshold ${threshold}`);
      totalMissed++;
    } else {
      totalHits++;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const sim = (Number(r.cosine_similarity) * 100).toFixed(1);
        const cat = [r.category, r.subcategory].filter(Boolean).join(" > ");
        const mfr = r.manufacturer ? ` | ${r.manufacturer}` : "";
        console.log(`  ${i + 1}. [${sim}%] ${r.sku}  ${r.name}${mfr}`);
        if (cat) console.log(`      ${cat}`);
      }
    }
    console.log();
  }

  // Summary
  const avgLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  const maxLatency = Math.max(...latencies);
  const minLatency = Math.min(...latencies);

  console.log(`${"=".repeat(70)}`);
  console.log(`SUMMARY`);
  console.log(`  Queries:   ${QUERIES.length}`);
  console.log(`  With results: ${totalHits} (${Math.round((totalHits / QUERIES.length) * 100)}%)`);
  console.log(`  No results:   ${totalMissed} (${Math.round((totalMissed / QUERIES.length) * 100)}%)`);
  console.log(`  Latency:   avg ${avgLatency}ms  min ${minLatency}ms  max ${maxLatency}ms`);
  console.log(`${"=".repeat(70)}\n`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
