/**
 * Telegram-on-publish notifier.
 *
 * Ethan voice 5977 (2026-05-01): "Make sure we have a — we guarantee you
 * notify me every time you post something with the repost-with-agent over
 * whatever channel. Just instruct the agents to send a message over being
 * like, oh yeah, I posted this. That's very important."
 *
 * Voice 5978: "It should be embedded deep within the instructions of the
 * project."
 *
 * This module is the code-level guarantee. Every successful destination
 * publish from the orchestrator MUST call `notifyPublishSuccess()` after
 * the publish is confirmed (not before, not in parallel). On failure to
 * deliver the notification, we log a warning + audit event but never roll
 * back the publish — the post is already up.
 *
 * Config sources, in priority order:
 *   1. ~/.repost-with-agent/notify.json
 *      { telegram: { enabled, botToken, chatId } }
 *   2. Env vars REPOST_TELEGRAM_BOT_TOKEN + REPOST_TELEGRAM_CHAT_ID
 *      (fallback for CI / cron environments where writing the file is awkward)
 *
 * If neither is configured, every successful publish emits a loud
 * `pair.publish.notify_skipped_unconfigured` audit event + a stderr warning
 * so silent omission is impossible.
 */

import * as fs from "fs";
import * as path from "path";
import { getAppDataDir } from "./runtime.js";

export interface TelegramNotifyConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
}

export interface NotifyConfigFile {
  telegram?: Partial<TelegramNotifyConfig>;
}

export type NotifyConfigSource = "file" | "env" | "none";

export interface ResolvedNotifyConfig {
  source: NotifyConfigSource;
  telegram?: TelegramNotifyConfig;
}

export function getNotifyConfigPath(): string {
  return path.join(getAppDataDir(), "notify.json");
}

/**
 * Load the notify config. File takes priority over env. Returns
 * `{ source: "none" }` when nothing is configured.
 */
export function loadNotifyConfig(): ResolvedNotifyConfig {
  const filePath = getNotifyConfigPath();
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(
        fs.readFileSync(filePath, "utf-8")
      ) as NotifyConfigFile;
      const tg = raw.telegram;
      if (
        tg &&
        tg.enabled !== false &&
        typeof tg.botToken === "string" &&
        tg.botToken.length > 0 &&
        typeof tg.chatId === "string" &&
        tg.chatId.length > 0
      ) {
        return {
          source: "file",
          telegram: {
            enabled: true,
            botToken: tg.botToken,
            chatId: tg.chatId,
          },
        };
      }
    } catch {
      // fall through to env
    }
  }

  const envToken = process.env.REPOST_TELEGRAM_BOT_TOKEN;
  const envChatId = process.env.REPOST_TELEGRAM_CHAT_ID;
  if (envToken && envChatId) {
    return {
      source: "env",
      telegram: {
        enabled: true,
        botToken: envToken,
        chatId: envChatId,
      },
    };
  }

  return { source: "none" };
}

/**
 * Persist `{ telegram: { enabled, botToken, chatId } }` to
 * `~/.repost-with-agent/notify.json` with `0600` perms (bot token is
 * sensitive).
 */
export function writeNotifyConfig(
  telegram: TelegramNotifyConfig
): { path: string } {
  const configPath = getNotifyConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const payload: NotifyConfigFile = { telegram };
  fs.writeFileSync(
    configPath,
    JSON.stringify(payload, null, 2),
    { encoding: "utf-8", mode: 0o600 }
  );
  // Tighten existing file too in case it pre-existed with wider perms.
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // best-effort
  }
  return { path: configPath };
}

export interface NotifyPublishInput {
  pairId: string;
  pairName?: string;
  sourceUrl?: string | null;
  destinationUrl?: string | null;
  destinationType?: string;
  destinationId?: string;
  /** First-page excerpt of the published content. */
  content?: string;
  /** Trigger that caused the publish: pair-post / scheduled-run / backfill / other. */
  trigger?: string;
}

export interface NotifyPublishOutcome {
  attempted: boolean;
  delivered: boolean;
  source: NotifyConfigSource;
  error?: string;
  /** The text that was (would be) sent. Useful for tests + logs. */
  body: string;
}

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (ch) => HTML_ESCAPE[ch] || ch);
}

function truncate(value: string, max = 400): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Build the Telegram-bound message body. HTML parse_mode. Stable shape
 * because tests assert on it.
 */
export function buildPublishMessage(input: NotifyPublishInput): string {
  const lines: string[] = [];
  lines.push(
    `✅ <b>[Repost-with-agent]</b> Posted: <code>${escapeHtml(input.pairId)}</code>`
  );
  if (input.pairName && input.pairName !== input.pairId) {
    lines.push(`<i>${escapeHtml(input.pairName)}</i>`);
  }
  if (input.trigger) {
    lines.push(`Trigger: <code>${escapeHtml(input.trigger)}</code>`);
  }
  lines.push("");
  if (input.sourceUrl) {
    lines.push(`Source: ${escapeHtml(input.sourceUrl)}`);
  }
  if (input.destinationUrl) {
    lines.push(`→ ${escapeHtml(input.destinationUrl)}`);
  } else if (input.destinationType) {
    const id = input.destinationId ? ` ${input.destinationId}` : "";
    lines.push(`→ ${escapeHtml(input.destinationType + id)}`);
  }
  if (input.content && input.content.trim()) {
    lines.push("");
    lines.push(`<blockquote>${escapeHtml(truncate(input.content, 600))}</blockquote>`);
  }
  return lines.join("\n");
}

export interface SendTelegramOptions {
  /**
   * Override for tests. Defaults to globalThis.fetch.
   */
  fetchImpl?: typeof fetch;
  /** Timeout in ms; default 10s. */
  timeoutMs?: number;
}

/**
 * Low-level: POST to the Telegram bot sendMessage endpoint. Throws on
 * network or HTTP-not-ok. The caller (`notifyPublishSuccess`) is responsible
 * for catching and logging — never propagate to the publish caller.
 */
export async function sendTelegramMessage(
  telegram: TelegramNotifyConfig,
  text: string,
  options: SendTelegramOptions = {}
): Promise<void> {
  const fetchImpl =
    options.fetchImpl ||
    (typeof fetch === "function" ? fetch : undefined);
  if (!fetchImpl) {
    throw new Error(
      "No fetch implementation available; upgrade Node to >=18 or pass options.fetchImpl."
    );
  }
  const url = `https://api.telegram.org/bot${telegram.botToken}/sendMessage`;
  const body = {
    chat_id: telegram.chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  };

  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), options.timeoutMs ?? 10000)
    : null;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller?.signal,
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Telegram sendMessage HTTP ${response.status}: ${errText.slice(0, 200)}`
      );
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export interface NotifyPublishOptions {
  /** Override config (testing). */
  config?: ResolvedNotifyConfig;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Fire-and-await Telegram notification for a successful publish. Never
 * throws. Returns a structured outcome the caller can use to write an audit
 * event. Caller MUST invoke this AFTER the publish is confirmed — never in
 * parallel.
 */
export async function notifyPublishSuccess(
  input: NotifyPublishInput,
  options: NotifyPublishOptions = {}
): Promise<NotifyPublishOutcome> {
  const config = options.config ?? loadNotifyConfig();
  const body = buildPublishMessage(input);

  if (config.source === "none" || !config.telegram?.enabled) {
    process.stderr.write(
      `[repost-with-agent] WARN: pair ${input.pairId} published, but Telegram notify is unconfigured. ` +
        "Run `repost-with-agent notify configure --bot-token <T> --chat-id <C>` " +
        "or set REPOST_TELEGRAM_BOT_TOKEN + REPOST_TELEGRAM_CHAT_ID. " +
        "Silent publishes are a project bug (Ethan voice 5977).\n"
    );
    return {
      attempted: false,
      delivered: false,
      source: "none",
      body,
    };
  }

  try {
    await sendTelegramMessage(config.telegram, body, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
    return {
      attempted: true,
      delivered: true,
      source: config.source,
      body,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[repost-with-agent] ERROR: Telegram notify failed for ${input.pairId}: ${message}. ` +
        "Publish itself succeeded; this is non-fatal but means Ethan didn't get the ping.\n"
    );
    return {
      attempted: true,
      delivered: false,
      source: config.source,
      error: message,
      body,
    };
  }
}
