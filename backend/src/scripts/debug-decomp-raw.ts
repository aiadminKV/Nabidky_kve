/**
 * debug-decomp-raw.ts — ukáže RAW výstup Responses API
 * Run: npx tsx src/scripts/debug-decomp-raw.ts
 */
import "dotenv/config";
import OpenAI from "openai";
import { env } from "../config/env.js";

const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const resp = await (client as unknown as {
  responses: { create: (p: unknown) => Promise<{ output: unknown[] }> }
}).responses.create({
  model: "gpt-5.4-mini",
  tools: [{ type: "web_search_preview" }],
  input: [
    {
      role: "user",
      content: 'POVINNĚ proveď web search pro "Schneider Unica nosič katalog kód". Potřebuji aktuální kódy výrobce pro Schneider Unica — tvoje data mohou být zastaralá, hledej na webu.',
    },
  ],
});

console.log(`\n=== OUTPUT BLOCKS (${resp.output.length}) ===\n`);
for (const [i, block] of resp.output.entries()) {
  const b = block as Record<string, unknown>;
  console.log(`[${i}] type: ${b["type"]}`);
  // Print keys
  console.log(`    keys: ${Object.keys(b).join(", ")}`);
  // Print truncated JSON
  console.log(`    ${JSON.stringify(b).slice(0, 400)}`);
  console.log();
}
