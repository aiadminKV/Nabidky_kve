/**
 * A/B test: Raw queries vs AI-reformulated queries for semantic search.
 *
 * Tests whether reformulating electrical abbreviations into natural language
 * actually improves semantic search results.
 *
 * Usage: cd scripts && npx tsx test-reformulation-ab.ts
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const MODEL = "text-embedding-3-small";
const DIMS = 256;
const TOP = 5;
const THRESHOLD = 0.3;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

interface TestPair {
  id: string;
  raw: string;
  reformulated: string;
  expectedCategory: string;
  description: string;
}

const TEST_PAIRS: TestPair[] = [
  {
    id: "J1",
    raw: "Jistič B1x16",
    reformulated: "Jednopólový jistič 16A charakteristika B",
    expectedCategory: "jističe",
    description: "Raw: 53.8% → spojky (ŠPATNĚ)",
  },
  {
    id: "J2",
    raw: "Jistič B3x16",
    reformulated: "Třípólový jistič 16A charakteristika B",
    expectedCategory: "jističe",
    description: "Raw: 58.8% → správná kategorie ale nízké skóre",
  },
  {
    id: "V1",
    raw: "Vypínač řazení 6",
    reformulated: "Střídavý přepínač sériový řazení 6 pro domovní elektroinstalaci",
    expectedCategory: "spínače",
    description: "Raw: 59.7% → tabulky (ŠPATNĚ)",
  },
  {
    id: "V2",
    raw: "Vypínač IP44 řazení 1",
    reformulated: "Jednopólový vypínač IP44 řazení 1 pro domovní elektroinstalaci",
    expectedCategory: "spínače",
    description: "Raw: 66.9% → rozvaděče (ŠPATNĚ)",
  },
  {
    id: "V3",
    raw: "Vypínač IP44 řazení 6",
    reformulated: "Střídavý přepínač sériový IP44 řazení 6",
    expectedCategory: "spínače",
    description: "Raw: 67.1% → víčko rozvaděče (ŠPATNĚ)",
  },
  {
    id: "CY1",
    raw: "Vodič CY 10",
    reformulated: "Měděný vodič CY průřez 10mm² jednožilový",
    expectedCategory: "vodiče",
    description: "Raw: 56.1% → zemnicí tyče (ŠPATNĚ)",
  },
  {
    id: "CY2",
    raw: "Vodič CY 4",
    reformulated: "Měděný vodič CY průřez 4mm² jednožilový",
    expectedCategory: "vodiče",
    description: "Raw: 49.1% → testovací adaptéry (ŠPATNĚ)",
  },
  {
    id: "OP1",
    raw: "Ochranné pospojení vývod",
    reformulated: "Ochranné pospojení ekvipotenciální svorka vývod pro uzemnění",
    expectedCategory: "pospojení",
    description: "Raw: 61.2% → přepěťové ochrany (ŠPATNĚ)",
  },
  {
    id: "NS1",
    raw: "Napěťová spoušť",
    reformulated: "Napěťová vypínací spoušť pro jistič modulární přístroj",
    expectedCategory: "spouště",
    description: "Raw: 54.2% → podpěťová spoušť (částečně OK)",
  },
  {
    id: "TB1",
    raw: "Tlačítko bezpečnosti s omezeným přístupem",
    reformulated: "Bezpečnostní nouzové tlačítko TOTAL STOP s klíčem omezeným přístupem",
    expectedCategory: "bezpečnost",
    description: "Raw: 58.7% → klíčenka iGET (ŠPATNĚ)",
  },
  // Control group — queries that already work well raw
  {
    id: "OK1",
    raw: "Kabel CYKY 3x1,5",
    reformulated: "Silový kabel CYKY 3 žíly průřez 1,5mm²",
    expectedCategory: "kabely",
    description: "Raw: 83.0% → perfektní match (KONTROLNÍ)",
  },
  {
    id: "OK2",
    raw: "Zásuvka 400V 16A IP44",
    reformulated: "Průmyslová zásuvka 400V 16A stupeň krytí IP44 pětipólová",
    expectedCategory: "zásuvky",
    description: "Raw: 81.6% → perfektní match (KONTROLNÍ)",
  },
  {
    id: "OK3",
    raw: "Svorka WAGO",
    reformulated: "Pružinová svorka WAGO pro spojování vodičů",
    expectedCategory: "svorky",
    description: "Raw: 81.2% → perfektní match (KONTROLNÍ)",
  },
];

interface SearchResult {
  sku: string;
  name: string;
  manufacturer: string | null;
  category: string | null;
  subcategory: string | null;
  cosine_similarity: number;
}

async function main() {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`\n${"=".repeat(80)}`);
  console.log(`A/B TEST: Raw queries vs Reformulated queries`);
  console.log(`Model: ${MODEL} @ ${DIMS} dims | Top ${TOP} | Threshold ${THRESHOLD}`);
  console.log(`${"=".repeat(80)}\n`);

  // Generate all embeddings in two batch calls
  const rawTexts = TEST_PAIRS.map((p) => p.raw);
  const reformTexts = TEST_PAIRS.map((p) => p.reformulated);

  console.log("Generating embeddings...");
  const [rawEmbResp, refEmbResp] = await Promise.all([
    openai.embeddings.create({ model: MODEL, dimensions: DIMS, input: rawTexts }),
    openai.embeddings.create({ model: MODEL, dimensions: DIMS, input: reformTexts }),
  ]);

  let rawWins = 0;
  let reformWins = 0;
  let ties = 0;

  for (let i = 0; i < TEST_PAIRS.length; i++) {
    const pair = TEST_PAIRS[i];
    const rawEmb = rawEmbResp.data[i].embedding;
    const refEmb = refEmbResp.data[i].embedding;

    // Run both searches in parallel
    const [rawResults, refResults] = await Promise.all([
      supabase.rpc("search_product_embeddings_semantic", {
        query_embedding: JSON.stringify(rawEmb),
        max_results: TOP,
        similarity_threshold: THRESHOLD,
      }),
      supabase.rpc("search_product_embeddings_semantic", {
        query_embedding: JSON.stringify(refEmb),
        max_results: TOP,
        similarity_threshold: THRESHOLD,
      }),
    ]);

    const rawData = (rawResults.data ?? []) as SearchResult[];
    const refData = (refResults.data ?? []) as SearchResult[];

    const rawTop = rawData[0];
    const refTop = refData[0];
    const rawSim = rawTop ? Number(rawTop.cosine_similarity) : 0;
    const refSim = refTop ? Number(refTop.cosine_similarity) : 0;
    const diff = refSim - rawSim;

    let winner: string;
    if (Math.abs(diff) < 0.01) {
      winner = "TIE";
      ties++;
    } else if (diff > 0) {
      winner = "REFORMULATED ✅";
      reformWins++;
    } else {
      winner = "RAW ✅";
      rawWins++;
    }

    console.log(`\n${"─".repeat(80)}`);
    console.log(`[${pair.id}] ${pair.description}`);
    console.log(`  RAW:          "${pair.raw}"`);
    console.log(`  REFORMULATED: "${pair.reformulated}"`);
    console.log();

    console.log(`  RAW results (top similarity: ${(rawSim * 100).toFixed(1)}%):`);
    for (let j = 0; j < Math.min(3, rawData.length); j++) {
      const r = rawData[j];
      const sim = (Number(r.cosine_similarity) * 100).toFixed(1);
      const cat = [r.category, r.subcategory].filter(Boolean).join(" > ");
      console.log(`    ${j + 1}. [${sim}%] ${r.sku}  ${r.name}${r.manufacturer ? ` | ${r.manufacturer}` : ""}`);
      if (cat) console.log(`       ${cat}`);
    }

    console.log();
    console.log(`  REFORMULATED results (top similarity: ${(refSim * 100).toFixed(1)}%):`);
    for (let j = 0; j < Math.min(3, refData.length); j++) {
      const r = refData[j];
      const sim = (Number(r.cosine_similarity) * 100).toFixed(1);
      const cat = [r.category, r.subcategory].filter(Boolean).join(" > ");
      console.log(`    ${j + 1}. [${sim}%] ${r.sku}  ${r.name}${r.manufacturer ? ` | ${r.manufacturer}` : ""}`);
      if (cat) console.log(`       ${cat}`);
    }

    console.log();
    console.log(`  WINNER: ${winner}  (diff: ${diff > 0 ? "+" : ""}${(diff * 100).toFixed(1)}pp)`);
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log(`SUMMARY`);
  console.log(`  Tests:            ${TEST_PAIRS.length}`);
  console.log(`  Raw wins:         ${rawWins}`);
  console.log(`  Reformulated wins: ${reformWins}`);
  console.log(`  Ties (<1pp diff):  ${ties}`);
  console.log(`${"=".repeat(80)}\n`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
