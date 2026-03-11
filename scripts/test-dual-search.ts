/**
 * Dual search test: raw vs reformulated vs MERGED (both combined).
 *
 * For each query:
 * 1. Search with raw query (top 30)
 * 2. Search with reformulated query (top 30)
 * 3. Merge both (union, deduplicate, best similarity per SKU)
 *
 * Also checks: is the "correct" product anywhere in raw top 30?
 *
 * Usage: cd scripts && npx tsx test-dual-search.ts
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const MODEL = "text-embedding-3-small";
const DIMS = 256;
const TOP = 30;
const THRESHOLD = 0.3;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

interface TestPair {
  id: string;
  raw: string;
  reformulated: string;
  correctKeywords: string[];
  description: string;
}

const TEST_PAIRS: TestPair[] = [
  {
    id: "J1",
    raw: "Jistič B1x16",
    reformulated: "Jednopólový jistič 16A charakteristika B",
    correctKeywords: ["jistic", "jist", "16", "1p", "1/b", "b16", "1pol"],
    description: "Raw: spojky (ŠPATNĚ)",
  },
  {
    id: "J2",
    raw: "Jistič B3x16",
    reformulated: "Třípólový jistič 16A charakteristika B",
    correctKeywords: ["jistic", "jist", "16", "3p", "3/b", "b16", "3pol"],
    description: "Raw: OK kategorie, nízké skóre",
  },
  {
    id: "V1",
    raw: "Vypínač řazení 6",
    reformulated: "Střídavý přepínač sériový řazení 6 pro domovní elektroinstalaci",
    correctKeywords: ["vypinac", "prepinac", "spinac", "razeni", "6", "seriov"],
    description: "Raw: tabulky (ŠPATNĚ)",
  },
  {
    id: "V2",
    raw: "Vypínač IP44 řazení 1",
    reformulated: "Jednopólový vypínač IP44 řazení 1 pro domovní elektroinstalaci",
    correctKeywords: ["vypinac", "spinac", "ip44", "1pol", "razeni"],
    description: "Raw: rozvaděče (ŠPATNĚ)",
  },
  {
    id: "CY1",
    raw: "Vodič CY 10",
    reformulated: "Měděný vodič CY průřez 10mm² jednožilový",
    correctKeywords: ["vodic", "cy", "10"],
    description: "Raw: zemnicí tyče (ŠPATNĚ)",
  },
  {
    id: "CY2",
    raw: "Vodič CY 4",
    reformulated: "Měděný vodič CY průřez 4mm² jednožilový",
    correctKeywords: ["vodic", "cy", "4"],
    description: "Raw: adaptéry (ŠPATNĚ)",
  },
  {
    id: "OP1",
    raw: "Ochranné pospojení vývod",
    reformulated: "Ochranné pospojení ekvipotenciální svorka vývod pro uzemnění",
    correctKeywords: ["pospoj", "ekvipot", "svorka", "ochran"],
    description: "Raw: přepěťové ochrany (ŠPATNĚ)",
  },
  {
    id: "NS1",
    raw: "Napěťová spoušť",
    reformulated: "Napěťová vypínací spoušť pro jistič modulární přístroj",
    correctKeywords: ["spoust", "napet", "vypinac"],
    description: "Raw: podpěťová spoušť (částečně OK)",
  },
  {
    id: "TB1",
    raw: "Tlačítko bezpečnosti s omezeným přístupem",
    reformulated: "Bezpečnostní nouzové tlačítko TOTAL STOP s klíčem omezeným přístupem",
    correctKeywords: ["tlacitko", "nouz", "bezpec", "stop", "total"],
    description: "Raw: klíčenka iGET (ŠPATNĚ)",
  },
  {
    id: "OK1",
    raw: "Kabel CYKY 3x1,5",
    reformulated: "Silový kabel CYKY 3 žíly průřez 1,5mm²",
    correctKeywords: ["cyky", "3x1,5", "3x1.5"],
    description: "Raw: perfektní (KONTROLNÍ)",
  },
  {
    id: "OK2",
    raw: "Zásuvka 400V 16A IP44",
    reformulated: "Průmyslová zásuvka 400V 16A stupeň krytí IP44 pětipólová",
    correctKeywords: ["zasuvka", "400", "16a", "ip44"],
    description: "Raw: perfektní (KONTROLNÍ)",
  },
  {
    id: "OK3",
    raw: "Svorka WAGO",
    reformulated: "Pružinová svorka WAGO pro spojování vodičů",
    correctKeywords: ["svorka", "wago"],
    description: "Raw: perfektní (KONTROLNÍ)",
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

function matchesKeywords(name: string, keywords: string[]): boolean {
  const lower = name.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

async function main() {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`\n${"=".repeat(90)}`);
  console.log(`DUAL SEARCH TEST: Raw vs Reformulated vs MERGED (top ${TOP})`);
  console.log(`${"=".repeat(90)}\n`);

  const rawTexts = TEST_PAIRS.map((p) => p.raw);
  const reformTexts = TEST_PAIRS.map((p) => p.reformulated);

  console.log("Generating embeddings (2 batch calls)...\n");
  const [rawEmbResp, refEmbResp] = await Promise.all([
    openai.embeddings.create({ model: MODEL, dimensions: DIMS, input: rawTexts }),
    openai.embeddings.create({ model: MODEL, dimensions: DIMS, input: reformTexts }),
  ]);

  for (let i = 0; i < TEST_PAIRS.length; i++) {
    const pair = TEST_PAIRS[i];
    const rawEmb = rawEmbResp.data[i].embedding;
    const refEmb = refEmbResp.data[i].embedding;

    const [rawRes, refRes] = await Promise.all([
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

    const rawData = (rawRes.data ?? []) as SearchResult[];
    const refData = (refRes.data ?? []) as SearchResult[];

    // Merge: union by SKU, take best similarity
    const merged = new Map<string, SearchResult & { source: string }>();
    for (const r of rawData) {
      merged.set(r.sku, { ...r, source: "RAW" });
    }
    for (const r of refData) {
      const existing = merged.get(r.sku);
      if (!existing || Number(r.cosine_similarity) > Number(existing.cosine_similarity)) {
        merged.set(r.sku, { ...r, source: existing ? "BOTH" : "REF" });
      }
    }
    const mergedSorted = [...merged.values()]
      .sort((a, b) => Number(b.cosine_similarity) - Number(a.cosine_similarity));

    // Find first "likely correct" result in each set
    const findFirst = (results: SearchResult[]) => {
      for (let j = 0; j < results.length; j++) {
        if (matchesKeywords(results[j].name, pair.correctKeywords)) {
          return { position: j + 1, result: results[j] };
        }
      }
      return null;
    };

    const rawMatch = findFirst(rawData);
    const refMatch = findFirst(refData);
    const mergedMatch = findFirst(mergedSorted);

    console.log(`${"─".repeat(90)}`);
    console.log(`[${pair.id}] ${pair.description}`);
    console.log(`  RAW:  "${pair.raw}"`);
    console.log(`  REF:  "${pair.reformulated}"`);
    console.log();

    // Show top 3 for each
    console.log(`  RAW top 3:`);
    for (let j = 0; j < Math.min(3, rawData.length); j++) {
      const r = rawData[j];
      const sim = (Number(r.cosine_similarity) * 100).toFixed(1);
      console.log(`    ${j + 1}. [${sim}%] ${r.name}${r.manufacturer ? ` | ${r.manufacturer}` : ""}`);
    }

    console.log(`  REF top 3:`);
    for (let j = 0; j < Math.min(3, refData.length); j++) {
      const r = refData[j];
      const sim = (Number(r.cosine_similarity) * 100).toFixed(1);
      console.log(`    ${j + 1}. [${sim}%] ${r.name}${r.manufacturer ? ` | ${r.manufacturer}` : ""}`);
    }

    console.log(`  MERGED top 3:`);
    for (let j = 0; j < Math.min(3, mergedSorted.length); j++) {
      const r = mergedSorted[j];
      const sim = (Number(r.cosine_similarity) * 100).toFixed(1);
      const src = (r as SearchResult & { source: string }).source;
      console.log(`    ${j + 1}. [${sim}%] [${src}] ${r.name}${r.manufacturer ? ` | ${r.manufacturer}` : ""}`);
    }

    console.log();
    console.log(`  Relevant result position (keyword match in name):`);
    console.log(`    RAW:    ${rawMatch ? `#${rawMatch.position} — ${rawMatch.result.name} [${(Number(rawMatch.result.cosine_similarity) * 100).toFixed(1)}%]` : "NOT FOUND in top 30"}`);
    console.log(`    REF:    ${refMatch ? `#${refMatch.position} — ${refMatch.result.name} [${(Number(refMatch.result.cosine_similarity) * 100).toFixed(1)}%]` : "NOT FOUND in top 30"}`);
    console.log(`    MERGED: ${mergedMatch ? `#${mergedMatch.position} — ${mergedMatch.result.name} [${(Number(mergedMatch.result.cosine_similarity) * 100).toFixed(1)}%]` : "NOT FOUND in top 30+30"}`);

    // Count unique SKUs in merged
    const rawOnly = mergedSorted.filter((r) => (r as SearchResult & { source: string }).source === "RAW").length;
    const refOnly = mergedSorted.filter((r) => (r as SearchResult & { source: string }).source === "REF").length;
    const both = mergedSorted.filter((r) => (r as SearchResult & { source: string }).source === "BOTH").length;
    console.log(`    Overlap: ${both} shared, ${rawOnly} raw-only, ${refOnly} ref-only, ${mergedSorted.length} total unique`);
    console.log();
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
