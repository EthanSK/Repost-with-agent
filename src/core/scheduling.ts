import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DestinationAdapter, PublishResult } from "../adapters/destination.js";
import { SourceAdapter } from "../adapters/source.js";
import { previewPair, publishNextForPair } from "./orchestrator.js";
import {
  appendAuditEvent,
  ensurePairDirs,
  getAppDataDir,
  loadAuditHistory,
  nowIso,
} from "./runtime.js";
import { AuditEvent, PairRecord } from "./types.js";

/**
 * Scheduling helpers. Repost-with-agent itself does not run a scheduler — it
 * delegates to OpenClaw cron / launchd / system cron. This module supplies:
 *
 *   - `runScheduled()`: a deterministic per-tick runner the host scheduler
 *     should invoke (`repost-with-agent pair scheduled-run <id>`). Loads the
 *     pair, enforces min-delay policy, runs preview-only by default (or live
 *     publish when explicitly enabled), and emits structured `pair.scheduled.*`
 *     audit events so we can prove a tick ran.
 *
 *   - `renderLaunchdPlist()` / `renderCrontabLine()` / `renderOpenClawCronCommand()`:
 *     pure functions producing host-installable scheduling artifacts for an
 *     existing pair without writing anything.
 *
 *   - `installLaunchdPlist()` / `uninstallLaunchdPlist()`: idempotent
 *     filesystem helpers that wire / unwire a launchd job.
 */

export interface ScheduledRunOptions {
  /**
   * If true and the pair mode is `live-approved`, attempt to publish the top
   * candidate. Defaults to false — scheduled ticks are preview-only by default
   * regardless of the pair mode, because unattended publishing is a footgun
   * and the README/docs explicitly tell users to keep `pair post --approve`
   * human-triggered.
   */
  allowPublish?: boolean;
  /**
   * Override the wall clock used for min-delay enforcement (testing only).
   */
  now?: Date;
}

export type ScheduledRunOutcome =
  | "preview-only"
  | "no-candidate"
  | "duplicate"
  | "uncertain-blocked"
  | "min-delay"
  | "blocked-mode"
  | "needs-approval"
  | "auth-failed"
  | "publish-failed"
  | "published";

export interface ScheduledRunResult {
  pairId: string;
  pairName: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sourceUrl?: string;
  destinationTarget?: string;
  outcome: ScheduledRunOutcome;
  reason?: string;
  candidateCount: number;
  draft?: { chars: number; warnings: string[]; preview: string };
  publish?: PublishResult;
  error?: string;
}

const PAIR_PUBLISH_SUCCESS_EVENT = "pair.publish.success";

export function findLastPublishAt(pairId: string): Date | null {
  const audit = loadAuditHistory(pairId);
  for (let i = audit.length - 1; i >= 0; i -= 1) {
    if (audit[i].event === PAIR_PUBLISH_SUCCESS_EVENT) {
      const at = audit[i].at;
      const parsed = new Date(at);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  }
  return null;
}

export function isMinDelayWindowOpen(
  pair: PairRecord,
  now: Date,
  lastPublishAt: Date | null
): { open: boolean; remainingMinutes: number } {
  const minMinutes = Math.max(0, pair.policy.minDelayBetweenPostsMinutes || 0);
  if (minMinutes === 0 || !lastPublishAt) {
    return { open: true, remainingMinutes: 0 };
  }
  const elapsedMs = now.getTime() - lastPublishAt.getTime();
  const minMs = minMinutes * 60 * 1000;
  if (elapsedMs >= minMs) {
    return { open: true, remainingMinutes: 0 };
  }
  return {
    open: false,
    remainingMinutes: Math.ceil((minMs - elapsedMs) / 60000),
  };
}

/**
 * Deterministic scheduled-tick entry point. The host scheduler should invoke
 * `repost-with-agent pair scheduled-run <pair-id>` at its configured cadence.
 * Always runs preview; only publishes when (a) `allowPublish: true`,
 * (b) pair mode is `live-approved`, (c) min-delay window is open, (d) the
 * usual orchestrator gates pass.
 */
export async function runScheduled(
  pair: PairRecord,
  sourceAdapter: SourceAdapter,
  destinationAdapter: DestinationAdapter,
  options: ScheduledRunOptions = {}
): Promise<ScheduledRunResult> {
  ensurePairDirs(pair.id);
  const startedAt = nowIso();
  const startWall = (options.now ?? new Date()).getTime();
  const sourceUrl = pair.source.url || pair.source.profileUrl;
  const destinationTarget =
    pair.destination.accountHint ||
    pair.destination.pageHint ||
    pair.destination.type;
  const baseEvent: Omit<AuditEvent, "event" | "details"> = {
    at: startedAt,
    pairId: pair.id,
  };

  appendAuditEvent({
    ...baseEvent,
    event: "pair.scheduled.start",
    details: {
      mode: pair.mode,
      enabled: pair.enabled,
      allowPublish: Boolean(options.allowPublish),
      sourceUrl,
      destinationTarget,
    },
  });

  const finalize = (
    outcome: ScheduledRunOutcome,
    extra: Partial<ScheduledRunResult> = {}
  ): ScheduledRunResult => {
    const finishedAt = nowIso();
    const durationMs = Date.now() - startWall;
    const result: ScheduledRunResult = {
      pairId: pair.id,
      pairName: pair.name,
      startedAt,
      finishedAt,
      durationMs,
      sourceUrl,
      destinationTarget,
      outcome,
      candidateCount: 0,
      ...extra,
    };
    appendAuditEvent({
      at: finishedAt,
      event: "pair.scheduled.end",
      pairId: pair.id,
      details: {
        outcome: result.outcome,
        reason: result.reason,
        candidateCount: result.candidateCount,
        durationMs: result.durationMs,
        sourceUrl,
        destinationTarget,
        publishedDestinationId: result.publish?.destinationId,
        publishedDestinationUrl: result.publish?.destinationUrl,
        error: result.error,
      },
    });
    return result;
  };

  try {
    if (!pair.enabled) {
      return finalize("preview-only", {
        reason: "Pair is disabled; ran preview-only diagnostics path skipped.",
      });
    }

    const wantsPublish = Boolean(options.allowPublish);

    if (wantsPublish) {
      // Min-delay gate before we even fetch.
      const lastPublishAt = findLastPublishAt(pair.id);
      const window = isMinDelayWindowOpen(
        pair,
        options.now ?? new Date(),
        lastPublishAt
      );
      if (!window.open) {
        return finalize("min-delay", {
          reason: `Min-delay window not open. ${window.remainingMinutes} min remaining (policy.minDelayBetweenPostsMinutes=${pair.policy.minDelayBetweenPostsMinutes}).`,
        });
      }

      if (pair.mode !== "live-approved") {
        // Refuse unattended publishing on anything but live-approved.
        const preview = await previewPair(pair, sourceAdapter, destinationAdapter);
        const top = preview.items[0];
        return finalize("blocked-mode", {
          reason: `Pair mode is ${pair.mode}; scheduled publish requires live-approved + --allow-publish. Ran preview-only.`,
          candidateCount: preview.items.length,
          draft: top
            ? {
                chars: top.draft.text.length,
                warnings: top.draft.warnings,
                preview: top.draft.text.slice(0, 280),
              }
            : undefined,
        });
      }

      const outcome = await publishNextForPair(
        pair,
        sourceAdapter,
        destinationAdapter,
        { approve: true, allowUncertain: false }
      );

      const top = outcome.preview;
      const candidateCount = top ? 1 : 0;
      const draft = top
        ? {
            chars: top.draft.text.length,
            warnings: top.draft.warnings,
            preview: top.draft.text.slice(0, 280),
          }
        : undefined;

      const map: Record<string, ScheduledRunOutcome> = {
        published: "published",
        duplicate: "duplicate",
        "uncertain-blocked": "uncertain-blocked",
        "needs-approval": "needs-approval",
        "no-candidate": "no-candidate",
        "auth-failed": "auth-failed",
        "publish-failed": "publish-failed",
      };
      const mapped = map[outcome.status] || "publish-failed";

      return finalize(mapped, {
        reason: outcome.reason,
        candidateCount,
        draft,
        publish: outcome.publishResult,
      });
    }

    // Preview-only path (default for scheduled ticks).
    const preview = await previewPair(pair, sourceAdapter, destinationAdapter);
    const top = preview.items[0];
    if (!top) {
      return finalize("no-candidate", {
        reason: "Source returned no candidates.",
      });
    }
    const draft = {
      chars: top.draft.text.length,
      warnings: top.draft.warnings,
      preview: top.draft.text.slice(0, 280),
    };
    if (top.decision.status === "duplicate") {
      return finalize("duplicate", {
        reason: top.decision.reason,
        candidateCount: preview.items.length,
        draft,
      });
    }
    if (top.decision.status === "uncertain") {
      return finalize("uncertain-blocked", {
        reason: top.decision.reason,
        candidateCount: preview.items.length,
        draft,
      });
    }
    return finalize("preview-only", {
      reason: "Preview-only scheduled tick; candidate ready, no publish requested.",
      candidateCount: preview.items.length,
      draft,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendAuditEvent({
      at: nowIso(),
      event: "pair.scheduled.error",
      pairId: pair.id,
      details: { error: message },
    });
    return finalize("publish-failed", {
      reason: message,
      error: message,
    });
  }
}

// --------------------------- Schedule artifacts ----------------------------

export interface ScheduleRenderInputs {
  pair: PairRecord;
  /** Repo dir holding `dist/index.js`. Defaults to the cwd of the running CLI. */
  repoDir?: string;
  /** Override node binary path; useful in launchd plists where PATH is bare. */
  nodeBin?: string;
  /** If true, the rendered artifact will pass `--allow-publish`. */
  allowPublish?: boolean;
}

export function defaultRepoDir(): string {
  // Walk up from this file to find the repo root (parent of dist/ or src/).
  const here = path.dirname(__filename);
  const candidate = path.resolve(here, "..", "..");
  return candidate;
}

export function defaultNodeBin(): string {
  return process.execPath || "node";
}

export function buildScheduledRunArgv(inputs: ScheduleRenderInputs): string[] {
  const repoDir = inputs.repoDir || defaultRepoDir();
  const entry = path.join(repoDir, "dist", "index.js");
  const args = [entry, "pair", "scheduled-run", inputs.pair.id];
  if (inputs.allowPublish) args.push("--allow-publish");
  return args;
}

export function renderShellCommand(inputs: ScheduleRenderInputs): string {
  const node = inputs.nodeBin || defaultNodeBin();
  const argv = buildScheduledRunArgv(inputs);
  return [node, ...argv].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_./@:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function renderLaunchdPlist(inputs: ScheduleRenderInputs): {
  filename: string;
  contents: string;
} {
  const pair = inputs.pair;
  const label = `com.repost-with-agent.${slugLabel(pair.id)}`;
  const argv = buildScheduledRunArgv(inputs);
  const node = inputs.nodeBin || defaultNodeBin();
  const repoDir = inputs.repoDir || defaultRepoDir();
  const dataDir = getAppDataDir();
  const logDir = path.join(dataDir, "pairs", pair.id, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const stdoutLog = path.join(logDir, "scheduled.out.log");
  const stderrLog = path.join(logDir, "scheduled.err.log");

  const calendarBlock = renderLaunchdCalendarBlock(pair);

  const programArgs = [node, ...argv]
    .map((s) => `        <string>${escapeXml(s)}</string>`)
    .join("\n");

  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(repoDir)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${escapeXml(os.homedir())}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXml(stdoutLog)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(stderrLog)}</string>
    <key>RunAtLoad</key>
    <false/>
${calendarBlock}
</dict>
</plist>
`;

  return { filename: `${label}.plist`, contents };
}

function renderLaunchdCalendarBlock(pair: PairRecord): string {
  if (pair.schedule.kind === "every" && pair.schedule.everyMinutes) {
    const seconds = Math.max(60, pair.schedule.everyMinutes * 60);
    return `    <key>StartInterval</key>\n    <integer>${seconds}</integer>`;
  }
  if (pair.schedule.kind === "cron" && pair.schedule.expression) {
    const parsed = parseCronToCalendar(pair.schedule.expression);
    if (parsed) {
      const inner = Object.entries(parsed)
        .map(([k, v]) => `        <key>${k}</key>\n        <integer>${v}</integer>`)
        .join("\n");
      return `    <key>StartCalendarInterval</key>\n    <dict>\n${inner}\n    </dict>`;
    }
    // Cron unsupported by launchd's StartCalendarInterval; fall through to
    // an hourly fallback the user can hand-tweak.
    return `    <!-- cron expression "${escapeXml(pair.schedule.expression)}" could not be auto-translated to launchd. -->\n    <!-- Edit StartCalendarInterval below by hand or use a different scheduler. -->\n    <key>StartCalendarInterval</key>\n    <dict>\n        <key>Minute</key>\n        <integer>0</integer>\n    </dict>`;
  }
  // Manual: do not auto-fire on load.
  return `    <!-- schedule.kind=${pair.schedule.kind}; no calendar interval emitted. -->`;
}

interface CalendarFields {
  Minute?: number;
  Hour?: number;
  Day?: number;
  Month?: number;
  Weekday?: number;
}

export function parseCronToCalendar(expr: string): CalendarFields | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, day, month, weekday] = fields;
  const out: CalendarFields = {};
  const setSimple = (raw: string, key: keyof CalendarFields): boolean => {
    if (raw === "*") return true;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return false;
    out[key] = n;
    return true;
  };
  if (!setSimple(minute, "Minute")) return null;
  if (!setSimple(hour, "Hour")) return null;
  if (!setSimple(day, "Day")) return null;
  if (!setSimple(month, "Month")) return null;
  if (!setSimple(weekday, "Weekday")) return null;
  return out;
}

export function renderCrontabLine(inputs: ScheduleRenderInputs): string {
  const pair = inputs.pair;
  const cmd = renderShellCommand(inputs);
  let cronExpr = "0 10 * * *";
  if (pair.schedule.kind === "cron" && pair.schedule.expression) {
    cronExpr = pair.schedule.expression;
  } else if (pair.schedule.kind === "every" && pair.schedule.everyMinutes) {
    cronExpr = `*/${Math.max(1, pair.schedule.everyMinutes)} * * * *`;
  }
  const dataDir = getAppDataDir();
  const logFile = path.join(
    dataDir,
    "pairs",
    pair.id,
    "logs",
    "scheduled.cron.log"
  );
  return `${cronExpr} ${cmd} >> ${shellQuote(logFile)} 2>&1   # repost-with-agent ${pair.id}`;
}

export function renderOpenClawCronCommand(inputs: ScheduleRenderInputs): string {
  const pair = inputs.pair;
  const allow = inputs.allowPublish ? " --allow-publish" : "";
  const cron =
    pair.schedule.kind === "cron" && pair.schedule.expression
      ? pair.schedule.expression
      : "0 10 * * *";
  const tz = pair.schedule.tz || "UTC";
  const message =
    `Use the repost-with-agent skill. Run \`repost-with-agent pair scheduled-run ${pair.id}${allow}\`. ` +
    `Read its JSON stdout, summarise outcome (preview-only / new-candidate / duplicate / blocked / published), ` +
    `and report any blockers. Do NOT pass --allow-publish unless the saved policy explicitly authorises live posting.`;
  const lines = [
    "openclaw cron add \\",
    `  --name ${shellQuote(`repost-with-agent ${pair.id} scheduled-run`)} \\`,
    `  --cron ${shellQuote(cron)} \\`,
    `  --tz ${shellQuote(tz)} \\`,
    "  --session isolated \\",
    `  --message ${shellQuote(message)} \\`,
    "  --announce",
  ];
  return lines.join("\n");
}

function slugLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface InstallLaunchdResult {
  plistPath: string;
  installed: boolean;
  loaded: boolean;
  loadError?: string;
}

export function getLaunchAgentsDir(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents");
}

export function installLaunchdPlist(
  inputs: ScheduleRenderInputs,
  options: { load?: boolean } = {}
): InstallLaunchdResult {
  const dir = getLaunchAgentsDir();
  fs.mkdirSync(dir, { recursive: true });
  const { filename, contents } = renderLaunchdPlist(inputs);
  const plistPath = path.join(dir, filename);
  fs.writeFileSync(plistPath, contents, "utf-8");
  if (!options.load) {
    return { plistPath, installed: true, loaded: false };
  }
  // Don't shell out from inside the library; let callers run launchctl. We
  // just return the path so the CLI can print the load command.
  return { plistPath, installed: true, loaded: false };
}

export function uninstallLaunchdPlist(pairId: string): {
  plistPath: string;
  removed: boolean;
} {
  const label = `com.repost-with-agent.${slugLabel(pairId)}`;
  const plistPath = path.join(getLaunchAgentsDir(), `${label}.plist`);
  if (!fs.existsSync(plistPath)) {
    return { plistPath, removed: false };
  }
  fs.unlinkSync(plistPath);
  return { plistPath, removed: true };
}
