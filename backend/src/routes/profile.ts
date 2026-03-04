import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import { getAdminClient } from "../services/supabase.js";

const profileRouter = new Hono();

profileRouter.use("*", authMiddleware);

profileRouter.get("/profile", async (c) => {
  const user = c.get("user") as { id: string; email?: string; app_metadata?: Record<string, unknown> };
  const supabase = getAdminClient();

  const { data, error } = await supabase
    .from("profiles")
    .select("first_name, last_name, phone, role")
    .eq("id", user.id)
    .single();

  if (error) {
    return c.json({ error: "Failed to load profile" }, 500);
  }

  return c.json({
    id: user.id,
    email: user.email ?? null,
    first_name: data.first_name,
    last_name: data.last_name,
    phone: data.phone,
    role: data.role,
  });
});

profileRouter.put("/profile", async (c) => {
  const user = c.get("user") as { id: string };
  const body = await c.req.json<{
    first_name?: string;
    last_name?: string;
    phone?: string;
  }>();

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.first_name !== undefined) updates.first_name = body.first_name.trim() || null;
  if (body.last_name !== undefined) updates.last_name = body.last_name.trim() || null;
  if (body.phone !== undefined) updates.phone = body.phone.trim() || null;

  const supabase = getAdminClient();

  const { data, error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", user.id)
    .select("first_name, last_name, phone, role")
    .single();

  if (error) {
    return c.json({ error: "Failed to update profile" }, 500);
  }

  return c.json({
    id: user.id,
    first_name: data.first_name,
    last_name: data.last_name,
    phone: data.phone,
    role: data.role,
  });
});

export { profileRouter };
