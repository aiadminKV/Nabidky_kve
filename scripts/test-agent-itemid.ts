/**
 * Test: Agent tool calls with stable itemId
 *
 * Simuluje 3 use casy, které agent dostane v praxi:
 *   1. replace_product_in_offer — agent nahradí produkt přes itemId
 *   2. add_item_to_offer        — agent přidá položku za konkrétní itemId
 *   3. remove_item_from_offer   — agent odebere položku přes itemId
 *
 * Test posílá reálný chat request na /agent/offer-chat s mock nabídkou
 * a ověří, že agent zavolal správný tool se správným itemId.
 *
 * Usage: npx tsx scripts/test-agent-itemid.ts
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ── Mock nabídka (co frontend posílá v buildOfferSummary) ──────────────────

interface MockItem {
  itemId: string;
  displayNumber: number;
  name: string;
  sku: string | null;
  manufacturer: string | null;
  category: string | null;
  matchType: string;
}

const MOCK_OFFER: MockItem[] = [
  { itemId: "a1b2c3d4", displayNumber: 1, name: "Jistič B16 1P", sku: "OBL-1B16", manufacturer: "OEZ", category: "Jistače", matchType: "match" },
  { itemId: "e5f6a7b8", displayNumber: 2, name: "Kabel CYKY 3x2,5 100m", sku: "KAB-CYKY325-100", manufacturer: "Kablo", category: "Kabely", matchType: "match" },
  { itemId: "c9d0e1f2", displayNumber: 3, name: "Zásuvka 250V IP44", sku: null, manufacturer: null, category: null, matchType: "not_found" },
  { itemId: "g3h4i5j6", displayNumber: 4, name: "Rozvaděč IP44 12M", sku: "ROZ-IP44-12M", manufacturer: "Schneider", category: "Rozvaděče", matchType: "match" },
];

function buildContext(items: MockItem[]): string {
  const header = "# | itemId | Název | Výrobce | SKU | Stav";
  const divider = "---|---|---|---|---|---";
  const rows = items.map(
    (i) => `${i.displayNumber} | ${i.itemId} | ${i.name} | ${i.manufacturer ?? "–"} | ${i.sku ?? "–"} | ${i.matchType}`,
  );
  return `Aktuální nabídka (${items.length} položek):\n${header}\n${divider}\n${rows.join("\n")}`;
}

// ── Tool definice (stejné jako v agent/index.ts) ────────────────────────────

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_product",
      description: "Vyhledá produkt v katalogu. Vrátí SKU.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Vyhledávací dotaz" },
          instruction: { type: "string", description: "Extra instrukce" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_product_in_offer",
      description: "Nahradí produkt existující položky. Parametr itemId = stabilní UUID ze summary.",
      parameters: {
        type: "object",
        properties: {
          itemId: { type: "string", description: "Stable item ID (8-char hex) from offer summary" },
          selectedSku: { type: "string", description: "SKU náhradního produktu" },
          reasoning: { type: "string", description: "Důvod záměny česky" },
        },
        required: ["itemId", "selectedSku", "reasoning"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_item_to_offer",
      description: "Přidá novou položku. afterItemId = za kterou položku vložit.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "number", nullable: true },
          selectedSku: { type: "string", nullable: true },
          afterItemId: { type: "string", nullable: true, description: "Insert after item with this ID. Null = append at end." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_item_from_offer",
      description: "Odebere položku z nabídky přes itemId.",
      parameters: {
        type: "object",
        properties: {
          itemId: { type: "string", description: "Stable item ID ze summary" },
          reasoning: { type: "string" },
        },
        required: ["itemId", "reasoning"],
      },
    },
  },
];

// ── Systémový prompt (zkrácená verze z agent/index.ts) ───────────────────────

const SYSTEM_PROMPT = `Jsi asistent pro správu nabídek elektroinstalačního materiálu KV Elektro.

Dostaneš aktuální stav nabídky — každá položka má stabilní **itemId** (8-char hex) a pořadové **displayNumber** (1-based, pro zobrazení uživateli).
Když uživatel řekne "položka 3", myslí tím displayNumber=3 → najdi odpovídající itemId a použij ho ve tool callech.

PRAVIDLA:
- Pro záměnu produktu: search_product → replace_product_in_offer (s itemId)
- Pro přidání: search_product → add_item_to_offer (s afterItemId pokud specifikováno)
- Pro odebrání: remove_item_from_offer (s itemId)
- NIKDY nepoužívej position čísla jako identifikátor — vždy itemId.`;

// ── Runner ──────────────────────────────────────────────────────────────────

interface TestCase {
  name: string;
  userMessage: string;
  expectedTool: string;
  expectedItemId: string;
  validate: (toolCall: OpenAI.ChatCompletionMessageToolCall) => { ok: boolean; detail: string };
}

const TEST_CASES: TestCase[] = [
  {
    name: "replace_product — nahraď jistič za ABB",
    userMessage: "Nahraď jistič B16 (položka 1) za ekvivalent od ABB",
    expectedTool: "replace_product_in_offer",
    expectedItemId: "a1b2c3d4",
    validate(tc) {
      const args = JSON.parse(tc.function.arguments);
      const ok = args.itemId === "a1b2c3d4";
      return { ok, detail: `itemId="${args.itemId}" (expected "a1b2c3d4")` };
    },
  },
  {
    name: "add_item — přidej za kabel (položka 2)",
    userMessage: "Přidej za kabel CYKY (položka 2) nový produkt: svorkovnice Wago 2,5mm²",
    expectedTool: "add_item_to_offer",
    expectedItemId: "e5f6a7b8",
    validate(tc) {
      const args = JSON.parse(tc.function.arguments);
      const ok = args.afterItemId === "e5f6a7b8";
      return { ok, detail: `afterItemId="${args.afterItemId}" (expected "e5f6a7b8")` };
    },
  },
  {
    name: "remove_item — odeber nenalezenou zásuvku (položka 3)",
    userMessage: "Odeber položku 3 (zásuvka IP44, nenalezena)",
    expectedTool: "remove_item_from_offer",
    expectedItemId: "c9d0e1f2",
    validate(tc) {
      const args = JSON.parse(tc.function.arguments);
      const ok = args.itemId === "c9d0e1f2";
      return { ok, detail: `itemId="${args.itemId}" (expected "c9d0e1f2")` };
    },
  },
];

// ── Mock výsledek search_product (vrátíme agentovi jako tool result) ────────

function mockSearchResult(query: string): string {
  return JSON.stringify({
    matchType: "match",
    confidence: 92,
    selectedSku: `MOCK-${query.slice(0, 6).toUpperCase().replace(/\s/g, "")}`,
    product: { name: `${query} (mock)`, sku: `MOCK-${query.slice(0, 6).toUpperCase().replace(/\s/g, "")}`, manufacturer: "ABB" },
    reasoning: "Mock výsledek pro test",
  });
}

// ── Multi-turn runner — simuluje reálný agentic loop ────────────────────────

async function runTest(tc: TestCase): Promise<boolean> {
  const context = buildContext(MOCK_OFFER);
  const prompt = `${context}\n\n---\n\nZpráva uživatele:\n"${tc.userMessage}"`;

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  let round = 0;
  const MAX_ROUNDS = 5;

  while (round < MAX_ROUNDS) {
    round++;

    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      reasoning_effort: "minimal",
      max_completion_tokens: 1000,
      messages,
      tools: TOOLS,
    } as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming);

    const msg = response.choices[0]?.message;
    if (!msg) break;

    messages.push(msg as OpenAI.ChatCompletionMessageParam);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // Agent skončil textem bez tool callu
      console.log(`  ✗ Agent skončil textem bez požadovaného tool callu "${tc.expectedTool}"`);
      if (msg.content) console.log(`    Text: "${msg.content?.slice(0, 100)}"`);
      return false;
    }

    // Zpracuj každý tool call
    for (const tc_call of toolCalls) {
      const toolName = tc_call.function.name;
      const args = JSON.parse(tc_call.function.arguments);

      // Pokud je to cílový tool — validuj a vrať výsledek
      if (toolName === tc.expectedTool) {
        const { ok, detail } = tc.validate(tc_call);
        if (ok) {
          console.log(`  ✓ [round ${round}] ${tc.expectedTool} — ${detail}`);
          if (args.reasoning) console.log(`    reasoning: "${args.reasoning}"`);
        } else {
          console.log(`  ✗ [round ${round}] ${tc.expectedTool} — ${detail}`);
          console.log(`    Raw args: ${tc_call.function.arguments}`);
        }
        return ok;
      }

      // search_product — dej mock výsledek a pokračuj
      if (toolName === "search_product") {
        console.log(`  → [round ${round}] search_product("${args.query ?? args.instruction ?? "?"}")`);
        messages.push({
          role: "tool",
          tool_call_id: tc_call.id,
          content: mockSearchResult(args.query ?? "produkt"),
        });
      } else {
        // Neočekávaný tool
        console.log(`  ? [round ${round}] Neočekávaný tool: ${toolName}`);
        messages.push({
          role: "tool",
          tool_call_id: tc_call.id,
          content: JSON.stringify({ ok: true }),
        });
      }
    }
  }

  console.log(`  ✗ Nepřišel k požadovanému tool callu "${tc.expectedTool}" do ${MAX_ROUNDS} kol`);
  return false;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║     Agent itemId Use Case Test (gpt-5-mini)          ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  console.log("Mock nabídka:");
  MOCK_OFFER.forEach((i) => console.log(`  ${i.displayNumber}. [${i.itemId}] ${i.name} — ${i.sku ?? "not_found"}`));
  console.log();

  let passed = 0;
  for (const tc of TEST_CASES) {
    console.log(`▶ ${tc.name}`);
    const ok = await runTest(tc);
    if (ok) passed++;
    console.log();
  }

  console.log("══════════════════════════════════════════════════════");
  console.log(`Výsledek: ${passed}/${TEST_CASES.length} testů prošlo`);
  if (passed === TEST_CASES.length) {
    console.log("✅ Vše OK — agent správně pracuje s itemId");
  } else {
    console.log("⚠️  Některé testy selhaly");
  }
}

main().catch(console.error);
