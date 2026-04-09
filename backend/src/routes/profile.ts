import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import { getAdminClient } from "../services/supabase.js";

type Env = {
  Variables: {
    user: { id: string; email?: string; app_metadata?: Record<string, unknown> };
    accessToken: string;
  };
};

const profileRouter = new Hono<Env>();

profileRouter.use("*", authMiddleware);

profileRouter.get("/profile", async (c) => {
  const user = c.get("user");
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
  const user = c.get("user");
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

profileRouter.post("/profile/change-password", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    currentPassword: string;
    newPassword: string;
  }>();

  if (!body.currentPassword || !body.newPassword) {
    return c.json({ error: "Vyplňte staré i nové heslo." }, 400);
  }

  if (body.newPassword.length < 6) {
    return c.json({ error: "Nové heslo musí mít alespoň 6 znaků." }, 400);
  }

  const supabase = getAdminClient();

  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: user.email!,
    password: body.currentPassword,
  });

  if (signInError) {
    return c.json({ error: "Staré heslo je nesprávné." }, 403);
  }

  const { error: updateError } = await supabase.auth.admin.updateUserById(
    user.id,
    { password: body.newPassword },
  );

  if (updateError) {
    (await import("../services/logger.js")).logger.error({ err: updateError.message }, "change-password update failed");
    return c.json({ error: "Nepodařilo se změnit heslo." }, 500);
  }

  return c.json({ ok: true });
});

export { profileRouter };
