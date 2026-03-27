import OpenAI from "openai";
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../.env") });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const REFORM_PROMPT = `Přeformuluj název elektrotechnického produktu do nejpopisnější možné formy pro sémantické vyhledávání v českém B2B katalogu elektroinstalačního materiálu.

PRAVIDLA:
1. VŽDY přeformuluj — rozviň zkratky, přidej odborný kontext
2. Pokud zkratce NEROZUMÍŠ, ponech originální text — NIKDY nevymýšlej
3. Zachovej specifické kódy výrobce, SKU, EAN beze změny (přidej kontext vedle)

Vrať plain text — jen přeformulovaný název.`;

const testCases = [
  "CYKY 3x2.5",
  "CYKY 3x2,5",
  "krabice KO8",
  "FI 2P 25A 30mA",
  "B3x16",
  "1386822",
  "4049504220657",
  "jistič 3f 16A",
  "vodic CY 10 hneda",
  "LED panel 600x600 40W",
  "stykac 25A",
  "UTP cat5",
  "Zásuvka 230V 16A IP44",
  "Přepěťová ochrana B+C 4-pol",
];

async function reformulate(name: string): Promise<string> {
  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: REFORM_PROMPT },
      { role: "user", content: name },
    ],
    temperature: 0.2,
    max_tokens: 200,
  });
  return res.choices[0]?.message?.content?.trim() ?? name;
}

async function main() {
  console.log("INPUT".padEnd(40) + "→  REFORMULATED");
  console.log("─".repeat(120));
  for (const tc of testCases) {
    const result = await reformulate(tc);
    const dotToComma = tc.includes(".") && result.includes(",");
    const flag = dotToComma ? " ✓ NORMALIZED" : "";
    console.log(tc.padEnd(40) + "→  " + result + flag);
  }
}

main().catch(console.error);
