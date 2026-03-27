import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../.env") });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  const { data: idnlfs } = await supabase
    .from("product_identifiers_v2")
    .select("identifier_value, product_id")
    .eq("identifier_type", "IDNLF")
    .neq("identifier_value", "")
    .limit(8);

  console.log("\n=== IDNLF (objednací kód dodavatele) — Exact Lookup ===\n");

  for (const row of (idnlfs ?? [])) {
    const t0 = Date.now();
    const { data, error } = await supabase.rpc("lookup_products_v2_exact", {
      lookup_query: row.identifier_value,
      max_results: 5,
    });
    const ms = Date.now() - t0;
    const match = data?.[0];
    const icon = match ? "✓" : "✗";
    console.log(`  ${icon} IDNLF "${row.identifier_value}" → ${ms}ms → ${match ? `${match.sku} ${match.name?.slice(0, 50)} (${match.match_type})` : `NOT FOUND${error ? ` ERR: ${error.message}` : ""}`}`);
  }

  // Also test with some EANs
  const { data: eans } = await supabase
    .from("product_identifiers_v2")
    .select("identifier_value, product_id")
    .eq("identifier_type", "EAN")
    .gt("identifier_value", "1000000")
    .limit(3);

  console.log("\n=== EAN — Exact Lookup ===\n");

  for (const row of (eans ?? [])) {
    const t0 = Date.now();
    const { data } = await supabase.rpc("lookup_products_v2_exact", {
      lookup_query: row.identifier_value,
      max_results: 5,
    });
    const ms = Date.now() - t0;
    const match = data?.[0];
    console.log(`  ${match ? "✓" : "✗"} EAN "${row.identifier_value}" → ${ms}ms → ${match ? `${match.sku} ${match.name?.slice(0, 50)} (${match.match_type})` : "NOT FOUND"}`);
  }

  // Test with SKU
  const { data: skus } = await supabase.from("products_v2").select("sku").is("removed_at", null).limit(3);

  console.log("\n=== SKU (interní KV číslo) — Exact Lookup ===\n");

  for (const row of (skus ?? [])) {
    const t0 = Date.now();
    const { data } = await supabase.rpc("lookup_products_v2_exact", {
      lookup_query: row.sku,
      max_results: 5,
    });
    const ms = Date.now() - t0;
    const match = data?.[0];
    console.log(`  ${match ? "✓" : "✗"} SKU "${row.sku}" → ${ms}ms → ${match ? `${match.name?.slice(0, 50)} (${match.match_type})` : "NOT FOUND"}`);
  }
}

main().catch(console.error);
