/**
 * Test: gpt-5.4-mini API kompatibilita
 * Spustit: cd backend && npx tsx src/scripts/test-model-mini.ts
 */
import OpenAI from "openai";
import { env } from "../config/env.js";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

async function test() {
  console.log("🔍 Test: gpt-5.4-mini API kompatibilita\n");

  // Test 1: chat completion s reasoning_effort + max_completion_tokens
  console.log("Test 1: chat completion (reasoning_effort + max_completion_tokens)...");
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      reasoning_effort: "low" as any,
      max_completion_tokens: 200,
      messages: [
        { role: "system", content: "Odpovídej jednou větou česky." },
        { role: "user", content: "Co je jistič B16?" },
      ],
    } as any);
    console.log("  ✅ OK:", res.choices[0]?.message?.content);
  } catch (e: any) {
    console.log("  ❌ ERROR:", e.message);
    if (e.error) console.log("     detail:", JSON.stringify(e.error));
  }

  // Test 2: JSON mode
  console.log("\nTest 2: JSON mode (response_format: json_object)...");
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      reasoning_effort: "low" as any,
      max_completion_tokens: 100,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Vrať JSON." },
        { role: "user", content: 'Vrať {"codes": ["ABC123"]}' },
      ],
    } as any);
    console.log("  ✅ OK:", res.choices[0]?.message?.content);
  } catch (e: any) {
    console.log("  ❌ ERROR:", e.message);
    if (e.error) console.log("     detail:", JSON.stringify(e.error));
  }

  // Test 3: zkusit starý max_tokens (mělo by selhat nebo fungovat?)
  console.log("\nTest 3: starý max_tokens parametr (pro referenci)...");
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      max_tokens: 50,
      messages: [
        { role: "user", content: "Řekni 'ahoj'." },
      ],
    } as any);
    console.log("  ✅ max_tokens akceptován:", res.choices[0]?.message?.content);
  } catch (e: any) {
    console.log("  ❌ max_tokens odmítnut:", e.error?.message ?? e.message);
  }

  // Test 4: ověření že model existuje + latence
  console.log("\nTest 4: latence...");
  const t0 = Date.now();
  try {
    await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      reasoning_effort: "low" as any,
      max_completion_tokens: 50,
      messages: [{ role: "user", content: "Ping" }],
    } as any);
    console.log(`  ✅ Latence: ${Date.now() - t0}ms`);
  } catch (e: any) {
    console.log("  ❌ ERROR:", e.message);
  }
}

test().catch(console.error);
