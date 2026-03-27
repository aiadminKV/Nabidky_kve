import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const skus = [
  "1132208", "1748878", "1257397007", "1753411", "1189172",
  "1213552", "1180880", "1183608", "1257383007", "1699350",
  "1723932", "1257441001", "1212052", "1181837", "1188530",
  "1179423", "1200220", "1189116", "1257631", "1524920",
];

async function main() {
  const { data } = await sb.from("products_v2").select("sku, name, supplier_name, unit").in("sku", skus);
  console.log("\nDB Product Names vs Demand Names:\n");
  console.log("SKU        | DB Name                                              | Supplier       | Unit");
  console.log("-".repeat(120));
  for (const p of (data ?? []).sort((a, b) => a.sku.localeCompare(b.sku))) {
    console.log(
      `${p.sku.padEnd(10)} | ${(p.name ?? "").slice(0, 55).padEnd(55)} | ${(p.supplier_name ?? "").slice(0, 15).padEnd(15)} | ${p.unit ?? ""}`,
    );
  }

  // Also check what fulltext returns for a few queries
  console.log("\n\nFulltext search results for sample queries:\n");
  const queries = [
    "CXKH-R-J 5×2,5",
    "CXKH-R-J 5x2,5",
    "CXKH-R-J 5x2.5",
    "CYKY-J 5×1,5",
    "CYKY-J 5x1,5",
    "CYKY-J 5x1.5",
    "Datový kabel UTP CAT6 LSOH",
    "jistič 1-pólový 16 A B",
    "jistic 1 polovy 16A B",
    "Vodič CY 6",
    "vodic CY 6",
    "H07V-K 6mm2",
  ];

  for (const q of queries) {
    const { data: results, error } = await sb.rpc("search_products_v2_fulltext", {
      search_query: q,
      max_results: 3,
    });
    const hits = (results ?? []).map((r: { sku: string; name: string }) => `${r.sku}:${r.name.slice(0, 40)}`);
    console.log(`  "${q}"`);
    console.log(`    → ${hits.length > 0 ? hits.join(" | ") : "(no results)"}`);
    if (error) console.log(`    ERROR: ${error.message}`);
  }
}

main().catch(console.error);
