/**
 * Structured logger + Google Chat webhook for daily sync pipeline.
 */

export type EventStatus = "info" | "warn" | "error" | "alert" | "success";

export interface SyncEvent {
  phase: string;
  status: EventStatus;
  message: string;
  details?: Record<string, unknown>;
}

const events: SyncEvent[] = [];
let webhookUrl: string | null = null;

export function initLogger(url: string | undefined): void {
  webhookUrl = url?.trim() || null;
  if (!webhookUrl) {
    console.log("  [logger] No SYNC_WEBHOOK_URL — webhook alerts disabled\n");
  }
}

export function log(event: SyncEvent): void {
  events.push(event);

  const icon =
    event.status === "error" ? "ERROR" :
    event.status === "alert" ? "ALERT" :
    event.status === "warn"  ? "WARN " :
    event.status === "success" ? " OK  " : "     ";

  const detail = event.details
    ? " " + Object.entries(event.details).map(([k, v]) => `${k}=${v}`).join(" ")
    : "";

  console.log(`  [${icon}] [${event.phase}] ${event.message}${detail}`);
}

export function getEvents(): SyncEvent[] {
  return events;
}

export function getSummary(): string {
  const lines: string[] = [];
  const errors = events.filter((e) => e.status === "error");
  const alerts = events.filter((e) => e.status === "alert");
  const infos = events.filter((e) => e.status === "info" || e.status === "success");

  lines.push("=== Sync Summary ===");
  for (const e of infos) {
    const detail = e.details
      ? " | " + Object.entries(e.details).map(([k, v]) => `${k}=${v}`).join(", ")
      : "";
    lines.push(`[${e.phase}] ${e.message}${detail}`);
  }

  if (alerts.length > 0) {
    lines.push("\n--- ALERTS ---");
    for (const e of alerts) lines.push(`[${e.phase}] ${e.message}`);
  }

  if (errors.length > 0) {
    lines.push("\n--- ERRORS ---");
    for (const e of errors) lines.push(`[${e.phase}] ${e.message}`);
  }

  return lines.join("\n");
}

export async function sendWebhook(
  type: "start" | "alert" | "error" | "complete",
  text: string,
): Promise<void> {
  if (!webhookUrl) return;

  const emoji =
    type === "start"    ? "🔄" :
    type === "alert"    ? "🚨" :
    type === "error"    ? "❌" :
    type === "complete" ? "✅" : "ℹ️";

  const body = { text: `${emoji} *KV Sync* — ${text}` };

  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.log(`  [WARN ] Webhook HTTP ${resp.status}: ${resp.statusText}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [WARN ] Webhook failed: ${msg}`);
  }
}
