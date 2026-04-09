import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  ...(env.NODE_ENV !== "production" && {
    transport: { target: "pino/file", options: { destination: 1 } },
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
  }),
});

export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}
