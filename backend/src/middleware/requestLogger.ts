import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";
import { logger } from "../services/logger.js";

export async function requestLogger(c: Context, next: Next) {
  const requestId = c.req.header("x-request-id") ?? randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);

  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  const logData = { requestId, method, path, status, duration };

  if (status >= 500) {
    logger.error(logData, "request failed");
  } else if (status >= 400) {
    logger.warn(logData, "request error");
  } else if (duration > 10_000) {
    logger.warn(logData, "slow request");
  } else {
    logger.info(logData, "request completed");
  }
}
