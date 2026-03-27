import { getAdminClient } from "../backend/src/services/supabase.js";

const sb = getAdminClient();
const { data, error } = await sb.rpc("execute_sql" as never, {
  sql: "SELECT upper(trim(unit)) as unit, count(*) as cnt FROM products_v2 WHERE unit IS NOT NULL GROUP BY upper(trim(unit)) ORDER BY cnt DESC",
} as never);

if (error) {
  // fallback: manual pagination
  const counts: Record<string, number> = {};
  let page = 0;
  const PAGE = 1000;
  while (true) {
    const { data: rows, error: e2 } = await sb
      .from("products_v2")
      .select("unit")
      .not("unit", "is", null)
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (e2 || !rows || rows.length === 0) break;
    for (const row of rows) {
      const u = String(row.unit).toUpperCase().trim();
      counts[u] = (counts[u] ?? 0) + 1;
    }
    if (rows.length < PAGE) break;
    page++;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  console.log("Unit values in products_v2 (paginated):\n");
  for (const [unit, cnt] of sorted) {
    console.log(`  ${unit.padEnd(12)} ${cnt.toLocaleString()}`);
  }
} else {
  console.log("Unit values in products_v2:\n");
  for (const row of (data as Array<{ unit: string; cnt: string }>) ?? []) {
    console.log(`  ${String(row.unit).padEnd(12)} ${Number(row.cnt).toLocaleString()}`);
  }
}
