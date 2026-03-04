import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Test simple fetch
const { data, error } = await sb
  .from("products")
  .select("id, name")
  .is("embedding", null)
  .order("id")
  .limit(3);

console.log("Fetch:", error ? "ERROR: " + JSON.stringify(error) : `${data?.length} rows`);
if (data?.[0]) console.log("First id:", data[0].id, "name:", data[0].name);

// Test count
const { count, error: ce } = await sb
  .from("products")
  .select("*", { count: "exact", head: true })
  .is("embedding", null);

console.log("Count:", ce ? "ERROR: " + JSON.stringify(ce) : count);
