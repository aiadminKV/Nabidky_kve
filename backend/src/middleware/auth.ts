import type { Context, Next } from "hono";
import { getAdminClient } from "../services/supabase.js";

/**
 * Hono middleware: validates the JWT from the Authorization header
 * and attaches the authenticated user to the context.
 */
export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  const supabase = getAdminClient();

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  c.set("user", data.user);
  c.set("accessToken", token);

  await next();
}

/**
 * Hono middleware: requires admin role (app_metadata.role === 'admin').
 * Must be used after authMiddleware.
 */
export async function adminMiddleware(c: Context, next: Next) {
  const user = c.get("user") as { app_metadata?: { role?: string } } | undefined;
  const role = user?.app_metadata?.role;

  if (role !== "admin") {
    return c.json({ error: "Admin access required" }, 403);
  }

  await next();
}
