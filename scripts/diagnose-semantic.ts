/**
 * Diagnose semantic search quality.
 * Tests cosine similarity between user queries and expected product embeddings.
 * Compares: stored embedding vs. name-only embedding vs. enriched embedding.
 */
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const MODEL = "text-embedding-3-small";
const DIMS = 256;

async function embed(text: string): Promise<number[]> {
  const r = await openai.embeddings.create({ model: MODEL, dimensions: DIMS, input: text });
  return r.data[0].embedding;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface TestCase {
  query: string;
  expectedSku: string;
  expectedName: string;
}

const tests: TestCase[] = [
  { query: "Datový kabel UTP CAT6 LSOH", expectedSku: "1132208", expectedName: "KABEL SXKD-6-UTP-LSOH 500M" },
  { query: "jistič 1-pólový 16 A B", expectedSku: "1180880", expectedName: "JISTIC PL6-B16/1" },
  { query: "H07V-K 6mm2", expectedSku: "1189116", expectedName: "VODIC CYA 6 ZLUTOZELENA H07V-K" },
  { query: "CYKY-J 5x1,5", expectedSku: "1257397007", expectedName: "KABEL CYKY-J 5x1,5, BUBEN" },
  { query: "rámeček jednonásobný", expectedSku: "1188530", expectedName: "JEDNORAMECEK 3901A-B10 B" },
  { query: "spínač jednopólový řazení 1 IP54", expectedSku: "1213553", expectedName: "SPINAC C.1 IP54 3558N-C01510 S" },
  { query: "krabice pod omítku 70mm hluboká", expectedSku: "1212052", expectedName: "KPR 68 KA" },
  { query: "chránič proudový 1+N 16A typ B", expectedSku: "1754843", expectedName: "" },
  { query: "rozvodnice nástěnná 72 modulů IP41", expectedSku: "1181837", expectedName: "" },
  { query: "LED driver 12V 20-50W", expectedSku: "1997705", expectedName: "" },
];

async function main() {
  console.log("Semantic Search Diagnosis — KV Offer Manager");
  console.log(`Model: ${MODEL}, dimensions: ${DIMS}\n`);

  // Fill in missing expected names
  for (const t of tests) {
    if (!t.expectedName) {
      const { data } = await sb.from("products_v2").select("name").eq("sku", t.expectedSku).single();
      if (data) t.expectedName = data.name;
    }
  }

  console.log("1. SIMILARITY: user query → stored product embedding\n");

  for (const t of tests) {
    const queryEmb = await embed(t.query);
    const { data } = await sb.from("product_embeddings_v2").select("embedding, embedding_text").eq("sku", t.expectedSku).single();
    if (!data) { console.log(`  ${t.expectedSku} — no embedding`); continue; }

    const prodEmb: number[] = typeof data.embedding === "string" ? JSON.parse(data.embedding) : data.embedding;
    const simStored = cosine(queryEmb, prodEmb);

    // Also embed just product name
    const prodNameEmb = await embed(t.expectedName);
    const simNameOnly = cosine(queryEmb, prodNameEmb);

    // Enriched: product name + synonyms/alternatives
    const enrichedText = `${data.embedding_text}\nAlternativní názvy: ${t.query}`;
    const enrichedEmb = await embed(enrichedText);
    const simEnriched = cosine(queryEmb, enrichedEmb);

    const threshold = 0.35;
    const wouldFind = simStored >= threshold ? "✓" : "✗";

    console.log(`  ${wouldFind} "${t.query}"`);
    console.log(`    → ${t.expectedSku}: ${t.expectedName}`);
    console.log(`    stored: ${simStored.toFixed(3)}  name_only: ${simNameOnly.toFixed(3)}  enriched: ${simEnriched.toFixed(3)}`);
    console.log(`    gain from enrichment: +${((simEnriched - simStored) * 100).toFixed(1)}pp`);
    console.log();
  }

  // Part 2: Search with SAME embedding used for sim calculation
  // (ensures Part 1 and Part 2 use identical query vectors)
  console.log("\n2. SEMANTIC SEARCH with the SAME query embedding (top 5)\n");

  for (const t of tests) {
    const queryEmb = await embed(t.query);

    // Manual sim check
    const { data: embRow } = await sb.from("product_embeddings_v2")
      .select("embedding")
      .eq("sku", t.expectedSku)
      .single();
    let manualSim = -1;
    if (embRow) {
      const prodEmb: number[] = typeof embRow.embedding === "string"
        ? JSON.parse(embRow.embedding) : embRow.embedding;
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < queryEmb.length; i++) {
        dot += queryEmb[i] * prodEmb[i]; na += queryEmb[i] * queryEmb[i]; nb += prodEmb[i] * prodEmb[i];
      }
      manualSim = dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    // RPC search with same embedding
    const { data } = await sb.rpc("search_products_v2_semantic", {
      query_embedding: JSON.stringify(queryEmb),
      max_results: 50,
      similarity_threshold: 0.3,
    });

    const results = (data ?? []) as Array<{ sku: string; name: string; cosine_similarity: number }>;
    const foundResult = results.find((r) => r.sku === t.expectedSku);

    console.log(`  "${t.query}" → exp: ${t.expectedSku} (manual_sim: ${manualSim.toFixed(3)})`);
    if (foundResult) {
      const pos = results.indexOf(foundResult);
      console.log(`    ✓ FOUND at position ${pos + 1}/${results.length}, rpc_sim: ${foundResult.cosine_similarity.toFixed(3)}`);
    } else {
      console.log(`    ✗ NOT FOUND in top ${results.length} results`);
    }

    for (const r of results.slice(0, 3)) {
      const mark = r.sku === t.expectedSku ? " ← EXPECTED" : "";
      console.log(`    ${r.cosine_similarity.toFixed(3)} ${r.sku} ${r.name.slice(0, 55)}${mark}`);
    }
    console.log();
  }
}

main().catch(console.error);
