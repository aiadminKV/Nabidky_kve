/**
 * pipeline-variant-a.ts
 * Variant A: Merged MATCHER+SELECTOR into a single LLM call.
 * Retrieval stays the same (existing pipeline functions).
 * Selection is done by one combined prompt.
 */

import OpenAI from "openai";
import { env } from "../config/env.js";
import { generateQueryEmbedding } from "../services/embedding.js";
import {
  searchProductsSemantic,
  searchProductsFulltext,
  lookupProductsExact,
  type SemanticResult,
  type FulltextResult,
  type ExactResult,
  type ProductResult,
} from "../services/search.js";
import type { TestCase } from "./pipeline-test-data.js";
import type { PipelineOutput, TokenUsage } from "./pipeline-eval-framework.js";
import { TokenTracker } from "./pipeline-eval-framework.js";

const MODEL = "gpt-5.4-mini";
const MAX_RESULTS_FULLTEXT = 30;
const MAX_RESULTS_SEMANTIC = 50;
const SIM_THRESHOLD = 0.35;

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ── Merged prompt ─────────────────────────────────────────

const MERGED_PROMPT = `Jsi expert na párování a výběr elektroinstalačních produktů z B2B katalogu. Dostaneš poptávku zákazníka a seznam kandidátů z katalogu.

Tvůj úkol probíhá ve 2 krocích (v jedné odpovědi):

## KROK 1: Filtrování — vyřaď produkty, které technicky nesedí

Projdi KAŽDÉHO kandidáta a vyhodnoť, zda odpovídá poptávce TYPEM a PARAMETRY.

### Kandidát nalezený přes kód (foundByExactCode je true)
Pokud kandidát má v datech příznak foundByExactCode nastavený na true, znamená to, že byl nalezen přesnou shodou kódu, EAN nebo SKU. Takového kandidáta VŽDY zařaď do shortlistu s matchScore 97. Nemusíš kontrolovat název — kód je důkaz identity.

### Tvrdé parametry — pokud nesedí, kandidát VYPADÁVÁ
Tyto parametry jsou bezpečnostně kritické a musí přesně odpovídat poptávce. Přečti je z názvu kandidáta jako čísla a porovnej s tím, co požaduje poptávka.

**Průřez vodiče nebo kabelu:**
Průřez je číslo za znakem "×" nebo "x", například "5x1,5" znamená 5 žil o průřezu 1,5 mm². Kandidát s průřezem 95 mm² NENÍ totéž co poptávka na 1,5 mm². Stejně tak 2,5 mm² není 4 mm². Každý rozdíl v průřezu = kandidát nesplňuje.

**Počet žil nebo pólů:**
Číslo před znakem "×" nebo "x" udává počet žil. Kabel "3x2,5" má 3 žíly, kabel "5x2,5" má 5 žil — to jsou úplně jiné produkty. Stejně u jističů: 1-pólový je jiný přístroj než 3-pólový.

**Typ kabelu — každé písmeno má význam:**
CYKY je PVC kabel. CXKH je bezhalogenový kabel — to jsou různé materiály, NELZE zaměnit. CY je vodič drátový (tuhý), CYA je vodič lanovaný (ohebný) — jsou to odlišné produkty. Koncovka "-J" znamená s ochranným vodičem, "-O" znamená bez — záměna může být nebezpečná. CXKH-R je kulatý profil, CXKH-V je plochý — jiná konstrukce.

**Další kritické parametry:**
Třída odolnosti trubky (320N je jiná než 720N — různá mechanická odolnost). Počet párů u datových kabelů (5x2x0,8 má 5 párů, 2x2x0,8 má jen 2 páry). UTP je nestíněný datový kabel, FTP je stíněný — jiná kategorie. Jistič není pojistka — to jsou zcela odlišné přístroje s jiným principem.

### Kabely a vodiče — měrné jednotky
Pokud zákazník poptává v metrech, tak kandidát musí být prodáván v metrech nebo balení s délkou. Povolené jsou: položky s konkrétní délkou v názvu (např. "KRUH 100M"), položky s označením "BUBEN" a položky kde katalogová jednotka je "m". Zakázané jsou položky v kusech ("ks") bez uvedené délky v názvu.

## KROK 2: Výběr — ze shortlistu vyber nejlepší variantu

### Priorita výběru (od nejvyšší)
1. Kandidát nalezený přes kód (foundByExactCode true) — vždy ho vyber, confidence 99
2. Pokud je zadaný preferovaný výrobce nebo řada, preferuj ho, ale jen pokud cenový rozdíl je přijatelný
3. Produkt skladem (has_stock je true) — silně preferuj
4. Standardní skladová položka (is_stock_item je true) — mírný bonus
5. Při jinak rovných volbách preferuj nižší cenu

### Kabely — jak vybrat mezi KRUH a BUBEN
Pokud zákazník poptává v metrech a ve shortlistu jsou jak kruhy (s konkrétní délkou), tak bubny:
Nejdřív odstraň kruhy, jejichž délka je VĚTŠÍ než poptané množství (kruh 100m pro poptávku 50m je příliš velký). Ze zbylých kruhů ověř, zda se poptané množství dá vydělit délkou kruhu beze zbytku — pokud ano, kruh je vhodný. Z vhodných kruhů vyber ten NEJVĚTŠÍ (minimalizuje počet balení). Pokud žádný kruh nevyhovuje, vyber BUBEN.

### Více variant bez specifikace
Pokud ve shortlistu zůstane více kandidátů, kteří se liší POUZE v atributu, který zákazník v poptávce nespecifikoval (například barva, typ balení BUBEN vs BUBEN NEVRATNÝ, přesná délka), nastav matchType na "multiple", selectedSku na null a confidence na 0. V reasoning vysvětli, jaké varianty existují a v čem se liší.

## Odpověď
Vrať VÝHRADNĚ JSON:
{
  "shortlist": [
    { "sku": "...", "matchScore": 95, "reasoning": "1 věta" }
  ],
  "selectedSku": "SKU nebo null",
  "matchType": "match" | "uncertain" | "multiple" | "not_found",
  "confidence": 0-100,
  "reasoning": "1-2 věty česky — co prošlo filtrem a proč vybrán tento"
}`;

// ── Reformulation prompt (simplified, reused) ─────────────

const REFORM_PROMPT = `Přeformuluj název elektrotechnického produktu do formy pro B2B katalog elektroinstalace.
Rozviň zkratky, přidej alternativní názvy, v katalogu mají kabely prefix "1-" (1-CYKY-J, 1-CXKH-R-J).
Vodiče: H07V-U (drátový=CY), H07V-K (lanovaný=CYA). Používej × místo x u průřezů.
Vrať plain text — jen přeformulovaný název.`;

// ── Retrieval (reuses existing DB functions) ──────────────

interface MergedCandidate extends ProductResult {
  cosine_similarity: number;
  source: "raw" | "reformulated" | "fulltext" | "exact" | "both";
}

function mergeResults(raw: SemanticResult[], ref: SemanticResult[]): MergedCandidate[] {
  const map = new Map<string, MergedCandidate>();
  for (const r of raw) map.set(r.sku, { ...r, source: "raw" });
  for (const r of ref) {
    const ex = map.get(r.sku);
    if (ex) {
      if (r.cosine_similarity > ex.cosine_similarity) ex.cosine_similarity = r.cosine_similarity;
      ex.source = "both";
    } else {
      map.set(r.sku, { ...r, source: "reformulated" });
    }
  }
  return [...map.values()].sort((a, b) => b.cosine_similarity - a.cosine_similarity);
}

function mergeWithExisting(existing: MergedCandidate[], fresh: MergedCandidate[]): MergedCandidate[] {
  const map = new Map<string, MergedCandidate>();
  for (const c of existing) map.set(c.sku, c);
  for (const c of fresh) {
    const ex = map.get(c.sku);
    if (ex) {
      ex.cosine_similarity = Math.max(ex.cosine_similarity, c.cosine_similarity);
      if (c.source === "exact") ex.source = "exact";
    } else {
      map.set(c.sku, c);
    }
  }
  return [...map.values()].sort((a, b) => b.cosine_similarity - a.cosine_similarity);
}

function fulltextToMerged(results: FulltextResult[]): MergedCandidate[] {
  return results.map((r) => ({
    ...r,
    cosine_similarity: 0.5 + Math.max(r.rank ?? 0, r.similarity_score ?? 0) * 0.3,
    source: "fulltext" as const,
  }));
}

const EXACT_COSINE: Record<string, number> = {
  sku_exact: 1.0, ean_exact: 0.98, idnlf_exact: 0.98,
  idnlf_normalized: 0.97, ean_contains: 0.90, idnlf_contains: 0.90,
};

function exactToMerged(results: ExactResult[]): MergedCandidate[] {
  return results.map((r) => ({
    ...r,
    cosine_similarity: EXACT_COSINE[r.match_type] ?? 0.95,
    source: "exact" as const,
  }));
}

function normalizeQuery(raw: string): string {
  let q = raw;
  q = q.replace(/×/g, "x");
  q = q.replace(/[\u2013\u2014]/g, "-");
  q = q.replace(/(\d)\s*mm[²2]/gi, "$1");
  q = q.replace(/\s+/g, " ").trim();
  return q;
}

// ── Main Variant A pipeline ───────────────────────────────

export async function runVariantA(
  tc: TestCase,
  tracker: TokenTracker,
): Promise<PipelineOutput> {
  const normalizedName = normalizeQuery(tc.demand);

  // Step 1: Reformulation (1 LLM call)
  const reformRes = await openai.chat.completions.create({
    model: MODEL,
    reasoning_effort: "low",
    messages: [
      { role: "system", content: REFORM_PROMPT },
      { role: "user", content: normalizedName },
    ],
  } as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming);
  tracker.add(reformRes.usage);
  const reformulated = reformRes.choices[0]?.message?.content?.trim() ?? normalizedName;

  // Step 2: Code extraction (1 LLM call)
  const codeRes = await openai.chat.completions.create({
    model: MODEL,
    reasoning_effort: "low",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `Z textu poptávky extrahuj kódy produktů (katalogová/objednací čísla, EAN). NE parametry (16A, 3x1,5, IP44). Vrať JSON: {"codes": ["KÓD1"]}` },
      { role: "user", content: normalizedName },
    ],
  } as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming);
  tracker.add(codeRes.usage);
  let extractedCodes: string[] = [];
  try {
    const parsed = JSON.parse(codeRes.choices[0]?.message?.content ?? "{}") as { codes?: string[] };
    extractedCodes = (parsed.codes ?? []).filter((c) => typeof c === "string" && c.length >= 4);
  } catch { /* ignore */ }

  // Step 3: Parallel retrieval (no LLM calls — embedding + DB)
  const [rawEmb, refEmb] = await Promise.all([
    generateQueryEmbedding(normalizedName),
    generateQueryEmbedding(reformulated),
  ]);

  const ftOriginal = searchProductsFulltext(normalizedName, MAX_RESULTS_FULLTEXT).catch(() => [] as FulltextResult[]);
  const ftReform = searchProductsFulltext(reformulated, MAX_RESULTS_FULLTEXT).catch(() => [] as FulltextResult[]);
  const exactPromise = lookupProductsExact(normalizedName, 10).catch(() => [] as ExactResult[]);
  const extraExactPromises = extractedCodes.map((code) =>
    lookupProductsExact(code, 3).catch(() => [] as ExactResult[]),
  );

  const [rawResults, refResults, ftOrig, ftRef, exactResults, ...extraExactArr] = await Promise.all([
    searchProductsSemantic(rawEmb, MAX_RESULTS_SEMANTIC, SIM_THRESHOLD),
    searchProductsSemantic(refEmb, MAX_RESULTS_SEMANTIC, SIM_THRESHOLD),
    ftOriginal,
    ftReform,
    exactPromise,
    ...extraExactPromises,
  ]);
  const extraExactResults: ExactResult[] = extraExactArr.flat();

  const ftMap = new Map<string, FulltextResult>();
  for (const r of ftOrig) ftMap.set(r.sku, r);
  for (const r of ftRef) {
    const ex = ftMap.get(r.sku);
    if (!ex || (r.rank ?? 0) > (ex.rank ?? 0)) ftMap.set(r.sku, r);
  }
  const fulltextResults = [...ftMap.values()];

  let merged = mergeResults(rawResults, refResults);
  merged = mergeWithExisting(merged, fulltextToMerged(fulltextResults));
  merged = mergeWithExisting(merged, exactToMerged(exactResults));
  if (extraExactResults.length > 0) {
    merged = mergeWithExisting(merged, exactToMerged(extraExactResults));
  }

  // Step 4: MERGED AGENT — single LLM call for matching + selection
  const top60 = merged.slice(0, 60).map((c) => {
    const item: Record<string, unknown> = {
      sku: c.sku,
      name: c.name,
      unit: c.unit,
      category_sub: c.category_sub,
      similarity: Math.round(c.cosine_similarity * 1000) / 1000,
      source: c.source,
      foundByExactCode: c.source === "exact",
      current_price: c.current_price,
      is_stock_item: c.is_stock_item,
      has_stock: c.has_stock,
    };
    if (c.description && c.description.trim().length > 5) {
      item.description = c.description.slice(0, 200);
    }
    return item;
  });

  const payload = {
    originalName: tc.demand,
    demandUnit: tc.unit,
    demandQuantity: tc.quantity,
    candidates: top60,
  };

  const mergedRes = await openai.chat.completions.create({
    model: MODEL,
    reasoning_effort: "low",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: MERGED_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ],
  } as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming);
  tracker.add(mergedRes.usage);

  const content = mergedRes.choices[0]?.message?.content;
  if (!content) {
    return {
      selectedSku: null, selectedName: null, matchType: "not_found",
      confidence: 0, reasoning: "AI merged agent selhala.",
      candidates: merged.slice(0, 5).map((c) => ({ sku: c.sku, name: c.name })),
    };
  }

  try {
    const p = JSON.parse(content) as {
      selectedSku?: string | null;
      matchType?: string;
      confidence?: number;
      reasoning?: string;
      shortlist?: Array<{ sku: string; matchScore?: number; reasoning?: string }>;
    };

    const selectedSku = p.selectedSku ?? null;
    const selected = selectedSku ? merged.find((c) => c.sku === selectedSku) : null;

    const candidateSkus = new Set<string>();
    const candidateList: Array<{ sku: string; name: string }> = [];
    for (const s of p.shortlist ?? []) {
      if (!candidateSkus.has(s.sku)) {
        const c = merged.find((m) => m.sku === s.sku);
        if (c) candidateList.push({ sku: c.sku, name: c.name });
        candidateSkus.add(s.sku);
      }
    }
    for (const c of merged) {
      if (candidateList.length >= 5) break;
      if (!candidateSkus.has(c.sku)) {
        candidateList.push({ sku: c.sku, name: c.name });
        candidateSkus.add(c.sku);
      }
    }

    return {
      selectedSku,
      selectedName: selected?.name ?? null,
      matchType: p.matchType ?? "not_found",
      confidence: p.confidence ?? 0,
      reasoning: p.reasoning ?? "",
      candidates: candidateList.slice(0, 5),
    };
  } catch {
    return {
      selectedSku: null, selectedName: null, matchType: "not_found",
      confidence: 0, reasoning: "Parse error.",
      candidates: merged.slice(0, 5).map((c) => ({ sku: c.sku, name: c.name })),
    };
  }
}
