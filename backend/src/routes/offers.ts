import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import { getAdminClient } from "../services/supabase.js";

type Env = {
  Variables: {
    user: { id: string; app_metadata?: { role?: string } };
    accessToken: string;
  };
};

const offers = new Hono<Env>();

/**
 * GET /offers
 * List all offers for the authenticated user, ordered by most recent first.
 */
offers.get("/offers", authMiddleware, async (c) => {
  const user = c.get("user");
  const supabase = getAdminClient();

  const { data, error } = await supabase
    .from("offers")
    .select("id, title, status, created_at, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json({ offers: data ?? [] });
});

/**
 * POST /offers
 * Create a new offer with a title.
 */
offers.post("/offers", authMiddleware, async (c) => {
  const user = c.get("user");
  const { title } = await c.req.json<{ title: string }>();

  if (!title?.trim()) {
    return c.json({ error: "Title is required" }, 400);
  }

  const supabase = getAdminClient();

  const { data, error } = await supabase
    .from("offers")
    .insert({
      user_id: user.id,
      title: title.trim(),
      status: "draft",
      messages: [],
    })
    .select("id, title, status, created_at, updated_at")
    .single();

  if (error) {
    return c.json({ error: error.message }, 500);
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
      extra_columns,
      products:matched_product_id (
        id, sku, name, name_secondary, unit, price, ean,
        manufacturer_code, manufacturer, category, subcategory,
        sub_subcategory, eshop_url
      )
    `)
    .eq("offer_id", offerId)
    .order("position", { ascending: true });

  if (itemsError) {
    return c.json({ error: itemsError.message }, 500);
  }

  const offerItems = (items ?? []).map((item) => ({
    position: item.position,
    originalName: item.original_name,
    unit: item.unit,
    quantity: item.quantity ? Number(item.quantity) : null,
    matchType: item.match_type ?? "not_found",
    confidence: item.confidence ? Number(item.confidence) : 0,
    product: item.products ?? null,
    candidates: item.candidates ?? [],
    confirmed: item.confirmed ?? false,
    extraColumns: item.extra_columns ?? {},
  }));

  return c.json({
    offer: {
      id: offer.id,
      title: offer.title,
      status: offer.status,
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
  const body = await c.req.json<{ title?: string; status?: string }>();

  const supabase = getAdminClient();

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.title !== undefined) update.title = body.title.trim();
  if (body.status !== undefined) update.status = body.status;

  const { data, error } = await supabase
    .from("offers")
    .update(update)
    .eq("id", offerId)
    .eq("user_id", user.id)
    .select("id, title, status, created_at, updated_at")
    .single();

  if (error) {
    return c.json({ error: error.message }, 500);
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

  await supabase.from("offer_items").delete().eq("offer_id", offerId);

  const { error } = await supabase
    .from("offers")
    .delete()
    .eq("id", offerId)
    .eq("user_id", user.id);

  if (error) {
    return c.json({ error: error.message }, 500);
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
    return c.json({ error: error.message }, 500);
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
    const rows = items.map((item) => ({
      offer_id: offerId,
      position: item.position,
      original_name: item.originalName,
      unit: item.unit ?? null,
      quantity: item.quantity ?? null,
      match_type: item.matchType ?? "not_found",
      confidence: item.confidence ?? 0,
      matched_product_id: item.productId ?? null,
      status: item.confirmed ? "confirmed" : (item.matchType === "not_found" ? "processing" : "matched"),
      candidates: item.candidates ?? [],
      confirmed: item.confirmed ?? false,
      extra_columns: item.extraColumns ?? {},
    }));

    const { error: insertError } = await supabase
      .from("offer_items")
      .insert(rows);

    if (insertError) {
      return c.json({ error: insertError.message }, 500);
    }
  }

  await supabase
    .from("offers")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", offerId);

  return c.json({ success: true });
});

interface OfferItemInput {
  position: number;
  originalName: string;
  unit?: string | null;
  quantity?: number | null;
  matchType?: string;
  confidence?: number;
  productId?: string | null;
  confirmed?: boolean;
  candidates?: unknown[];
  extraColumns?: Record<string, string>;
}

export { offers as offersRouter };
