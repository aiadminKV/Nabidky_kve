import OpenAI from "openai";
import { env } from "../config/env.js";
import { generateQueryEmbedding } from "./embedding.js";
import {
  searchProductsSemantic,
  searchProductsFulltext,
  getCategoryTree,
  type SemanticResult,
  type CategoryTreeEntry,
  type ProductResult,
} from "./search.js";

const REFORMULATE_MODEL = "gpt-4.1";
const EVALUATE_MODEL = "gpt-4.1";
const MAX_RESULTS = 30;
const SIM_THRESHOLD = 0.35;
const REFINEMENT_CONFIDENCE = 60;
const MAX_REFINEMENTS = 2;

// ── Types ──────────────────────────────────────────────────

export interface ParsedItem {
  name: string;
  unit: string | null;
  quantity: number | null;
  instruction?: string | null;
}

export interface PipelineResult {
  position: number;
  originalName: string;
  unit: string | null;
  quantity: number | null;
  matchType: "match" | "uncertain" | "multiple" | "alternative" | "not_found";
  confidence: number;
  product: Partial<ProductResult> | null;
  candidates: Array<Partial<ProductResult>>;
  reasoning: string;
  reformulatedQuery: string;
  pipelineMs: number;
}

export type PipelineDebugFn = (entry: {
  position: number;
  step: string;
  data: unknown;
}) => void;

interface MergedCandidate extends SemanticResult {
  source: "raw" | "reformulated" | "fulltext" | "both";
}

interface EvalResult {
  matchType: "match" | "uncertain" | "multiple" | "alternative" | "not_found";
  confidence: number;
  selectedSku: string | null;
  candidates: string[];
  reasoning: string;
  refinement?: {
    action: "refine_search";
    query: string;
    subcategory: string | null;
    manufacturer: string | null;
  };
}

// ── Category Tree Cache ────────────────────────────────────

let cachedTree: CategoryTreeEntry[] | null = null;
let cachedAt = 0;
const CACHE_TTL = 60 * 60 * 1000;

export async function getCachedCategoryTree(): Promise<CategoryTreeEntry[]> {
  if (cachedTree && Date.now() - cachedAt < CACHE_TTL) return cachedTree;
  cachedTree = await getCategoryTree();
  cachedAt = Date.now();
  return cachedTree;
}

// ── OpenAI ─────────────────────────────────────────────────

function openai(): OpenAI {
  return new OpenAI({ apiKey: env.OPENAI_API_KEY });
}

// ── Step 1: LLM Reformulation ─────────────────────────────

const REFORM_PROMPT = `Přeformuluj název elektrotechnického produktu do nejpopisnější možné formy pro sémantické vyhledávání v českém B2B katalogu elektroinstalačního materiálu.

PRAVIDLA:
1. VŽDY přeformuluj — rozviň zkratky, přidej odborný kontext
2. Pokud zkratce NEROZUMÍŠ, ponech originální text — NIKDY nevymýšlej
3. Zachovej specifické kódy výrobce, SKU, EAN beze změny (přidej kontext vedle)

Vrať plain text — jen přeformulovaný název.`;

async function reformulate(name: string, instruction?: string | null): Promise<string> {
  const userContent = instruction
    ? `${name}\n\nDodatečný kontext: ${instruction}`
    : name;

  const res = await openai().chat.completions.create({
    model: REFORMULATE_MODEL,
    messages: [
      { role: "system", content: REFORM_PROMPT },
      { role: "user", content: userContent },
    ],
    temperature: 0.2,
    max_tokens: 200,
  });
  return res.choices[0]?.message?.content?.trim() ?? name;
}

// ── Step 4: Merge ──────────────────────────────────────────

function mergeResults(
  raw: SemanticResult[],
  ref: SemanticResult[],
): MergedCandidate[] {
  const map = new Map<string, MergedCandidate>();

  for (const r of raw) {
    map.set(r.sku, { ...r, source: "raw" });
  }

  for (const r of ref) {
    const existing = map.get(r.sku);
    if (existing) {
      if (r.cosine_similarity > existing.cosine_similarity) {
        existing.cosine_similarity = r.cosine_similarity;
      }
      existing.source = "both";
    } else {
      map.set(r.sku, { ...r, source: "reformulated" });
    }
  }

  return [...map.values()].sort(
    (a, b) => b.cosine_similarity - a.cosine_similarity,
  );
}

function mergeWithExisting(
  existing: MergedCandidate[],
  fresh: MergedCandidate[],
): MergedCandidate[] {
  const map = new Map<string, MergedCandidate>();
  for (const c of existing) map.set(c.sku, c);

  for (const c of fresh) {
    const ex = map.get(c.sku);
    if (ex) {
      ex.cosine_similarity = Math.max(
        ex.cosine_similarity,
        c.cosine_similarity,
      );
    } else {
      map.set(c.sku, c);
    }
  }

  return [...map.values()].sort(
    (a, b) => b.cosine_similarity - a.cosine_similarity,
  );
}

// ── Fulltext → MergedCandidate conversion ─────────────────

function fulltextToMerged(results: ProductResult[]): MergedCandidate[] {
  return results.map((r) => ({
    id: r.id,
    sku: r.sku,
    name: r.name,
    name_secondary: r.name_secondary,
    unit: r.unit,
    price: r.price,
    ean: r.ean,
    manufacturer_code: r.manufacturer_code,
    manufacturer: r.manufacturer,
    category: r.category,
    subcategory: r.subcategory,
    sub_subcategory: r.sub_subcategory,
    eshop_url: r.eshop_url,
    cosine_similarity: 0.5 + Math.max(r.rank ?? 0, r.similarity_score ?? 0) * 0.3,
    source: "fulltext" as const,
  }));
}

// ── Step 5: AI Evaluation ──────────────────────────────────

const EVAL_PROMPT = `Jsi hodnotitel výsledků vyhledávání v B2B katalogu elektroinstalačního materiálu (KV Elektro, ~470K položek).

Dostaneš originální název produktu z poptávky a seznam kandidátů z vyhledávání.

## Tvůj úkol
Vyhodnoť, zda některý kandidát odpovídá hledanému produktu.

## Jak hodnotit
1. **Název produktu je klíčový** — pokud název kandidáta obsahuje stejné klíčové slovo jako poptávka (např. "CY 10" v "VODIC CY 10 HNEDA"), je to silný signál přesné shody. Neignoruj to.
2. **Technické parametry** — proud (A), póly (P), napětí (V), IP krytí, průřez (mm²), wattáž (W)
3. **Subcategorie** — odpovídá typ produktu očekávání?
4. **source: "fulltext"** = nalezeno přes textovou shodu klíčových slov — silný signál, že jde o přesný produkt
5. **Blízké parametry jsou OK** — pokud poptávka říká "23.1W" a katalog má "24W" nebo "25W", je to relevantní alternativa, NE not_found

## DŮLEŽITÉ — správné použití matchType

- **not_found** = v kandidátech NENÍ NIC relevantního. Žádný kandidát se ani vzdáleně netýká hledaného produktu. NEPOUŽÍVEJ not_found jen proto, že dotaz je obecný (např. "Svorka WAGO" — to je "multiple", ne "not_found").
- **multiple** = existuje VÍCE vhodných kandidátů stejného typu a nelze bez dalšího upřesnění vybrat jeden (např. "Svorka WAGO" → stovky variant, "Vypínač řazení 6" → desítky variant od různých výrobců). Vyber libovolného top kandidáta jako selectedSku.
- **match** = jsem si jistý, že kandidát odpovídá poptávce (confidence 85-100)
- **uncertain** = pravděpodobně správný, ale ne 100% (confidence 60-84)
- **alternative** = není přesná shoda, ale nabízím nejbližší alternativu (confidence 30-59)

## Formát odpovědi
Vrať VÝHRADNĚ JSON:
{
  "matchType": "match" | "uncertain" | "multiple" | "alternative" | "not_found",
  "confidence": 0-100,
  "selectedSku": "SKU vybraného produktu nebo null",
  "candidates": ["SKU1", "SKU2", ...],
  "reasoning": "Stručné zdůvodnění (1 věta česky)"
}

Pokud confidence < 60, přidej pole "refinement":
{
  "refinement": {
    "action": "refine_search",
    "query": "upřesněný dotaz pro embedding",
    "subcategory": "subcategorie z dostupného stromu kategorií, nebo null",
    "manufacturer": "výrobce pro filtr nebo null"
  }
}

### candidates: max 5 SKU kódů top kandidátů. VŽDY uveď alespoň top kandidáty, i při not_found.`;

function buildMetadata(candidates: MergedCandidate[]) {
  const subDist: Record<string, number> = {};
  const mfrDist: Record<string, number> = {};

  for (const c of candidates) {
    const key = c.subcategory ?? c.category ?? "unknown";
    subDist[key] = (subDist[key] ?? 0) + 1;
    if (c.manufacturer) {
      mfrDist[c.manufacturer] = (mfrDist[c.manufacturer] ?? 0) + 1;
    }
  }

  return {
    totalCandidates: candidates.length,
    topSimilarity: candidates[0]?.cosine_similarity ?? 0,
    sim10th:
      candidates[Math.min(9, candidates.length - 1)]?.cosine_similarity ?? 0,
    sim30th:
      candidates[Math.min(29, candidates.length - 1)]?.cosine_similarity ?? 0,
    subcategoryDistribution: subDist,
    manufacturerDistribution: mfrDist,
  };
}

async function evaluate(
  originalName: string,
  candidates: MergedCandidate[],
  categoryTree?: CategoryTreeEntry[],
  instruction?: string | null,
): Promise<EvalResult> {
  if (candidates.length === 0) {
    return {
      matchType: "not_found",
      confidence: 0,
      selectedSku: null,
      candidates: [],
      reasoning: "Žádní kandidáti nalezeni.",
    };
  }

  const meta = buildMetadata(candidates);
  const top20 = candidates.slice(0, 20).map((c) => ({
    sku: c.sku,
    name: c.name,
    manufacturer_code: c.manufacturer_code,
    manufacturer: c.manufacturer,
    subcategory: c.subcategory,
    sub_subcategory: c.sub_subcategory,
    similarity: Math.round(c.cosine_similarity * 1000) / 1000,
    source: c.source,
  }));

  const payload: Record<string, unknown> = {
    originalName,
    ...meta,
    candidates: top20,
  };

  if (instruction) {
    payload.instruction = instruction;
  }

  if (categoryTree) {
    const compactTree = [...new Set(categoryTree.map((e) => e.subcategory))];
    payload.availableSubcategories = compactTree;
  }

  const res = await openai().chat.completions.create({
    model: EVALUATE_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: EVAL_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ],
    temperature: 0.1,
    max_tokens: 500,
  });

  const content = res.choices[0]?.message?.content;
  if (!content) {
    return {
      matchType: "not_found",
      confidence: 0,
      selectedSku: null,
      candidates: [],
      reasoning: "AI evaluace selhala.",
    };
  }

  try {
    const p = JSON.parse(content) as EvalResult;
    return {
      matchType: p.matchType ?? "not_found",
      confidence: Math.min(100, Math.max(0, p.confidence ?? 0)),
      selectedSku: p.selectedSku ?? null,
      candidates: (p.candidates ?? []).slice(0, 5),
      reasoning: p.reasoning ?? "",
      refinement: p.refinement,
    };
  } catch {
    return {
      matchType: "not_found",
      confidence: 0,
      selectedSku: null,
      candidates: [],
      reasoning: "Nepodařilo se zparsovat AI odpověď.",
    };
  }
}

// ── Helpers ────────────────────────────────────────────────

function slimCandidate(c: MergedCandidate): Partial<ProductResult> {
  return {
    id: c.id,
    sku: c.sku,
    name: c.name,
    name_secondary: c.name_secondary,
    manufacturer_code: c.manufacturer_code,
    manufacturer: c.manufacturer,
    category: c.category,
    unit: c.unit,
    ean: c.ean,
    price: c.price,
    subcategory: c.subcategory,
    sub_subcategory: c.sub_subcategory,
    eshop_url: c.eshop_url,
  };
}

// ── Main Pipeline ──────────────────────────────────────────

export async function searchPipelineForItem(
  item: ParsedItem,
  position: number,
  onDebug?: PipelineDebugFn,
): Promise<PipelineResult> {
  const t0 = Date.now();

  try {
    // Step 1: LLM Reformulation
    const reformulated = await reformulate(item.name, item.instruction);
    onDebug?.({
      position,
      step: "reformulation",
      data: { original: item.name, reformulated },
    });

    // Step 2: Dual embedding + fulltext (all 3 parallel, fulltext is non-fatal)
    const fulltextPromise = searchProductsFulltext(item.name, MAX_RESULTS).catch(() => [] as ProductResult[]);
    const [rawEmb, refEmb, fulltextResults] = await Promise.all([
      generateQueryEmbedding(item.name),
      generateQueryEmbedding(reformulated),
      fulltextPromise,
    ]);
    onDebug?.({
      position,
      step: "embedding",
      data: { done: true, fulltextCount: fulltextResults.length },
    });

    // Step 3: Dual semantic search (parallel)
    const [rawResults, refResults] = await Promise.all([
      searchProductsSemantic(rawEmb, MAX_RESULTS, SIM_THRESHOLD),
      searchProductsSemantic(refEmb, MAX_RESULTS, SIM_THRESHOLD),
    ]);
    onDebug?.({
      position,
      step: "search",
      data: {
        rawCount: rawResults.length,
        refCount: refResults.length,
        fulltextCount: fulltextResults.length,
        rawTopSim: rawResults[0]?.cosine_similarity ?? 0,
        refTopSim: refResults[0]?.cosine_similarity ?? 0,
      },
    });

    // Step 4: Triple merge (semantic raw + semantic reformulated + fulltext)
    let merged = mergeResults(rawResults, refResults);
    const fulltextMerged = fulltextToMerged(fulltextResults);
    merged = mergeWithExisting(merged, fulltextMerged);
    onDebug?.({
      position,
      step: "merge",
      data: {
        total: merged.length,
        top3: merged.slice(0, 3).map((c) => ({
          sku: c.sku,
          name: c.name,
          sim: Math.round(c.cosine_similarity * 1000) / 1000,
          src: c.source,
        })),
      },
    });

    // Step 5: AI Evaluation
    let evalResult = await evaluate(item.name, merged, undefined, item.instruction);
    onDebug?.({
      position,
      step: "evaluation",
      data: {
        matchType: evalResult.matchType,
        confidence: evalResult.confidence,
        selectedSku: evalResult.selectedSku,
        reasoning: evalResult.reasoning,
      },
    });

    // Step 6: Refinement loop (max MAX_REFINEMENTS attempts if confidence < 60)
    let categoryTree: CategoryTreeEntry[] | undefined;
    let attempts = 0;
    while (
      evalResult.refinement &&
      evalResult.confidence < REFINEMENT_CONFIDENCE &&
      attempts < MAX_REFINEMENTS
    ) {
      attempts++;
      if (!categoryTree) {
        try {
          categoryTree = await getCachedCategoryTree();
        } catch {
          categoryTree = undefined;
        }
      }
      const ref = evalResult.refinement;
      onDebug?.({
        position,
        step: "refinement",
        data: { attempt: attempts, ...ref },
      });

      const refinedEmb = await generateQueryEmbedding(ref.query);
      const refinedResults = await searchProductsSemantic(
        refinedEmb,
        MAX_RESULTS,
        SIM_THRESHOLD,
        undefined,
        ref.manufacturer ?? undefined,
        ref.subcategory ?? undefined,
      );

      const fresh: MergedCandidate[] = refinedResults.map((r) => ({
        ...r,
        source: "reformulated" as const,
      }));
      merged = mergeWithExisting(merged, fresh);

      evalResult = await evaluate(item.name, merged, categoryTree, item.instruction);
      onDebug?.({
        position,
        step: "refinement_eval",
        data: {
          attempt: attempts,
          matchType: evalResult.matchType,
          confidence: evalResult.confidence,
          selectedSku: evalResult.selectedSku,
        },
      });
    }

    // Build final result
    const selected = evalResult.selectedSku
      ? merged.find((c) => c.sku === evalResult.selectedSku) ?? null
      : null;

    const candSkus = new Set(evalResult.candidates);
    const topCands = evalResult.candidates
      .map((sku) => merged.find((c) => c.sku === sku))
      .filter((c): c is MergedCandidate => c != null);

    for (const c of merged) {
      if (topCands.length >= 5) break;
      if (!candSkus.has(c.sku)) {
        topCands.push(c);
        candSkus.add(c.sku);
      }
    }

    const pipelineMs = Date.now() - t0;
    onDebug?.({
      position,
      step: "done",
      data: {
        matchType: evalResult.matchType,
        confidence: evalResult.confidence,
        pipelineMs,
        refinementAttempts: attempts,
      },
    });

    return {
      position,
      originalName: item.name,
      unit: item.unit,
      quantity: item.quantity,
      matchType: evalResult.matchType,
      confidence: evalResult.confidence,
      product: selected ? slimCandidate(selected) : null,
      candidates: topCands.slice(0, 5).map(slimCandidate),
      reasoning: evalResult.reasoning,
      reformulatedQuery: reformulated,
      pipelineMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Pipeline failed";
    onDebug?.({ position, step: "error", data: { error: msg } });

    return {
      position,
      originalName: item.name,
      unit: item.unit,
      quantity: item.quantity,
      matchType: "not_found",
      confidence: 0,
      product: null,
      candidates: [],
      reasoning: `Pipeline error: ${msg}`,
      reformulatedQuery: "",
      pipelineMs: Date.now() - t0,
    };
  }
}
