/**
 * pipeline-variant-c.ts
 * Variant C: ReAct agent with tools.
 * Uses the OpenAI Responses API (/v1/responses) which supports
 * tools + reasoning_effort together (unlike /v1/chat/completions).
 */

import OpenAI from "openai";
import { env } from "../config/env.js";
import { generateQueryEmbedding } from "../services/embedding.js";
import {
  searchProductsSemantic,
  searchProductsFulltext,
  lookupProductsExact,
  fetchProductsBySkus,
  type SemanticResult,
  type FulltextResult,
  type ExactResult,
} from "../services/search.js";
import type { TestCase } from "./pipeline-test-data.js";
import type { PipelineOutput } from "./pipeline-eval-framework.js";
import { TokenTracker } from "./pipeline-eval-framework.js";

const MODEL = "gpt-5.4-mini";
const MAX_TOOL_ROUNDS = 8;

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ── Tool definitions (Responses API format) ───────────────

const tools: OpenAI.Responses.Tool[] = [
  {
    type: "function",
    name: "search_products",
    description: "Vyhledej produkty v katalogu podle textového dotazu. Vrací až 20 nejrelevantnějších produktů.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Textový dotaz pro vyhledání (název produktu, typ, parametry)" },
        manufacturer: { type: "string", description: "Filtr na výrobce (volitelný)" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "lookup_exact",
    description: "Přesné vyhledání podle SKU, EAN nebo objednacího kódu výrobce. Použij pokud máš konkrétní kód.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "SKU, EAN, nebo objednací kód produktu" },
      },
      required: ["code"],
    },
  },
  {
    type: "function",
    name: "get_product_detail",
    description: "Získej detailní informace o produktu podle SKU. Použij pro ověření parametrů kandidáta.",
    parameters: {
      type: "object",
      properties: {
        sku: { type: "string", description: "SKU produktu" },
      },
      required: ["sku"],
    },
  },
  {
    type: "function",
    name: "submit_result",
    description: "Odevzdej finální výsledek výběru produktu. MUSÍ být voláno jako poslední akce.",
    parameters: {
      type: "object",
      properties: {
        selectedSku: { type: ["string", "null"], description: "SKU vybraného produktu, nebo null pokud nic nenalezeno" },
        matchType: { type: "string", enum: ["match", "uncertain", "multiple", "not_found"], description: "Typ shody" },
        confidence: { type: "number", description: "Confidence 0-100" },
        reasoning: { type: "string", description: "Zdůvodnění výběru (1-2 věty česky)" },
        alternativeSkus: {
          type: "array", items: { type: "string" },
          description: "SKU dalších vhodných kandidátů (max 5)",
        },
      },
      required: ["selectedSku", "matchType", "confidence", "reasoning"],
    },
  },
];

// ── Tool implementations ──────────────────────────────────

async function handleSearchProducts(query: string, manufacturer?: string): Promise<string> {
  const embedding = await generateQueryEmbedding(query);

  const [semanticResults, fulltextResults] = await Promise.all([
    searchProductsSemantic(embedding, 20, 0.35, undefined, manufacturer).catch(() => [] as SemanticResult[]),
    searchProductsFulltext(query, 20, undefined, manufacturer).catch(() => [] as FulltextResult[]),
  ]);

  const seen = new Set<string>();
  const combined: Array<{ sku: string; name: string; unit: string | null; similarity: number; source: string }> = [];

  for (const r of semanticResults) {
    if (!seen.has(r.sku)) {
      seen.add(r.sku);
      combined.push({
        sku: r.sku,
        name: r.name,
        unit: r.unit,
        similarity: Math.round(r.cosine_similarity * 1000) / 1000,
        source: "semantic",
      });
    }
  }

  for (const r of fulltextResults) {
    if (!seen.has(r.sku)) {
      seen.add(r.sku);
      combined.push({
        sku: r.sku,
        name: r.name,
        unit: r.unit,
        similarity: Math.round((0.5 + Math.max(r.rank ?? 0, r.similarity_score ?? 0) * 0.3) * 1000) / 1000,
        source: "fulltext",
      });
    }
  }

  return JSON.stringify({ count: combined.length, products: combined.slice(0, 20) });
}

async function handleLookupExact(code: string): Promise<string> {
  const results = await lookupProductsExact(code, 5).catch(() => [] as ExactResult[]);
  return JSON.stringify({
    count: results.length,
    products: results.map((r) => ({
      sku: r.sku,
      name: r.name,
      unit: r.unit,
      match_type: r.match_type,
      matched_value: r.matched_value,
    })),
  });
}

async function handleGetProductDetail(sku: string): Promise<string> {
  const products = await fetchProductsBySkus([sku]);
  if (products.length === 0) return JSON.stringify({ error: "Produkt nenalezen" });
  const p = products[0];
  return JSON.stringify({
    sku: p.sku,
    name: p.name,
    unit: p.unit,
    category_main: p.category_main,
    category_sub: p.category_sub,
    category_line: p.category_line,
    is_stock_item: p.is_stock_item,
    description: p.description,
    supplier_name: p.supplier_name,
  });
}

// ── System prompt ─────────────────────────────────────────

const SYSTEM_PROMPT = `Jsi expert na vyhledávání a výběr elektroinstalačních produktů z B2B katalogu, který obsahuje přibližně 471 tisíc položek.

Zákazník poptává konkrétní produkt. Tvůj úkol je najít a vybrat SPRÁVNÝ produkt z katalogu pomocí dostupných nástrojů. Představ si, že jsi zkušený elektrikář, který listuje katalogem a hledá přesně to, co zákazník potřebuje.

## Jak postupovat

Krok 1: Rozepiš si, co zákazník poptává. Jaký typ produktu, jaké klíčové parametry (průřez, počet žil, proud, počet pólů...) a jestli v textu vidíš nějaký konkrétní kód (objednací číslo, SKU, EAN).

Krok 2: Pokud jsi v poptávce našel konkrétní kód, začni nástrojem lookup_exact. Přesné vyhledání podle kódu je nejspolehlivější cesta.

Krok 3: Použij search_products pro textové vyhledání. Zkus nejdřív přesný název z poptávky. Pokud výsledky nejsou dobré, zkus alternativní formulaci — v katalogu se kabely často značí s prefixem "1-" (například "1-CYKY-J" místo "CYKY-J") a vodiče se označují normou (H07V-K místo CYA).

Krok 4: Z výsledků vyhledávání vyber kandidáty, kteří přesně odpovídají požadovanému typu A všem tvrdým parametrům.

Krok 5: Pokud si nejsi jistý parametry nějakého kandidáta, ověř je nástrojem get_product_detail.

Krok 6: Jakmile máš rozhodnutí, odevzdej výsledek přes submit_result.

## Tvrdé parametry — tyto MUSÍ přesně sedět

**Průřez vodiče nebo kabelu** — číslo za znakem "x" v označení kabelu. Například "5x1,5" znamená průřez 1,5 mm². Kandidát s průřezem 95 mm² je úplně jiný produkt než kandidát s průřezem 1,5 mm², i když se oba jmenují podobně. Každý rozdíl v průřezu znamená špatný produkt.

**Počet žil nebo pólů** — číslo před znakem "x". Kabel "3x2,5" má 3 žíly, kabel "5x2,5" má 5 žil — nelze zaměnit. U jističů: 1-pólový a 3-pólový jsou odlišné přístroje.

**Typ kabelu** — každé písmeno v označení má konkrétní technický význam:
- CYKY je PVC kabel, CXKH je bezhalogenový — úplně jiný materiál izolace, nelze zaměnit
- CY je drátový (tuhý) vodič, CYA je lanovaný (ohebný) vodič — jiná konstrukce
- Koncovka "-J" znamená s ochranným vodičem, "-O" bez ochranného vodiče — záměna může být nebezpečná
- CXKH-R je kulatý profil, CXKH-V je plochý — jiná geometrie

**Proud u jističů** — 16A je jiný jistič než 25A. Charakteristika B, C a D jsou různé typy — každá má jiný náběhový proud.

**Datové kabely** — UTP je nestíněný, FTP je stíněný. Počet párů musí sedět (5x2x0,8 má 5 párů, 2x2x0,8 má jen 2 páry). Jistič není pojistka — odlišný princip, nelze zaměnit.

## Kabely — jak vybrat správné balení

Pokud zákazník poptává v metrech, vyber balení, které dává smysl pro dané množství. Kruhy mají konkrétní délku (10m, 25m, 50m, 100m) — vyber NEJVĚTŠÍ kruh, jehož délka se vejde do poptaného množství beze zbytku (tzn. poptané množství děleno délkou kruhu je celé číslo). Pokud žádný kruh nevyhovuje, vyber BUBEN. Kruh, který je delší než poptané množství, je nevhodný (zákazník nechce platit za přebytečný materiál).

## Když najdeš více variant

Pokud najdeš více produktů, které se liší pouze v atributu, který zákazník nespecifikoval (například barva vodiče, typ bubnu, RAL kód), nastav matchType na "multiple" a selectedSku na null. V reasoning vysvětli, jaké varianty existují.

## Důležitá pravidla
- NIKDY si nevymýšlej SKU. Používej pouze kódy, které jsi dostal ve výsledcích vyhledávání.
- Pokud opravdu nic nenajdeš, nastav matchType na "not_found" — je lepší přiznat neúspěch než vybrat špatný produkt.
- Buď efektivní, obvykle stačí 2 až 4 volání nástrojů.
- VŽDY ukonči práci voláním submit_result.`;

// ── Helper: convert Responses API usage to CompletionUsage ─

function toCompletionUsage(usage: OpenAI.Responses.ResponseUsage | undefined): OpenAI.CompletionUsage | undefined {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  } as OpenAI.CompletionUsage;
}

// ── Main Variant C pipeline ───────────────────────────────

export async function runVariantC(
  tc: TestCase,
  tracker: TokenTracker,
): Promise<PipelineOutput> {
  const userMessage = `Poptávka: "${tc.demand}"
Množství: ${tc.quantity} ${tc.unit}
Najdi správný produkt v katalogu.`;

  let allCandidates: Array<{ sku: string; name: string }> = [];
  let finalResult: {
    selectedSku: string | null;
    matchType: string;
    confidence: number;
    reasoning: string;
    alternativeSkus?: string[];
  } | null = null;

  // First call
  let response = await openai.responses.create({
    model: MODEL,
    instructions: SYSTEM_PROMPT,
    input: userMessage,
    tools,
    reasoning: { effort: "low" },
  } as any);
  tracker.add(toCompletionUsage(response.usage));

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const functionCalls = response.output.filter(
      (item: any) => item.type === "function_call",
    ) as Array<{ type: "function_call"; call_id: string; name: string; arguments: string }>;

    if (functionCalls.length === 0) {
      if (!finalResult) {
        const textItem = response.output.find((item: any) => item.type === "message") as any;
        finalResult = {
          selectedSku: null,
          matchType: "not_found",
          confidence: 0,
          reasoning: textItem?.content?.[0]?.text ?? "Agent ukončil bez výsledku.",
        };
      }
      break;
    }

    const toolOutputs: Array<{ type: "function_call_output"; call_id: string; output: string }> = [];

    for (const fc of functionCalls) {
      const args = JSON.parse(fc.arguments);
      let result: string;

      switch (fc.name) {
        case "search_products": {
          result = await handleSearchProducts(args.query, args.manufacturer);
          try {
            const parsed = JSON.parse(result) as { products?: Array<{ sku: string; name: string }> };
            for (const p of parsed.products ?? []) {
              if (!allCandidates.some((c) => c.sku === p.sku)) {
                allCandidates.push({ sku: p.sku, name: p.name });
              }
            }
          } catch { /* ignore */ }
          break;
        }
        case "lookup_exact": {
          result = await handleLookupExact(args.code);
          try {
            const parsed = JSON.parse(result) as { products?: Array<{ sku: string; name: string }> };
            for (const p of parsed.products ?? []) {
              if (!allCandidates.some((c) => c.sku === p.sku)) {
                allCandidates.push({ sku: p.sku, name: p.name });
              }
            }
          } catch { /* ignore */ }
          break;
        }
        case "get_product_detail": {
          result = await handleGetProductDetail(args.sku);
          break;
        }
        case "submit_result": {
          finalResult = {
            selectedSku: args.selectedSku ?? null,
            matchType: args.matchType ?? "not_found",
            confidence: args.confidence ?? 0,
            reasoning: args.reasoning ?? "",
            alternativeSkus: args.alternativeSkus,
          };
          result = JSON.stringify({ status: "ok" });
          break;
        }
        default:
          result = JSON.stringify({ error: "Unknown tool" });
      }

      toolOutputs.push({ type: "function_call_output", call_id: fc.call_id, output: result });
    }

    if (finalResult) break;

    // Continue conversation with tool outputs
    response = await openai.responses.create({
      model: MODEL,
      previous_response_id: response.id,
      input: toolOutputs,
      tools,
      reasoning: { effort: "low" },
    } as any);
    tracker.add(toCompletionUsage(response.usage));
  }

  if (!finalResult) {
    finalResult = {
      selectedSku: null,
      matchType: "not_found",
      confidence: 0,
      reasoning: "Agent vyčerpal maximální počet kroků.",
    };
  }

  const selectedName = finalResult.selectedSku
    ? allCandidates.find((c) => c.sku === finalResult!.selectedSku)?.name ?? null
    : null;

  return {
    selectedSku: finalResult.selectedSku,
    selectedName,
    matchType: finalResult.matchType,
    confidence: finalResult.confidence,
    reasoning: finalResult.reasoning,
    candidates: allCandidates.slice(0, 5),
  };
}
