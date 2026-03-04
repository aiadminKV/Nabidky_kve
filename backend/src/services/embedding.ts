import OpenAI from "openai";
import { getAdminClient } from "./supabase.js";
import { env } from "../config/env.js";

export const EMBEDDING_MODEL = "text-embedding-3-large";
export const EMBEDDING_DIMENSIONS = 1536;
const EMBED_BATCH_SIZE = 100;
const CLEAN_BATCH_SIZE = 20;
const DESC_CLEAN_THRESHOLD = 150;
const DESC_MAX_LENGTH = 500;
const DELAY_BETWEEN_BATCHES_MS = 300;
const CLEAN_MODEL = "gpt-4.1-mini";

export type EmbeddingProgressCallback = (event: {
  type: string;
  data: Record<string, unknown>;
}) => Promise<void>;

export interface ProductForEmbedding {
  id: string;
  sku: string;
  name: string;
  name_secondary: string | null;
  description: string | null;
  manufacturer_code: string | null;
  manufacturer: string | null;
  category: string | null;
  subcategory: string | null;
  sub_subcategory: string | null;
}

interface ProductWithDescription {
  sku: string;
  name: string;
  description: string;
}

const CLEAN_SYSTEM_PROMPT = `Vyčisti technické popisy produktů z elektrotechnického katalogu.

Pravidla:
- Zachovej POUZE: technické parametry, rozměry, funkce, kompatibilitu, materiál, normy
- Odstraň: marketing, popisy firem ("O společnosti..."), cross-selling ("V naší nabídce..."), doporučení, SEO text, obecné fráze
- Pokud popis neobsahuje žádné tech. info, vrať ""
- Max 500 znaků na popis
- Zachovej odborné termíny a čísla přesně

Příklady:

Vstup: "Mechanické blokování ABB VM4 je kvalitní příslušenství pro elektroinstalace. Umožňuje blokování vypínače, zabraňuje nechtěnému spuštění. Kompatibilní s ABB řady Tmax XT a Tmax T. Snadno montovatelné. Shrnutí a doporučení produktu... O společnosti ABB ABB je švédsko-švýcarská korporace..."
Výstup: "Mechanické blokování pro vypínače ABB řady Tmax XT a Tmax T. Zabraňuje nechtěnému spuštění. Snadno montovatelné a demontovatelné."

Vstup: "LED driver AC/DC transformátor. POZOR! Při záměně driverů může dojít k poškození svítidel. Součet příkonů napájených žárovek musí být min. o 20% menší než příkon driveru. Podívejte se na kompletní sortiment výrobků na našem e-shopu."
Výstup: "LED driver AC/DC. Při záměně driverů může dojít k poškození svítidel. Součet příkonů napájených žárovek musí být min. o 20% menší než příkon driveru."

Vrať JSON: {"items": [{"sku": "...", "description": "..."}]}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build structured text optimized for embedding.
 *
 * Format prioritizes product identity (name first), then manufacturer
 * context, category hierarchy, and technical description.
 */
export function buildEmbeddingText(p: ProductForEmbedding): string {
  const lines: string[] = [p.name];

  if (p.name_secondary) {
    lines.push(p.name_secondary);
  }

  const mfrParts = [
    p.manufacturer ? `Výrobce: ${p.manufacturer}` : null,
    p.manufacturer_code ? `Kód: ${p.manufacturer_code}` : null,
  ].filter(Boolean);
  if (mfrParts.length > 0) lines.push(mfrParts.join(" | "));

  const cats = [p.category, p.subcategory, p.sub_subcategory].filter(Boolean);
  if (cats.length > 0) {
    lines.push(`Kategorie: ${cats.join(" > ")}`);
  }

  if (p.description) {
    lines.push(`Popis: ${p.description.slice(0, DESC_MAX_LENGTH)}`);
  }

  return lines.join("\n");
}

function getOpenAIClient(): OpenAI {
  return new OpenAI({ apiKey: env.OPENAI_API_KEY });
}

/**
 * Clean product descriptions using GPT-4.1-mini.
 *
 * Strips marketing/SEO text, keeps only technical specs.
 * Descriptions shorter than DESC_CLEAN_THRESHOLD pass through unchanged.
 * Processes in batches of CLEAN_BATCH_SIZE for cost efficiency.
 */
export async function cleanDescriptionsBatch(
  products: ProductWithDescription[],
  onProgress?: EmbeddingProgressCallback,
): Promise<Map<string, string>> {
  const openai = getOpenAIClient();
  const result = new Map<string, string>();

  const toClean = products.filter(
    (p) => p.description.length > DESC_CLEAN_THRESHOLD,
  );
  const noClean = products.filter(
    (p) => p.description.length <= DESC_CLEAN_THRESHOLD,
  );

  for (const p of noClean) {
    result.set(p.sku, p.description);
  }

  let cleaned = 0;

  for (let i = 0; i < toClean.length; i += CLEAN_BATCH_SIZE) {
    const batch = toClean.slice(i, i + CLEAN_BATCH_SIZE);

    const userMessage = JSON.stringify(
      batch.map((p) => ({
        sku: p.sku,
        name: p.name,
        description: p.description.slice(0, 2000),
      })),
    );

    try {
      const response = await openai.chat.completions.create({
        model: CLEAN_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: CLEAN_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: CLEAN_BATCH_SIZE * 200,
      });

      const content = response.choices[0]?.message?.content;
      if (content) {
        const parsed = JSON.parse(content);
        for (const item of parsed.items ?? []) {
          if (item.sku && typeof item.description === "string") {
            result.set(item.sku, item.description.slice(0, DESC_MAX_LENGTH));
          }
        }
      }

      // Fill in any products the model missed with truncated fallback
      for (const p of batch) {
        if (!result.has(p.sku)) {
          result.set(p.sku, p.description.slice(0, DESC_MAX_LENGTH));
        }
      }
    } catch {
      for (const p of batch) {
        result.set(p.sku, p.description.slice(0, DESC_MAX_LENGTH));
      }
    }

    cleaned += batch.length;

    if (onProgress) {
      await onProgress({
        type: "clean_progress",
        data: {
          cleaned,
          total: toClean.length,
          skipped: noClean.length,
          percent: Math.round((cleaned / toClean.length) * 100),
        },
      });
    }

    if (i + CLEAN_BATCH_SIZE < toClean.length) {
      await sleep(200);
    }
  }

  return result;
}

/**
 * Apply cleaned descriptions to a products array in-place.
 *
 * Only products with non-null descriptions are sent for cleaning.
 * Returns the number of descriptions that were cleaned.
 */
export async function cleanProductDescriptions(
  products: Array<{ sku: string; name: string; description: string | null }>,
  onProgress?: EmbeddingProgressCallback,
): Promise<number> {
  const withDesc: ProductWithDescription[] = products
    .filter((p): p is typeof p & { description: string } =>
      p.description !== null && p.description.trim().length > 0,
    )
    .map((p) => ({ sku: p.sku, name: p.name, description: p.description }));

  if (withDesc.length === 0) return 0;

  if (onProgress) {
    await onProgress({
      type: "clean_start",
      data: { total: withDesc.length },
    });
  }

  const cleaned = await cleanDescriptionsBatch(withDesc, onProgress);

  let applied = 0;
  for (const product of products) {
    const cleanedDesc = cleaned.get(product.sku);
    if (cleanedDesc !== undefined && cleanedDesc !== product.description) {
      product.description = cleanedDesc || null;
      applied++;
    }
  }

  return applied;
}

/**
 * Generate embeddings for all products where embedding IS NULL.
 *
 * Fetches products in batches, builds embedding text, calls OpenAI,
 * and stores the result. Rate-limit aware with exponential backoff.
 */
export async function generateEmbeddingsForProducts(
  onProgress?: EmbeddingProgressCallback,
): Promise<{ processed: number; errors: number }> {
  const supabase = getAdminClient();
  const openai = getOpenAIClient();

  let totalProcessed = 0;
  let totalErrors = 0;

  const { count } = await supabase
    .from("products")
    .select("*", { count: "exact", head: true })
    .is("embedding", null);

  const totalToProcess = count ?? 0;

  if (onProgress) {
    await onProgress({
      type: "embedding_start",
      data: { total: totalToProcess },
    });
  }

  if (totalToProcess === 0) {
    return { processed: 0, errors: 0 };
  }

  while (true) {
    const { data: products, error } = await supabase
      .from("products")
      .select(
        "id, sku, name, name_secondary, description, manufacturer_code, manufacturer, category, subcategory, sub_subcategory",
      )
      .is("embedding", null)
      .limit(EMBED_BATCH_SIZE);

    if (error) throw new Error(`DB read failed: ${error.message}`);
    if (!products || products.length === 0) break;

    const texts = products.map((p) =>
      buildEmbeddingText(p as ProductForEmbedding),
    );

    try {
      const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        input: texts,
      });

      for (let i = 0; i < products.length; i++) {
        const embedding = response.data[i].embedding;
        const { error: updateError } = await supabase
          .from("products")
          .update({ embedding: JSON.stringify(embedding) })
          .eq("id", products[i].id);

        if (updateError) {
          console.error(
            `Failed to save embedding for ${products[i].sku}: ${updateError.message}`,
          );
          totalErrors++;
        }
      }

      totalProcessed += products.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`OpenAI embedding error: ${message}`);
      totalErrors += products.length;

      if (message.includes("rate_limit")) {
        console.log("Rate limited, waiting 60s...");
        await sleep(60_000);
        continue;
      }
    }

    if (onProgress) {
      await onProgress({
        type: "embedding_progress",
        data: {
          processed: totalProcessed,
          total: totalToProcess,
          errors: totalErrors,
          percent: Math.round((totalProcessed / totalToProcess) * 100),
        },
      });
    }

    await sleep(DELAY_BETWEEN_BATCHES_MS);
  }

  return { processed: totalProcessed, errors: totalErrors };
}

/**
 * Generate an embedding vector for a single query string.
 * Used by the semantic search agent.
 */
export async function generateQueryEmbedding(
  query: string,
): Promise<number[]> {
  const openai = getOpenAIClient();

  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    input: query,
  });

  return response.data[0].embedding;
}
