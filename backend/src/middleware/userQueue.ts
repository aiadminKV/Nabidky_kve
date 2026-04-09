import type { Context, Next } from "hono";
import { logger } from "../services/logger.js";

interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
}

interface UserQueueOptions {
  /** Max simultaneous searches per user. */
  maxConcurrent: number;
  /** Max requests waiting in queue per user before rejecting. */
  maxWaiting: number;
  /** How long a request can wait in the queue before timing out (ms). */
  timeoutMs: number;
}

class UserConcurrencyQueue {
  private readonly running = new Map<string, number>();
  private readonly waiting = new Map<string, QueueEntry[]>();

  constructor(private readonly opts: UserQueueOptions) {}

  async acquire(userId: string): Promise<() => void> {
    const current = this.running.get(userId) ?? 0;

    if (current < this.opts.maxConcurrent) {
      this.running.set(userId, current + 1);
      return () => this.release(userId);
    }

    const queue = this.waiting.get(userId) ?? [];

    if (queue.length >= this.opts.maxWaiting) {
      throw new Error("User queue full");
    }

    return new Promise<() => void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;

      const entry: QueueEntry = {
        resolve: () => {
          clearTimeout(timer);
          this.running.set(userId, (this.running.get(userId) ?? 0) + 1);
          resolve(() => this.release(userId));
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };

      timer = setTimeout(() => {
        const q = this.waiting.get(userId) ?? [];
        const idx = q.indexOf(entry);
        if (idx >= 0) q.splice(idx, 1);
        entry.reject(new Error("Queue timeout"));
      }, this.opts.timeoutMs);

      queue.push(entry);
      this.waiting.set(userId, queue);
    });
  }

  private release(userId: string): void {
    const current = this.running.get(userId) ?? 0;
    this.running.set(userId, Math.max(0, current - 1));

    const queue = this.waiting.get(userId) ?? [];
    const next = queue.shift();
    if (next) {
      next.resolve();
    } else if (current <= 1) {
      this.running.delete(userId);
    }
  }

  stats(userId: string) {
    return {
      running: this.running.get(userId) ?? 0,
      waiting: (this.waiting.get(userId) ?? []).length,
    };
  }
}

export function userQueueMiddleware(opts: UserQueueOptions) {
  const queue = new UserConcurrencyQueue(opts);

  return async (c: Context, next: Next) => {
    const user = c.get("user") as { id: string } | undefined;
    const userId = user?.id ?? "anon";

    const stats = queue.stats(userId);
    if (stats.running > 0 || stats.waiting > 0) {
      logger.debug({ userId, ...stats }, "user queue: request waiting");
    }

    let release: () => void;
    try {
      release = await queue.acquire(userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Queue error";
      if (msg === "User queue full") {
        return c.json({ error: "Příliš mnoho souběžných vyhledávání, zkus to znovu za chvíli" }, 429);
      }
      return c.json({ error: "Vyhledávání čekalo příliš dlouho, zkus to znovu" }, 503);
    }

    try {
      await next();
    } finally {
      release();
    }
  };
}
