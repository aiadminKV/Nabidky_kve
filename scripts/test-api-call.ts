import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

console.log("1. Testing GPT-4.1-mini call...");
const start1 = Date.now();
try {
  const r = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: "Say hello in Czech, one word" }],
    max_tokens: 20,
  });
  console.log(`   OK: "${r.choices[0]?.message?.content}" (${Date.now() - start1}ms)`);
} catch (e: any) {
  console.error(`   FAIL: ${e.message}`);
}

console.log("2. Testing Supabase connection...");
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { count, error } = await supabase
  .from("products")
  .select("*", { count: "exact", head: true })
  .is("embedding", null);
if (error) {
  console.error(`   FAIL: ${error.message}`);
} else {
  console.log(`   OK: ${count} products without embedding`);
}

console.log("3. Testing embedding call...");
const start3 = Date.now();
try {
  const r = await openai.embeddings.create({
    model: "text-embedding-3-large",
    dimensions: 1536,
    input: "test embedding",
  });
  console.log(`   OK: ${r.data[0].embedding.length}d vector (${Date.now() - start3}ms, ${r.usage.total_tokens} tokens)`);
} catch (e: any) {
  console.error(`   FAIL: ${e.message}`);
}

console.log("Done.");
