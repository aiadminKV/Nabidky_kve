import { logger } from "./logger.js";

type AlertLevel = "info" | "warn" | "error" | "critical";

interface AlertPayload {
  level: AlertLevel;
  title: string;
  details?: string;
  source: string;
}

interface NotifyChannel {
  name: string;
  minLevel: AlertLevel;
  send(payload: AlertPayload): Promise<void>;
}

const LEVEL_ORDER: Record<AlertLevel, number> = {
  info: 0,
  warn: 1,
  error: 2,
  critical: 3,
};

const LEVEL_EMOJI: Record<AlertLevel, string> = {
  info: "\u2139\uFE0F",
  warn: "\u26A0\uFE0F",
  error: "\u274C",
  critical: "\uD83D\uDEA8",
};

const channels: NotifyChannel[] = [];

export function registerChannel(channel: NotifyChannel): void {
  channels.push(channel);
  logger.info({ channel: channel.name }, "notification channel registered");
}

export async function notify(payload: AlertPayload): Promise<void> {
  const payloadLevel = LEVEL_ORDER[payload.level];

  const sends = channels
    .filter((ch) => payloadLevel >= LEVEL_ORDER[ch.minLevel])
    .map(async (ch) => {
      try {
        await ch.send(payload);
      } catch (err) {
        logger.warn(
          { channel: ch.name, err: err instanceof Error ? err.message : String(err) },
          "notification channel send failed",
        );
      }
    });

  await Promise.allSettled(sends);
}

export function createGoogleChatChannel(webhookUrl: string): NotifyChannel {
  return {
    name: "google-chat",
    minLevel: "warn",
    async send(payload) {
      const emoji = LEVEL_EMOJI[payload.level];
      const lines = [`${emoji} *KV Backend* \u2014 ${payload.title}`];
      if (payload.details) lines.push(payload.details);
      lines.push(`_source: ${payload.source}_`);

      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ text: lines.join("\n") }),
      });

      if (!resp.ok) {
        throw new Error(`Google Chat webhook HTTP ${resp.status}`);
      }
    },
  };
}

// Future: email channel
// export function createEmailChannel(config: SmtpConfig): NotifyChannel { ... }
