import "../../src/config/env";
import { generateQueryEmbedding } from "../services/embedding";
import { searchProductsSemantic } from "../services/search";

const cases = [
  { label: "bez výrobce", query: "ramecek jednonasobny" },
  { label: "s ABB", query: "ABB ramecek jednonasobny" },
  { label: "ABB Tango", query: "ABB Tango ramecek jednonasobny" },
  { label: "Eaton PL7 jistic 2A C", query: "Eaton PL7 jistic 1-polovy 2A charakteristika C" },
  { label: "jistic 2A C bez výrobce", query: "jistic 1-polovy 2A charakteristika C 6kA" },
  { label: "ZONA cidlo pohybove", query: "ZONA cidlo pohybove stropni 360" },
];

const TARGET_SKUS: Record<string, string> = {
  "bez výrobce": "1188530",       // ABB rámeček
  "s ABB": "1188530",
  "ABB Tango": "1188530",
  "Eaton PL7 jistic 2A C": "1183635",  // PL7-C2/1
  "jistic 2A C bez výrobce": "1183635",
  "ZONA cidlo pohybove": "1394321",    // ZONA FLAT-W
};

async function main() {
  for (const c of cases) {
    const emb = await generateQueryEmbedding(c.query);
    const results = await searchProductsSemantic(emb, 20, 0.1);
    const target = TARGET_SKUS[c.label];
    const found = results.find(r => r.sku === target);
    const rank = results.findIndex(r => r.sku === target) + 1;

    console.log(`\n[${c.label}] query: "${c.query}"`);
    console.log(`  Hledám SKU: ${target} → ${found ? `NALEZEN na pozici #${rank} (sim: ${found.cosine_similarity.toFixed(3)})` : "NENALEZEN v top 20"}`);
    console.log(`  Top 5:`);
    results.slice(0, 5).forEach((r, i) => {
      const mark = r.sku === target ? " ←" : "";
      console.log(`    #${i+1} ${r.sku} | ${r.name.substring(0, 60)} | sim: ${r.cosine_similarity.toFixed(3)}${mark}`);
    });
  }
}
main().catch(console.error);
