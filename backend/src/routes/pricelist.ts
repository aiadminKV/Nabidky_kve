import { Hono } from "hono";
import { streamText } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { authMiddleware, adminMiddleware } from "../middleware/auth.js";
import { getAdminClient } from "../services/supabase.js";
import {
  parseExcelBuffer,
  parseCsvBuffer,
  previewExcelColumns,
  previewCsvColumns,
  loadExistingSkus,
  computeDiff,
  applyChanges,
  PRODUCT_FIELDS,
  type DiffSummary,
  type ColumnMapping,
} from "../services/pricelist.js";
import { cleanProductDescriptions } from "../services/embedding.js";

type Env = {
  Variables: {
    user: { id: string };
    accessToken: string;
  };
};

const pricelistRouter = new Hono<Env>();

type FileType = "excel" | "csv";

interface UploadCacheEntry {
  buffer: Buffer;
  filename: string;
  fileType: FileType;
  userId: string;
  timestamp: number;
  columnMapping?: ColumnMapping;
}

const uploadCache = new Map<string, UploadCacheEntry>();

const CACHE_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of uploadCache) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      uploadCache.delete(id);
    }
  }
}, 5 * 60 * 1000);

function sseEvent(type: string, data: unknown): string {
  return `data: ${JSON.stringify({ type, data })}\n\n`;
}

/**
 * POST /pricelist/upload
 * Upload an Excel file and cache it for analysis. Admin only.
 */
pricelistRouter.post("/pricelist/upload", authMiddleware, adminMiddleware, async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];

  if (!file || !(file instanceof File)) {
    return c.json({ error: "Soubor nebyl nahrán" }, 400);
  }

  const ext = file.name.split(".").pop()?.toLowerCase();
  if (!ext || !["xlsx", "xls", "csv"].includes(ext)) {
    return c.json({ error: "Podporované formáty: .xlsx, .xls, .csv" }, 400);
  }

  const fileType: FileType = ext === "csv" ? "csv" : "excel";
  const buffer = Buffer.from(await file.arrayBuffer());
  const uploadId = randomUUID();
  const user = c.get("user");

  uploadCache.set(uploadId, {
    buffer,
    filename: file.name,
    fileType,
    userId: user.id,
    timestamp: Date.now(),
  });

  return c.json({
    uploadId,
    filename: file.name,
    fileSize: buffer.length,
  });
});

/**
 * POST /pricelist/preview-columns
 * Read headers + sample rows from the uploaded file to let the user map columns.
 */
pricelistRouter.post("/pricelist/preview-columns", authMiddleware, adminMiddleware, async (c) => {
  const { uploadId } = await c.req.json<{ uploadId: string }>();

  const cached = uploadCache.get(uploadId);
  if (!cached) {
    return c.json({ error: "Upload nenalezen nebo vypršel" }, 404);
  }

  try {
    const preview = cached.fileType === "csv"
      ? previewCsvColumns(cached.buffer)
      : await previewExcelColumns(cached.buffer);

    return c.json({
      ...preview,
      productFields: PRODUCT_FIELDS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Chyba při čtení souboru";
    return c.json({ error: msg }, 500);
  }
});

/**
 * POST /pricelist/analyze
 * Parse the uploaded file and compute diff against DB. Admin only.
 * Streams progress via SSE.
 */
pricelistRouter.post("/pricelist/analyze", authMiddleware, adminMiddleware, async (c) => {
  const { uploadId, columnMapping } = await c.req.json<{
    uploadId: string;
    columnMapping?: ColumnMapping;
  }>();

  const cached = uploadCache.get(uploadId);
  if (!cached) {
    return c.json({ error: "Upload nenalezen nebo vypršel" }, 404);
  }

  if (columnMapping) {
    cached.columnMapping = columnMapping;
  }

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  return streamText(c, async (stream) => {
    try {
      const isCsv = cached.fileType === "csv";
      await stream.write(sseEvent("status", { phase: "parsing", message: isCsv ? "Parsování CSV souboru…" : "Parsování Excel souboru…" }));

      const products = isCsv
        ? await parseCsvBuffer(cached.buffer, async (event) => {
            await stream.write(sseEvent(event.type, event.data));
          }, cached.columnMapping)
        : await parseExcelBuffer(cached.buffer, async (event) => {
            await stream.write(sseEvent(event.type, event.data));
          }, cached.columnMapping);

      await stream.write(sseEvent("status", { phase: "loading_db", message: "Načítání existujících produktů z DB…" }));

      const dbSkus = await loadExistingSkus(async (event) => {
        await stream.write(sseEvent(event.type, event.data));
      });

      await stream.write(sseEvent("status", { phase: "computing_diff", message: "Výpočet rozdílů…" }));

      const fileSkus = new Set(products.map((p) => p.sku));
      const diff = computeDiff(fileSkus, dbSkus);

      const summary: DiffSummary = {
        totalInFile: products.length,
        totalInDb: dbSkus.size,
        toAdd: diff.toAdd.length,
        toUpdate: diff.toUpdate.length,
        toRemove: diff.toRemove.length,
        sampleNew: diff.toAdd.slice(0, 10),
        sampleRemove: diff.toRemove.slice(0, 10),
      };

      const user = c.get("user");
      const supabase = getAdminClient();
      await supabase.from("price_list_uploads").insert({
        id: uploadId,
        user_id: user.id,
        filename: cached.filename,
        status: "analyzed",
        total_in_file: summary.totalInFile,
        total_in_db: summary.totalInDb,
        items_added: summary.toAdd,
        items_updated: summary.toUpdate,
        items_removed: summary.toRemove,
      });

      await stream.write(sseEvent("analysis_complete", summary));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Neznámá chyba";
      await stream.write(sseEvent("error", { message: msg }));
    }

    await stream.write("data: [DONE]\n\n");
  });
});

/**
 * POST /pricelist/apply
 * Apply the analyzed changes to the database. Admin only.
 * Streams progress via SSE.
 */
pricelistRouter.post("/pricelist/apply", authMiddleware, adminMiddleware, async (c) => {
  const { uploadId } = await c.req.json<{ uploadId: string }>();

  const cached = uploadCache.get(uploadId);
  if (!cached) {
    return c.json({ error: "Upload nenalezen nebo vypršel" }, 404);
  }

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  return streamText(c, async (stream) => {
    const supabase = getAdminClient();

    try {
      await supabase
        .from("price_list_uploads")
        .update({ status: "applying" })
        .eq("id", uploadId);

      const isCsv = cached.fileType === "csv";
      await stream.write(sseEvent("status", { phase: "parsing", message: isCsv ? "Parsování CSV souboru…" : "Parsování Excel souboru…" }));

      const products = isCsv
        ? await parseCsvBuffer(cached.buffer, undefined, cached.columnMapping)
        : await parseExcelBuffer(cached.buffer, undefined, cached.columnMapping);

      await stream.write(sseEvent("status", { phase: "cleaning_descriptions", message: "Čištění popisů produktů (AI)…" }));

      const cleanedCount = await cleanProductDescriptions(products, async (event) => {
        await stream.write(sseEvent(event.type, event.data));
      });

      await stream.write(sseEvent("clean_complete", { cleaned: cleanedCount }));

      await stream.write(sseEvent("status", { phase: "loading_db", message: "Načítání existujících SKU…" }));

      const dbSkus = await loadExistingSkus();
      const fileSkus = new Set(products.map((p) => p.sku));
      const diff = computeDiff(fileSkus, dbSkus);

      await stream.write(
        sseEvent("status", {
          phase: "applying",
          message: `Aplikuji změny: ${products.length} upsert, ${diff.toRemove.length} smazat…`,
        }),
      );

      const result = await applyChanges(products, diff.toRemove, async (event) => {
        await stream.write(sseEvent(event.type, event.data));
      });

      await supabase
        .from("price_list_uploads")
        .update({
          status: "completed",
          items_added: diff.toAdd.length,
          items_updated: diff.toUpdate.length,
          items_removed: result.removed,
          completed_at: new Date().toISOString(),
        })
        .eq("id", uploadId);

      uploadCache.delete(uploadId);

      await stream.write(
        sseEvent("apply_complete", {
          upserted: result.upserted,
          removed: result.removed,
          errors: result.errors,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Neznámá chyba";

      await supabase
        .from("price_list_uploads")
        .update({ status: "failed", error_message: msg })
        .eq("id", uploadId);

      await stream.write(sseEvent("error", { message: msg }));
    }

    await stream.write("data: [DONE]\n\n");
  });
});

/**
 * GET /pricelist/history
 * List all past price list uploads (global, admin only).
 */
pricelistRouter.get("/pricelist/history", authMiddleware, adminMiddleware, async (c) => {
  const supabase = getAdminClient();

  const { data, error } = await supabase
    .from("price_list_uploads")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    return c.json({ error: `Načtení historie selhalo: ${error.message}` }, 500);
  }

  return c.json({ uploads: data ?? [] });
});

/**
 * GET /pricelist/products
 * Paginated preview of the current product catalog. Admin only.
 */
pricelistRouter.get("/pricelist/products", authMiddleware, adminMiddleware, async (c) => {
  const page = Math.max(0, parseInt(c.req.query("page") ?? "0", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query("pageSize") ?? "50", 10)));
  const search = c.req.query("search")?.trim() ?? "";
  const category = c.req.query("category")?.trim() ?? "";

  const supabase = getAdminClient();

  let query = supabase
    .from("products")
    .select("sku, name, name_secondary, unit, price, ean, manufacturer_code, manufacturer, category, subcategory, sub_subcategory", { count: "exact" });

  if (search) {
    query = query.or(`sku.ilike.%${search}%,name.ilike.%${search}%,manufacturer_code.ilike.%${search}%`);
  }

  if (category) {
    query = query.eq("category", category);
  }

  const { data, error, count } = await query
    .order("sku")
    .range(page * pageSize, (page + 1) * pageSize - 1);

  if (error) {
    return c.json({ error: `Načtení produktů selhalo: ${error.message}` }, 500);
  }

  return c.json({
    products: data ?? [],
    total: count ?? 0,
    page,
    pageSize,
    totalPages: Math.ceil((count ?? 0) / pageSize),
  });
});

/**
 * GET /pricelist/stats
 * Basic stats about the current product catalog. Admin only.
 */
pricelistRouter.get("/pricelist/stats", authMiddleware, adminMiddleware, async (c) => {
  const supabase = getAdminClient();

  const { count: totalProducts } = await supabase
    .from("products")
    .select("*", { count: "exact", head: true });

  const { data: categories } = await supabase
    .rpc("get_category_counts");

  return c.json({
    totalProducts: totalProducts ?? 0,
    categories: categories ?? [],
  });
});

/**
 * POST /pricelist/generate-embeddings
 * Generate embeddings for all products where embedding IS NULL.
 * Long-running SSE stream. Admin only.
 */
pricelistRouter.post("/pricelist/generate-embeddings", authMiddleware, adminMiddleware, async (c) => {
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  return streamText(c, async (stream) => {
    try {
      const result = await generateEmbeddingsForProducts(async (event) => {
        await stream.write(sseEvent(event.type, event.data));
      });

      await stream.write(
        sseEvent("embedding_complete", {
          processed: result.processed,
          errors: result.errors,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Neznámá chyba";
      await stream.write(sseEvent("error", { message: msg }));
    }

    await stream.write("data: [DONE]\n\n");
  });
});

export { pricelistRouter };
