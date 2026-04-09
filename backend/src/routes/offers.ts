import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import { getAdminClient } from "../services/supabase.js";
import { getCachedCategoryTree } from "../services/searchPipeline.js";
import { logger } from "../services/logger.js";

type Env = {
  Variables: {
    user: { id: string; app_metadata?: { role?: string } };
    accessToken: string;
  };
};

const offers = new Hono<Env>();

/**
 * GET /offers
 * List offers for the authenticated user with cursor-based pagination.
 * Query params: limit (default 20), offset (default 0)
 */
offers.get("/offers", authMiddleware, async (c) => {
  const user = c.get("user");
  const limit = Math.min(Number(c.req.query("limit")) || 20, 100);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

  const supabase = getAdminClient();

  const { count, error: countError } = await supabase
    .from("offers")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

  if (countError) {
    logger.error({ err: countError.message }, "offers count failed");
    return c.json({ error: "Nepodařilo se načíst nabídky" }, 500);
  }

  const { data, error } = await supabase
    .from("offers")
    .select("id, title, status, header, created_at, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    logger.error({ err: error.message }, "offers list failed");
    return c.json({ error: "Nepodařilo se načíst nabídky" }, 500);
  }

  return c.json({ offers: data ?? [], total: count ?? 0 });
});

/**
 * POST /offers
 * Create a new offer with a title.
 */
offers.post("/offers", authMiddleware, async (c) => {
  const user = c.get("user");
  const { title, header } = await c.req.json<{ title: string; header?: Record<string, unknown> }>();

  if (!title?.trim()) {
    return c.json({ error: "Title is required" }, 400);
  }

  const supabase = getAdminClient();

  const insertData: Record<string, unknown> = {
    user_id: user.id,
    title: title.trim(),
    status: "draft",
    messages: [],
  };
  if (header && Object.keys(header).length > 0) {
    insertData.header = header;
  }

  const { data, error } = await supabase
    .from("offers")
    .insert(insertData)
    .select("id, title, status, header, created_at, updated_at")
    .single();

  if (error) {
    logger.error({ err: error.message }, "offer create failed");
    return c.json({ error: "Nepodařilo se vytvořit nabídku" }, 500);
  }

  return c.json({ offer: data }, 201);
});

/**
 * GET /offers/:id
 * Get a single offer with its items and messages.
 */
offers.get("/offers/:id", authMiddleware, async (c) => {
  const user = c.get("user");
  const offerId = c.req.param("id");
  const supabase = getAdminClient();

  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .select("*")
    .eq("id", offerId)
    .eq("user_id", user.id)
    .single();

  if (offerError || !offer) {
    return c.json({ error: "Offer not found" }, 404);
  }

  const { data: items, error: itemsError } = await supabase
    .from("offer_items")
    .select(`
      id,
      item_id,
      position,
      original_name,
      unit,
      quantity,
      match_type,
      confidence,
      matched_product_id,
      status,
      candidates,
      confirmed,
      review_status,
      extra_columns,
      parent_item_id,
      component_role
    `)
    .eq("offer_id", offerId)
    .order("position", { ascending: true });

  if (itemsError) {
    logger.error({ err: itemsError.message }, "offer items load failed");
    return c.json({ error: "Nepodařilo se načíst položky nabídky" }, 500);
  }

  const offerItems = (items ?? []).map((item) => ({
    itemId: item.item_id ?? null,
    position: item.position,
    originalName: item.original_name,
    unit: item.unit,
    quantity: item.quantity ? Number(item.quantity) : null,
    matchType: item.match_type ?? "not_found",
    confidence: item.confidence ? Number(item.confidence) : 0,
    product: null,
    candidates: item.candidates ?? [],
    confirmed: item.confirmed ?? false,
    reviewStatus: item.review_status ?? null,
    extraColumns: item.extra_columns ?? {},
    parentItemId: item.parent_item_id ?? null,
    componentRole: item.component_role ?? null,
  }));

  return c.json({
    offer: {
      id: offer.id,
      title: offer.title,
      status: offer.status,
      header: offer.header ?? {},
      messages: offer.messages ?? [],
      createdAt: offer.created_at,
      updatedAt: offer.updated_at,
    },
    items: offerItems,
  });
});

/**
 * PUT /offers/:id
 * Update offer title and/or status.
 */
offers.put("/offers/:id", authMiddleware, async (c) => {
  const user = c.get("user");
  const offerId = c.req.param("id");
  const body = await c.req.json<{ title?: string; status?: string; header?: Record<string, unknown> }>();

  const supabase = getAdminClient();

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.title !== undefined) update.title = body.title.trim();
  if (body.status !== undefined) update.status = body.status;
  if (body.header !== undefined) update.header = body.header;

  const { data, error } = await supabase
    .from("offers")
    .update(update)
    .eq("id", offerId)
    .eq("user_id", user.id)
    .select("id, title, status, header, created_at, updated_at")
    .single();

  if (error) {
    logger.error({ err: error.message }, "offer update failed");
    return c.json({ error: "Nepodařilo se aktualizovat nabídku" }, 500);
  }

  return c.json({ offer: data });
});

/**
 * DELETE /offers/:id
 * Delete an offer and all its items.
 */
offers.delete("/offers/:id", authMiddleware, async (c) => {
  const user = c.get("user");
  const offerId = c.req.param("id");
  const supabase = getAdminClient();

  const { data: offer } = await supabase
    .from("offers")
    .select("id")
    .eq("id", offerId)
    .eq("user_id", user.id)
    .single();

  if (!offer) {
    return c.json({ error: "Offer not found" }, 404);
  }

  await supabase.from("offer_items").delete().eq("offer_id", offerId);

  const { error } = await supabase
    .from("offers")
    .delete()
    .eq("id", offerId)
    .eq("user_id", user.id);

  if (error) {
    return c.json({ error: "Failed to delete offer" }, 500);
  }

  return c.json({ success: true });
});

/**
 * PUT /offers/:id/messages
 * Save chat messages for an offer.
 */
offers.put("/offers/:id/messages", authMiddleware, async (c) => {
  const user = c.get("user");
  const offerId = c.req.param("id");
  const { messages } = await c.req.json<{ messages: unknown[] }>();

  const supabase = getAdminClient();

  const { error } = await supabase
    .from("offers")
    .update({
      messages,
      updated_at: new Date().toISOString(),
    })
    .eq("id", offerId)
    .eq("user_id", user.id);

  if (error) {
    logger.error({ err: error.message }, "offer messages save failed");
    return c.json({ error: "Nepodařilo se uložit zprávy" }, 500);
  }

  return c.json({ success: true });
});

/**
 * PUT /offers/:id/items
 * Bulk-save offer items (replaces all items for this offer).
 */
offers.put("/offers/:id/items", authMiddleware, async (c) => {
  const user = c.get("user");
  const offerId = c.req.param("id");
  const { items } = await c.req.json<{ items: OfferItemInput[] }>();

  const supabase = getAdminClient();

  const { data: offer } = await supabase
    .from("offers")
    .select("id")
    .eq("id", offerId)
    .eq("user_id", user.id)
    .single();

  if (!offer) {
    return c.json({ error: "Offer not found" }, 404);
  }

  await supabase.from("offer_items").delete().eq("offer_id", offerId);

  if (items.length > 0) {
    const rows = items.map((item) => {
      let productId = item.productId ?? null;
      if (productId !== null && /^\d+$/.test(String(productId))) {
        productId = null;
      }
      return {
        offer_id: offerId,
        item_id: item.itemId ?? null,
        position: item.position,
        original_name: item.originalName,
        unit: item.unit ?? null,
        quantity: item.quantity ?? null,
        match_type: item.matchType ?? "not_found",
        confidence: item.confidence ?? 0,
        matched_product_id: productId,
        status: item.confirmed ? "confirmed" : (item.matchType === "not_found" ? "processing" : "matched"),
        candidates: item.candidates ?? [],
        confirmed: item.confirmed ?? false,
        review_status: item.reviewStatus ?? null,
        extra_columns: item.extraColumns ?? {},
        parent_item_id: item.parentItemId ?? null,
        component_role: item.componentRole ?? null,
      };
    });

    const { error: insertError } = await supabase
      .from("offer_items")
      .insert(rows);

    if (insertError) {
      logger.error({ err: insertError.message, details: insertError.details, hint: insertError.hint }, "offer_items insert failed");
      return c.json({ error: "Nepodařilo se uložit položky nabídky" }, 500);
    }
  }

  await supabase
    .from("offers")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", offerId);

  return c.json({ success: true });
});

interface OfferItemInput {
  itemId?: string | null;
  position: number;
  originalName: string;
  unit?: string | null;
  quantity?: number | null;
  matchType?: string;
  confidence?: number;
  productId?: string | null;
  confirmed?: boolean;
  reviewStatus?: string | null;
  candidates?: unknown[];
  extraColumns?: Record<string, string>;
  parentItemId?: string | null;
  componentRole?: string | null;
}

/**
 * GET /branches
 * List all branches from branches_v2 (used for branch filter dropdown).
 */
offers.get("/branches", authMiddleware, async (c) => {
  const supabase = getAdminClient();

  const { data, error } = await supabase
    .from("branches_v2")
    .select("source_branch_code, name")
    .eq("active", true)
    .order("source_branch_code", { ascending: true });

  if (error) {
    logger.error({ err: error.message }, "branches load failed");
    return c.json({ error: "Nepodařilo se načíst pobočky" }, 500);
  }

  const branches = (data ?? []).map((b) => ({
    code: b.source_branch_code,
    name: b.name,
  }));

  return c.json({ branches });
});

/**
 * GET /manufacturers?q=cisco
 * Search distinct supplier names from stock items.
 * Returns up to 20 matches for the given query (min 2 chars).
 */
offers.get("/manufacturers", authMiddleware, async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json({ manufacturers: [] });

  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from("products_v2")
    .select("supplier_name")
    .eq("is_stock_item", true)
    .not("supplier_name", "is", null)
    .neq("supplier_name", "")
    .ilike("supplier_name", `%${q}%`)
    .order("supplier_name")
    .limit(500);

  if (error) {
    logger.error({ err: error.message }, "manufacturers search failed");
    return c.json({ error: "Nepodařilo se vyhledat výrobce" }, 500);
  }

  const unique = [...new Set(
    (data ?? []).map((r: { supplier_name: string }) => r.supplier_name).filter(Boolean),
  )].slice(0, 20);

  return c.json({ manufacturers: unique });
});

/**
 * GET /categories
 * Returns the full category tree (code + name + level + parent_code).
 * Uses the same cached tree as the search planner.
 */
offers.get("/categories", authMiddleware, async (c) => {
  try {
    const tree = await getCachedCategoryTree();
    return c.json({ categories: tree });
  } catch (err) {
    logger.error({ err: String(err) }, "categories load failed");
    return c.json({ error: "Nepodařilo se načíst kategorie" }, 500);
  }
});

/**
 * POST /product-stock
 * Get branch-level stock info for a product by SKU.
 */
offers.post("/product-stock", authMiddleware, async (c) => {
  const { sku } = await c.req.json<{ sku: string }>();
  if (!sku) return c.json({ error: "sku is required" }, 400);

  const supabase = getAdminClient();

  const { data: product } = await supabase
    .from("products_v2")
    .select("id, is_stock_item")
    .eq("sku", sku)
    .is("removed_at", null)
    .single();

  if (!product) {
    return c.json({ stock: [], totalStock: 0, isStockItem: false });
  }

  const { data: stockRows } = await supabase
    .from("product_branch_stock_v2")
    .select("branch_id, stock_qty, branches_v2!inner(source_branch_code, name)")
    .eq("product_id", product.id);

  const stock = (stockRows ?? []).map((r) => {
    const branch = r.branches_v2 as unknown as { source_branch_code: string; name: string | null };
    return {
      branchCode: branch.source_branch_code,
      branchName: branch.name,
      qty: Number(r.stock_qty),
    };
  });

  const totalStock = stock.reduce((sum, s) => sum + s.qty, 0);

  return c.json({
    stock,
    totalStock,
    isStockItem: product.is_stock_item ?? false,
  });
});

export { offers as offersRouter };
