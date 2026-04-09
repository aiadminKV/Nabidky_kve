/**
 * Test: Chování Offer Agenta – správné využití nástrojů a rozhraní
 *
 * Spustit: cd backend && npx tsx src/scripts/test-agent-behavior.ts
 *
 * Co testuje:
 *   1. Nové položky z textu → parse_items_from_text (NE process_items), navigace k tlačítku Zpracovat
 *   2. Modifikace existující položky → search_product + replace_product_in_offer (autonomně)
 *   3. Filtr skladu → agent zmiňuje kde hledá
 *   4. Neodbytný uživatel → agent vysvětlí proč tlačítko Zpracovat
 *   5. Soubor/příloha → parse + doporučení zkopírovat z tabulky
 *   6. Informační dotaz → odpověď textem, žádné tools
 *   7. Neexistující tool process_items → nesmí být zavolán
 */

import { run, user } from "@openai/agents";
import { createOfferAgentStreaming, type AgentEventCallback } from "../services/agent/index.js";
import type { SearchPreferences } from "../services/types.js";

// ── Helpers ──────────────────────────────────────────────────

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};

function ok(msg: string) { console.log(`  ${colors.green}✓${colors.reset} ${msg}`); }
function fail(msg: string) { console.log(`  ${colors.red}✗${colors.reset} ${msg}`); }
function warn(msg: string) { console.log(`  ${colors.yellow}!${colors.reset} ${msg}`); }
function info(msg: string) { console.log(`  ${colors.gray}→${colors.reset} ${msg}`); }
function section(title: string) {
  console.log(`\n${colors.bold}${colors.cyan}${"═".repeat(70)}${colors.reset}`);
  console.log(`${colors.bold}  ${title}${colors.reset}`);
  console.log(`${colors.cyan}${"═".repeat(70)}${colors.reset}`);
}

// ── Typy ─────────────────────────────────────────────────────

interface RunResult {
  toolsCalled: string[];
  actionsEmitted: string[];
  finalText: string;
  debugEntries: unknown[];
}

interface OfferItemSummary {
  itemId: string;
  displayNumber: number;
  name: string;
  manufacturer: string | null;
  sku: string | null;
  matchType: string;
}

// ── Core runner ───────────────────────────────────────────────

async function runAgent(
  userMessage: string,
  offerItems: OfferItemSummary[] = [],
  searchPreferences: SearchPreferences = { stockFilter: "any", branchFilter: null },
): Promise<RunResult> {
  const toolsCalled: string[] = [];
  const actionsEmitted: string[] = [];
  const debugEntries: unknown[] = [];
  let finalText = "";

  const onEvent: AgentEventCallback = async (entry) => {
    if (entry.type === "tool_activity" && (entry.data as { status: string }).status === "start") {
      toolsCalled.push(entry.tool ?? "unknown");
    }
    if (entry.type === "action") {
      actionsEmitted.push((entry.data as { type: string }).type);
    }
    if (entry.type === "debug") {
      debugEntries.push(entry.data);
    }
  };

  const offerAgent = createOfferAgentStreaming(onEvent, searchPreferences);

  // Build context like the backend does
  function describePrefs(prefs: SearchPreferences): string {
    if (!prefs || prefs.stockFilter === "any") return "Celý katalog (bez filtru skladu)";
    if (prefs.stockFilter === "in_stock") return "Celý katalog – pouze produkty aktuálně skladem";
    if (prefs.stockFilter === "stock_items_only") {
      if (prefs.branchFilter) return `Pouze skladovky – pobočka ${prefs.branchFilter}`;
      return "Pouze skladovky (kdekoliv)";
    }
    if (prefs.stockFilter === "stock_items_in_stock") return "Pouze skladovky aktuálně skladem";
    return "Celý katalog";
  }

  const offerContext = offerItems.length === 0
    ? `Aktuální filtr vyhledávání: ${describePrefs(searchPreferences)}\nNabídka je prázdná – žádné položky.`
    : [
        `Aktuální filtr vyhledávání: ${describePrefs(searchPreferences)}`,
        "",
        `Aktuální nabídka (${offerItems.length} položek):`,
        "# | itemId | Název | Výrobce | SKU | Stav",
        "---|---|---|---|---|---",
        ...offerItems.map((i) =>
          `${i.displayNumber} | ${i.itemId} | ${i.name} | ${i.manufacturer ?? "–"} | ${i.sku ?? "–"} | ${i.matchType}`
        ),
      ].join("\n");

  const promptText = `${offerContext}\n\n---\n\nZpráva uživatele:\n"${userMessage}"`;

  const result = await run(offerAgent, promptText, { maxTurns: 6 });
  await result.completed;

  // Extract final text – SDK exposes it via finalOutput (string for text agents)
  const fo = result.finalOutput;
  if (typeof fo === "string") {
    finalText = fo;
  } else if (fo != null) {
    finalText = String(fo);
  }

  // Fallback: scan newItems for assistant text messages
  if (!finalText.trim()) {
    for (const item of result.newItems ?? []) {
      const raw = item as unknown as { type?: string; rawItem?: { role?: string; content?: unknown } };
      if (raw.type === "message_output_item" && raw.rawItem?.role === "assistant") {
        const content = raw.rawItem.content;
        if (typeof content === "string") {
          finalText += content;
        } else if (Array.isArray(content)) {
          for (const c of content) {
            const part = c as { type?: string; text?: string };
            if ((part.type === "output_text" || part.type === "text") && part.text) {
              finalText += part.text;
            }
          }
        }
      }
    }
  }

  return { toolsCalled, actionsEmitted, finalText, debugEntries };
}

// ── Scénáře ───────────────────────────────────────────────────

interface ScenarioResult {
  name: string;
  passed: boolean;
  details: string[];
}

const results: ScenarioResult[] = [];

function assert(condition: boolean, description: string, details: string[]): boolean {
  if (condition) {
    ok(description);
  } else {
    fail(description);
  }
  return condition;
}

// ── Scénář 1: Nové položky z textu ────────────────────────────

async function scenario1(): Promise<ScenarioResult> {
  section("SCÉNÁŘ 1: Nové položky z textu → parse + navigace k Zpracovat");
  info('Vstup: "Zpracuj tuto poptávku: jistič B16 5ks, kabel CYKY 3x2,5 100m, FI 2P 30mA 3ks"');
  info("Nabídka: prázdná | Filtr: celý katalog");

  const { toolsCalled, actionsEmitted, finalText } = await runAgent(
    "Zpracuj tuto poptávku: jistič B16 5ks, kabel CYKY 3x2,5 100m, FI 2P 30mA 3ks",
  );

  info(`Zavolané tools: ${toolsCalled.join(", ") || "(žádné)"}`);
  info(`Emitované akce: ${actionsEmitted.join(", ") || "(žádné)"}`);
  info(`Odpověď (zkrácená): ${finalText.slice(0, 200)}...`);

  const details: string[] = [];
  let passed = true;

  // Nesmí zavolat process_items
  passed = assert(!toolsCalled.includes("process_items"),
    "NESMÍ zavolat process_items (tool neexistuje / byl odebrán)", details) && passed;

  // Má zavolat parse_items_from_text
  passed = assert(toolsCalled.includes("parse_items_from_text"),
    "MÁ zavolat parse_items_from_text", details) && passed;

  // Nesmí zavolat search_product (nejde o modifikaci)
  passed = assert(!toolsCalled.includes("search_product"),
    "NESMÍ zavolat search_product (nejde o modifikaci existující položky)", details) && passed;

  // V odpovědi musí být zmínka o tlačítku Zpracovat nebo UI flow
  const mentionsProcess = /zpracovat|tlačítko|klikn/i.test(finalText);
  passed = assert(mentionsProcess,
    "Odpověď MUSÍ navigovat uživatele k tlačítku 'Zpracovat'", details) && passed;

  return { name: "Nové položky z textu", passed, details };
}

// ── Scénář 2: Modifikace existující položky ────────────────────

async function scenario2(): Promise<ScenarioResult> {
  section("SCÉNÁŘ 2: Modifikace existující položky → autonomní search + replace");
  info('Vstup: "Najdi alternativu k položce 1 od výrobce Hager"');
  info("Nabídka: 1 položka (jistič ABB S201-B16)");

  const offerItems: OfferItemSummary[] = [
    {
      itemId: "uuid-test-1234",
      displayNumber: 1,
      name: "Jistič S201-B16 1P B16A",
      manufacturer: "ABB",
      sku: "ABC123",
      matchType: "match",
    },
  ];

  const { toolsCalled, actionsEmitted, finalText } = await runAgent(
    "Najdi alternativu k položce 1 od výrobce Hager",
    offerItems,
    { stockFilter: "stock_items_only", branchFilter: null },
  );

  info(`Zavolané tools: ${toolsCalled.join(", ") || "(žádné)"}`);
  info(`Emitované akce: ${actionsEmitted.join(", ") || "(žádné)"}`);
  info(`Odpověď (zkrácená): ${finalText.slice(0, 200)}...`);

  const details: string[] = [];
  let passed = true;

  // Musí zavolat search_product
  passed = assert(toolsCalled.includes("search_product"),
    "MÁ zavolat search_product", details) && passed;

  // Musí zavolat replace_product_in_offer nebo add_item_to_offer
  const hasReplaceOrAdd = toolsCalled.includes("replace_product_in_offer") || toolsCalled.includes("add_item_to_offer");
  passed = assert(hasReplaceOrAdd,
    "MÁ zavolat replace_product_in_offer (nebo add_item_to_offer)", details) && passed;

  // Nesmí zavolat parse_items_from_text (jde o modifikaci, ne parsování)
  passed = assert(!toolsCalled.includes("parse_items_from_text"),
    "NESMÍ zavolat parse_items_from_text (nejde o nové položky)", details) && passed;

  return { name: "Modifikace existující položky", passed, details };
}

// ── Scénář 3: Filtr skladu zmíněn v odpovědi ──────────────────

async function scenario3(): Promise<ScenarioResult> {
  section("SCÉNÁŘ 3: Filtr skladu → agent ho zmíní při vyhledávání");
  info('Vstup: "Vyměň položku 1 za jinou"');
  info("Filtr: Pouze skladovky – pobočka BRN");

  const offerItems: OfferItemSummary[] = [
    {
      itemId: "uuid-test-5678",
      displayNumber: 1,
      name: "Zásuvka dvojitá bílá",
      manufacturer: "Legrand",
      sku: "XYZ456",
      matchType: "match",
    },
  ];

  const { toolsCalled, finalText } = await runAgent(
    "Vyměň položku 1 za alternativu od ABB",
    offerItems,
    { stockFilter: "stock_items_only", branchFilter: "BRN" },
  );

  info(`Zavolané tools: ${toolsCalled.join(", ") || "(žádné)"}`);
  info(`Odpověď (zkrácená): ${finalText.slice(0, 300)}...`);

  const details: string[] = [];
  let passed = true;

  // Agent musí zavolat search_product
  passed = assert(toolsCalled.includes("search_product"),
    "MÁ zavolat search_product", details) && passed;

  // V odpovědi nebo před voláním musí být zmínka o filtru
  const mentionsFilter = /skladovk|pobočk|BRN|filtr/i.test(finalText);
  if (mentionsFilter) {
    ok("Odpověď ZMIŇUJE filtr skladu / pobočku");
  } else {
    warn("Odpověď NEZMIŇUJE filtr – doporučeno (není striktní požadavek)");
  }

  return { name: "Filtr skladu v kontextu", passed, details };
}

// ── Scénář 4: Neodbytný uživatel ──────────────────────────────

async function scenario4(): Promise<ScenarioResult> {
  section("SCÉNÁŘ 4: Neodbytný uživatel – chce spustit vyhledávání z chatu");
  info('Vstup: "Spusť hned vyhledávání pro tyto položky, nechci klikat na Zpracovat"');

  const { toolsCalled, actionsEmitted, finalText } = await runAgent(
    "Spusť hned vyhledávání pro tyto položky: jistič B16 10ks, zásuvka dvojitá 5ks. Nechci klikat na žádné tlačítko, spusť to přímo.",
  );

  info(`Zavolané tools: ${toolsCalled.join(", ") || "(žádné)"}`);
  info(`Emitované akce: ${actionsEmitted.join(", ") || "(žádné)"}`);
  info(`Odpověď (zkrácená): ${finalText.slice(0, 400)}...`);

  const details: string[] = [];
  let passed = true;

  // Nesmí zavolat process_items
  passed = assert(!toolsCalled.includes("process_items"),
    "NESMÍ zavolat process_items", details) && passed;

  // Měl by parsovat
  const parsed = toolsCalled.includes("parse_items_from_text");
  if (parsed) {
    ok("Parsuje položky přes parse_items_from_text");
  } else {
    warn("Neparsuje – možná jen odpovídá textem");
  }

  // Musí vysvětlit proč je tlačítko lepší (filtr, plán, skupiny)
  const explainsPlan = /plán|skupin|výrobce|filtr|sklad/i.test(finalText);
  passed = assert(explainsPlan,
    "Odpověď VYSVĚTLUJE výhody tlačítka Zpracovat (plán, skupiny, filtr)", details) && passed;

  return { name: "Neodbytný uživatel", passed, details };
}

// ── Scénář 5: Informační dotaz ────────────────────────────────

async function scenario5(): Promise<ScenarioResult> {
  section("SCÉNÁŘ 5: Informační dotaz → odpověď textem, žádné tools");
  info('Vstup: "Jaký je rozdíl mezi jističem B a C charakteristiky?"');

  const { toolsCalled, finalText } = await runAgent(
    "Jaký je rozdíl mezi jističem B a C charakteristiky?",
  );

  info(`Zavolané tools: ${toolsCalled.join(", ") || "(žádné)"}`);
  info(`Odpověď (zkrácená): ${finalText.slice(0, 300)}...`);

  const details: string[] = [];
  let passed = true;

  // Nesmí volat žádné tools
  const hasActionTools = toolsCalled.some(t => ["process_items", "search_product", "parse_items_from_text", "replace_product_in_offer"].includes(t));
  passed = assert(!hasActionTools,
    "NESMÍ volat akční tools pro informační dotaz", details) && passed;

  // Musí odpovědět textem
  passed = assert(finalText.length > 50,
    "Musí vrátit textovou odpověď", details) && passed;

  // Odpověď musí být o jističích
  const relevantAnswer = /jistič|charakteristik|přetížení|zkrat|B.*C|proud/i.test(finalText);
  passed = assert(relevantAnswer,
    "Odpověď musí být technicky relevantní", details) && passed;

  return { name: "Informační dotaz", passed, details };
}

// ── Scénář 6: Příloha z Excelu – navigace bez vyhledávání ─────

async function scenario6(): Promise<ScenarioResult> {
  section("SCÉNÁŘ 6: Excel příloha → parse + doporučení zkopírovat z tabulky");

  // Simulujeme Excel přílohu zpracovanou jako TSV
  const tsvData = `Název\tMnožství\tJednotka\tKód
Jistič PL6-B16/1\t20\tks\tPL6-B16/1N
Kabel CYKY 3x2,5 KRUH 100M\t5\tks\t`;

  const { toolsCalled, finalText } = await runAgent(
    `Příloha souboru "poptávka.xlsx":\n${tsvData}`,
  );

  info(`Zavolané tools: ${toolsCalled.join(", ") || "(žádné)"}`);
  info(`Odpověď (zkrácená): ${finalText.slice(0, 300)}...`);

  const details: string[] = [];
  let passed = true;

  // Nesmí zavolat process_items
  passed = assert(!toolsCalled.includes("process_items"),
    "NESMÍ zavolat process_items", details) && passed;

  // Má parsovat nebo alespoň nerozjet search
  const noSearch = !toolsCalled.includes("search_product");
  passed = assert(noSearch,
    "NESMÍ rovnou spustit search_product", details) && passed;

  // Musí zmínit tlačítko Zpracovat nebo ruční kontrolu
  const navigates = /zpracovat|zkontroluj|tlačítko/i.test(finalText);
  passed = assert(navigates,
    "Odpověď NAVIGUJE k tlačítku Zpracovat nebo ruční kontrole", details) && passed;

  return { name: "Excel příloha bez automatického vyhledávání", passed, details };
}

// ── Scénář 7: process_items není dostupný – odolnost ──────────

async function scenario7(): Promise<ScenarioResult> {
  section("SCÉNÁŘ 7: Ověření že process_items tool vůbec neexistuje v agentovi");
  info("Testuje že agent nemá přístup k process_items (byl odebrán z tools listu)");

  // Vytvoříme agenta a zkontrolujeme jeho tools list
  const toolNames: string[] = [];
  const testOnEvent: AgentEventCallback = async () => {};
  const agentForInspection = createOfferAgentStreaming(testOnEvent);

  // Inspect tools
  const agentTools = (agentForInspection as unknown as { tools?: Array<{ name: string }> }).tools;
  if (agentTools) {
    for (const t of agentTools) {
      toolNames.push(t.name);
    }
  }

  info(`Dostupné tools agenta: ${toolNames.join(", ")}`);

  const details: string[] = [];
  let passed = true;

  passed = assert(!toolNames.includes("process_items"),
    "process_items NENÍ v seznamu tools agenta", details) && passed;

  passed = assert(toolNames.includes("search_product"),
    "search_product JE v seznamu tools agenta", details) && passed;

  passed = assert(toolNames.includes("parse_items_from_text"),
    "parse_items_from_text JE v seznamu tools agenta", details) && passed;

  passed = assert(toolNames.includes("replace_product_in_offer"),
    "replace_product_in_offer JE v seznamu tools agenta", details) && passed;

  info(`Celkem tools: ${toolNames.length}`);

  return { name: "process_items neexistuje v agentovi", passed, details };
}

// ── Hlavní runner ─────────────────────────────────────────────

async function main() {
  console.log(`\n${colors.bold}${colors.cyan}Test: Chování Offer Agenta – správné využití nástrojů${colors.reset}`);
  console.log(`${colors.gray}Ověřuje že agent respektuje nová pravidla UI flow a tool restrictions${colors.reset}\n`);

  const startTime = Date.now();

  // Scénář 7 (bez API volání) spustíme vždy hned
  const r7 = await scenario7();
  results.push(r7);

  // Scénáře s API voláními
  const scenarios = [
    scenario5, // Informační dotaz (nejrychlejší, bez tool calls)
    scenario1, // Nové položky
    scenario6, // Excel příloha
    scenario4, // Neodbytný uživatel
    scenario2, // Modifikace existující položky (volá search_product → živý katalog)
    scenario3, // Filtr skladu (volá search_product)
  ];

  for (const scenarioFn of scenarios) {
    try {
      const result = await scenarioFn();
      results.push(result);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      fail(`Scénář selhal s chybou: ${errMsg}`);
      results.push({ name: "CHYBA", passed: false, details: [errMsg] });
    }
  }

  // ── Finální shrnutí ──

  const totalMs = Date.now() - startTime;

  section("FINÁLNÍ SHRNUTÍ");

  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  console.log();
  for (const r of results) {
    if (r.passed) {
      ok(`${r.name}`);
    } else {
      fail(`${r.name}`);
    }
  }

  console.log();
  console.log(`  ${colors.bold}Výsledek: ${passed.length}/${results.length} scénářů prošlo${colors.reset} (${totalMs}ms)`);

  if (failed.length > 0) {
    console.log(`\n  ${colors.red}Selhané scénáře:${colors.reset}`);
    for (const r of failed) {
      console.log(`  • ${r.name}`);
    }
    process.exit(1);
  } else {
    console.log(`\n  ${colors.green}Všechny scénáře prošly.${colors.reset}`);
  }
}

main().catch((err) => {
  console.error("Kritická chyba:", err);
  process.exit(1);
});
