import type { Context, Next } from "hono";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimiterOptions {
  windowMs: number;
  max: number;
}

const buckets = new Map<string, Map<string, RateLimitEntry>>();

setInterval(() => {
  const now = Date.now();
  for (const [, store] of buckets) {
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }
}, 60_000);

export function rateLimiter(opts: RateLimiterOptions) {
  const { windowMs, max } = opts;
  const id = `${windowMs}:${max}`;

  if (!buckets.has(id)) buckets.set(id, new Map());
  const store = buckets.get(id)!;

  return async (c: Context, next: Next) => {
    const user = c.get("user") as { id: string } | undefined;
    const key = user?.id ?? c.req.header("x-forwarded-for") ?? "anon";
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }

    entry.count++;

    if (entry.count > max) {
      c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json({ error: "Too many requests" }, 429);
    }

    await next();
  };
}
