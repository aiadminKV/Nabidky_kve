import "../../src/config/env";
import { getAdminClient } from "../services/supabase";
import { searchProductsFulltext } from "../services/search";

async function main() {
  const supabase = getAdminClient();

  // Co je SKU 1188530?
  const skus = ["1188530", "1183635", "1394321"];
  const { data } = await supabase
    .from("products_v2")
    .select("sku, name, supplier_name, category_line, category_sub")
    .in("sku", skus);
  console.log("=== Cílové produkty ===");
  for (const p of data ?? []) {
    console.log(`SKU ${p.sku}: "${p.name}" | výrobce: ${p.supplier_name} | řada: ${p.category_line}`);
  }

  // Zkusíme fulltext
  console.log("\n=== Fulltext: 'ramecek jednonasobny' ===");
  const ft1 = await searchProductsFulltext("ramecek jednonasobny", 10);
  ft1.slice(0, 8).forEach((r, i) => {
    const mark = r.sku === "1188530" ? " ←TARGET" : "";
    console.log(`  #${i+1} ${r.sku} | ${r.name.substring(0, 60)}${mark}`);
  });

  console.log("\n=== Fulltext: 'ABB ramecek' ===");
  const ft2 = await searchProductsFulltext("ABB ramecek", 10);
  ft2.slice(0, 8).forEach((r, i) => {
    const mark = r.sku === "1188530" ? " ←TARGET" : "";
    console.log(`  #${i+1} ${r.sku} | ${r.name.substring(0, 60)}${mark}`);
  });

  console.log("\n=== Fulltext: 'PL7-C2/1 jistic' ===");
  const ft3 = await searchProductsFulltext("PL7-C2/1 jistic", 10);
  ft3.slice(0, 8).forEach((r, i) => {
    const mark = r.sku === "1183635" ? " ←TARGET" : "";
    console.log(`  #${i+1} ${r.sku} | ${r.name.substring(0, 60)}${mark}`);
  });

  console.log("\n=== Fulltext: 'ZONA pohybove cidlo' ===");
  const ft4 = await searchProductsFulltext("ZONA pohybove cidlo", 10);
  ft4.slice(0, 8).forEach((r, i) => {
    const mark = r.sku === "1394321" ? " ←TARGET" : "";
    console.log(`  #${i+1} ${r.sku} | ${r.name.substring(0, 60)}${mark}`);
  });
}
main().catch(console.error);
