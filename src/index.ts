#!/usr/bin/env node

import { Command } from "commander";
import { previewPair, publishNextForPair } from "./core/orchestrator.js";
import { DEFAULT_POLICY, normalizePolicy } from "./core/policy.js";
import {
  DEFAULT_OVERLENGTH_STRATEGY,
  OverlengthStrategy,
  runBackfill,
} from "./core/backfill.js";
import {
  installLaunchdPlist,
  renderCrontabLine,
  renderLaunchdPlist,
  renderOpenClawCronCommand,
  renderShellCommand,
  runScheduled,
  uninstallLaunchdPlist,
} from "./core/scheduling.js";
import {
  appendAuditEvent,
  defaultPairName,
  getEnvironmentSummary,
  getPairById,
  getPairPaths,
  loadAuditHistory,
  loadPairsStore,
  loadPostedHistory,
  nowIso,
  resolveScheduleTimezone,
  slugifyPairId,
  upsertPair,
  writeDefaultLearnings,
} from "./core/runtime.js";
import { PairMode, PairRecord, PairRunMode, PairScheduleKind } from "./core/types.js";
import { summarizeText } from "./core/dedupe.js";
import { APP_NAME } from "./config.js";
import {
  buildPublishMessage,
  getNotifyConfigPath,
  loadNotifyConfig,
  sendTelegramMessage,
  writeNotifyConfig,
} from "./core/notify.js";
import { expandUrl, expandUrlsInText } from "./core/url-expander.js";

const VERSION = "3.0.0";

/** Platform labels we ship recognized defaults for. Free-form on input. */
const SUPPORTED_PLATFORMS = ["linkedin", "x", "bluesky", "threads", "facebook"] as const;

function requirePair(pairId: string): PairRecord {
  const pair = getPairById(pairId);
  if (!pair) {
    console.error(`Pair not found: ${pairId}`);
    process.exit(1);
  }
  return pair;
}

function printPair(pair: PairRecord): void {
  console.log(JSON.stringify(pair, null, 2));
}

function parsePairMode(value?: string): PairMode {
  const mode = value || "preview-only";
  if (["preview-only", "approval-required", "live-approved"].includes(mode)) {
    return mode as PairMode;
  }
  console.error(`Invalid mode: ${mode}. Expected preview-only, approval-required, or live-approved.`);
  process.exit(1);
}

function parseRunMode(value?: string): PairRunMode {
  const mode = value || "listen-for-future";
  if (mode === "listen-for-future" || mode === "backfill") {
    return mode;
  }
  console.error(`Invalid run-mode: ${mode}. Expected listen-for-future or backfill.`);
  process.exit(1);
}

function parseScheduleKind(value?: string): PairScheduleKind {
  const kind = value || "manual";
  if (["manual", "cron", "every"].includes(kind)) {
    return kind as PairScheduleKind;
  }
  console.error(`Invalid schedule kind: ${kind}. Expected manual, cron, or every.`);
  process.exit(1);
}

function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid ${label}: ${value}. Expected a positive integer.`);
    process.exit(1);
  }
  return parsed;
}

function parseOverlengthStrategy(value?: string): OverlengthStrategy {
  const v = (value || DEFAULT_OVERLENGTH_STRATEGY).toLowerCase();
  if (v !== "skip" && v !== "truncate") {
    console.error(`Invalid --overlength-strategy: ${value}. Expected 'skip' or 'truncate'.`);
    process.exit(1);
  }
  return v as OverlengthStrategy;
}

interface CreatePairOptions {
  id?: string;
  name?: string;
  sourcePlatform: string;
  sourceUrl?: string;
  destinationPlatform: string;
  destinationAccount?: string;
  mode?: string;
  runMode?: string;
  enabled?: boolean;
  scheduleKind?: string;
  scheduleExpression?: string;
  everyMinutes?: string;
  timezone?: string;
  authRefSource?: string;
  authRefDestination?: string;
}

async function createPair(opts: CreatePairOptions): Promise<void> {
  const idBase =
    opts.id ||
    opts.name ||
    `${opts.sourcePlatform}-to-${opts.destinationPlatform}`;
  const pairId = slugifyPairId(idBase);
  const existing = getPairById(pairId);
  if (existing) {
    console.error(`Pair already exists: ${pairId}`);
    process.exit(1);
  }

  const now = nowIso();
  const mode = parsePairMode(opts.mode);
  const runMode = parseRunMode(opts.runMode);
  const scheduleKind = parseScheduleKind(opts.scheduleKind);
  const everyMinutes = parsePositiveInteger(opts.everyMinutes, "every-minutes");
  const pair: PairRecord = {
    id: pairId,
    name: opts.name || defaultPairName(opts.sourcePlatform, opts.destinationPlatform),
    enabled: Boolean(opts.enabled),
    mode,
    runMode,
    source: {
      platform: opts.sourcePlatform,
      url: opts.sourceUrl,
      profileUrl: opts.sourceUrl,
      authRef: opts.authRefSource,
    },
    destination: {
      platform: opts.destinationPlatform,
      accountHint: opts.destinationAccount,
      authRef: opts.authRefDestination,
    },
    schedule: {
      kind: scheduleKind,
      expression: opts.scheduleExpression,
      everyMinutes,
      tz: resolveScheduleTimezone(opts.timezone),
    },
    policy: normalizePolicy(),
    dedupe: {
      strategy: "source-id-url-content-hash",
    },
    createdAt: now,
    updatedAt: now,
    schemaVersion: 3,
  };

  upsertPair(pair);
  writeDefaultLearnings(pair.id);
  appendAuditEvent({
    at: now,
    event: "pair.created",
    pairId: pair.id,
    details: {
      sourcePlatform: pair.source.platform,
      destinationPlatform: pair.destination.platform,
      mode: pair.mode,
      runMode: pair.runMode,
      enabled: pair.enabled,
      schedule: pair.schedule.kind,
    },
  });

  console.log(`Created pair ${pair.id}`);
  console.log(getEnvironmentSummary());
  printPair(pair);
}

async function previewPairCommand(pairId: string): Promise<void> {
  const pair = requirePair(pairId);
  const result = await previewPair(pair);
  console.log(`Pair: ${pair.id} (${pair.name})`);
  console.log(`Mode: ${pair.mode} | RunMode: ${pair.runMode || "listen-for-future"}`);
  console.log(`Source auth: ${result.auth.source}`);
  console.log(`Destination auth: ${result.auth.destination}`);
  console.log(`Learnings loaded: ${result.learnings.trim() ? "yes" : "no"}`);
  console.log();

  if (result.items.length === 0) {
    console.log("No candidate items found for preview.");
    return;
  }

  result.items.forEach((entry, index) => {
    console.log(`${index + 1}. ${entry.decision.status.toUpperCase()} - ${entry.decision.reason}`);
    if (entry.item.canonicalUrl) {
      console.log(`   Source: ${entry.item.canonicalUrl}`);
    }
    console.log(`   Text: ${summarizeText(entry.item.text, 180)}`);
    console.log(`   Draft: ${summarizeText(entry.draft.text, 220)}`);
    if (entry.draft.warnings.length > 0) {
      console.log(`   Warnings: ${entry.draft.warnings.join(" | ")}`);
    }
  });
}

async function postPairCommand(
  pairId: string,
  opts: { approve: boolean; allowUncertain: boolean; overlengthStrategy?: string }
): Promise<void> {
  const pair = requirePair(pairId);
  const overlengthStrategy = opts.overlengthStrategy
    ? parseOverlengthStrategy(opts.overlengthStrategy)
    : undefined;

  const outcome = await publishNextForPair(pair, {
    approve: opts.approve,
    allowUncertain: opts.allowUncertain,
    overlengthStrategy,
  });

  console.log(`Pair: ${pair.id} (${pair.name})`);
  console.log(`Mode: ${pair.mode}`);
  console.log(`Outcome: ${outcome.status}`);
  if (outcome.reason) {
    console.log(`Reason: ${outcome.reason}`);
  }
  if (outcome.preview) {
    if (outcome.preview.item.canonicalUrl) {
      console.log(`Source: ${outcome.preview.item.canonicalUrl}`);
    }
    console.log(`Draft (${outcome.preview.draft.text.length} chars):`);
    console.log(outcome.preview.draft.text);
    if (outcome.preview.draft.warnings.length > 0) {
      console.log(`Warnings: ${outcome.preview.draft.warnings.join(" | ")}`);
    }
  }
  if (outcome.publishResult?.destinationUrl) {
    console.log(`Posted: ${outcome.publishResult.destinationUrl}`);
  }
  if (outcome.publishResult?.destinationId) {
    console.log(`Destination ID: ${outcome.publishResult.destinationId}`);
  }

  if (
    outcome.status === "publish-failed" ||
    outcome.status === "auth-failed"
  ) {
    process.exit(2);
  }
}

function printHistory(pairId: string): void {
  const pair = requirePair(pairId);
  const paths = getPairPaths(pair.id);
  const posted = loadPostedHistory(pair.id);
  const audit = loadAuditHistory(pair.id);
  console.log(`Pair: ${pair.id} (${pair.name})`);
  console.log(`Posted history: ${paths.postedFile}`);
  console.log(`Audit log: ${paths.auditFile}`);
  console.log();

  console.log(`Posted entries: ${posted.length}`);
  for (const entry of posted.slice(-10)) {
    console.log(`- [${entry.postedAt}] ${entry.summary}`);
    if (entry.destinationUrl) {
      console.log(`  destinationUrl=${entry.destinationUrl}`);
    } else if (entry.destinationId) {
      console.log(`  destinationId=${entry.destinationId}`);
    }
    if (entry.importedFrom) {
      console.log(`  importedFrom=${entry.importedFrom}`);
    }
  }

  console.log();
  console.log(`Recent audit events: ${audit.length}`);
  for (const entry of audit.slice(-10)) {
    console.log(`- [${entry.at}] ${entry.event}`);
  }
}

const program = new Command();

program
  .name(APP_NAME)
  .description(
    "Agent-driven, browser-based reposting. The CLI is a thin orchestrator over JSON state; " +
      "the agent (Claude Code / OpenClaw) drives the user's logged-in browser via its own browser MCP."
  )
  .version(VERSION);

const pair = program.command("pair").description("Manage saved repost source-to-destination pairs");

pair
  .command("create")
  .description("Create a saved pair using flags. Platform names are free-form labels (e.g. linkedin, x, bluesky, threads, facebook).")
  .requiredOption("--source-platform <platform>", `Source platform label (e.g. ${SUPPORTED_PLATFORMS.join(", ")})`)
  .requiredOption("--destination-platform <platform>", `Destination platform label (e.g. ${SUPPORTED_PLATFORMS.join(", ")})`)
  .option("--id <id>", "Pair id")
  .option("--name <name>", "Human-friendly pair name")
  .option("--source-url <url>", "Source profile/feed URL")
  .option("--destination-account <account>", "Destination account hint, e.g. @example")
  .option("--mode <mode>", "preview-only | approval-required | live-approved")
  .option("--run-mode <mode>", "listen-for-future (default) | backfill")
  .option("--enabled", "Enable the pair immediately")
  .option("--schedule-kind <kind>", "manual | cron | every", "manual")
  .option("--schedule-expression <expr>", "Cron expression")
  .option("--every-minutes <minutes>", "Every N minutes")
  .option("--timezone <tz>", "Schedule timezone")
  .option("--auth-ref-source <ref>", "Source auth reference (free-form label)")
  .option("--auth-ref-destination <ref>", "Destination auth reference (free-form label)")
  .action(createPair);

pair
  .command("list")
  .description("List saved pairs")
  .action(() => {
    const store = loadPairsStore();
    if (store.pairs.length === 0) {
      console.log("No saved pairs.");
      console.log(getEnvironmentSummary());
      return;
    }

    for (const entry of store.pairs) {
      const sp = entry.source.platform || entry.source.type || "?";
      const dp = entry.destination.platform || entry.destination.type || "?";
      console.log(
        `${entry.id} | ${entry.enabled ? "enabled" : "disabled"} | ${entry.mode} | ${entry.runMode || "listen-for-future"} | ${sp} -> ${dp}`
      );
    }
  });

pair
  .command("show")
  .description("Show a pair JSON definition")
  .argument("<id>", "Pair id")
  .action((id) => printPair(requirePair(id)));

pair
  .command("preview")
  .description("Preview a pair safely without publishing")
  .argument("<id>", "Pair id")
  .action(previewPairCommand);

pair
  .command("history")
  .description("Show per-pair audit and posted history")
  .argument("<id>", "Pair id")
  .action(printHistory);

pair
  .command("post")
  .description(
    "Publish the next eligible candidate for a pair. Approval-gated; previews + dedupes first."
  )
  .argument("<id>", "Pair id")
  .option("--approve", "Required: explicit approval to actually publish.")
  .option(
    "--allow-uncertain",
    "Allow publishing even when dedupe returns 'uncertain' (summary-only match)."
  )
  .option(
    "--overlength-strategy <strategy>",
    "Behavior when the draft exceeds destination max-length: 'skip' (default; refuses) or 'truncate' (smart-shorten)."
  )
  .action(async (id, opts) => {
    await postPairCommand(id, {
      approve: Boolean(opts.approve),
      allowUncertain: Boolean(opts.allowUncertain),
      overlengthStrategy: opts.overlengthStrategy,
    });
  });

pair
  .command("backfill")
  .description(
    "Walk back through source history (newest-first), dedupe against both posted.jsonl and the destination platform, and publish missing items on a staggered schedule. " +
      "Default: 2 pages, max 20 publishes, 10 min between posts, dry-run unless --allow-publish is passed."
  )
  .argument("<id>", "Pair id")
  .option("--max <n>", "Maximum number of items to publish", "20")
  .option("--pages <n>", "Number of source pages to fetch", "2")
  .option("--page-size <n>", "Hint for source page size", "10")
  .option("--interval-minutes <n>", "Minutes between publishes", "10")
  .option("--dry-run", "Produce the plan but do not publish")
  .option("--allow-publish", "Permit live publishing. Requires pair.mode=live-approved.")
  .option(
    "--overlength-strategy <strategy>",
    "Behavior when a draft exceeds destination.maxLength: 'skip' (default; safer — drops the candidate at plan time) or 'truncate' (smart-shorten at sentence/word boundary + ellipsis).",
    DEFAULT_OVERLENGTH_STRATEGY
  )
  .option("--json", "Emit a single JSON object on stdout when finished.")
  .action(
    async (
      id: string,
      opts: {
        max?: string;
        pages?: string;
        pageSize?: string;
        intervalMinutes?: string;
        dryRun?: boolean;
        allowPublish?: boolean;
        overlengthStrategy?: string;
        json?: boolean;
      }
    ) => {
      const pairRecord = requirePair(id);
      const allowPublish = Boolean(opts.allowPublish);
      const dryRun = Boolean(opts.dryRun) || !allowPublish;

      if (allowPublish && pairRecord.mode !== "live-approved") {
        console.error(
          `Refusing to backfill with --allow-publish: pair.mode is "${pairRecord.mode}", expected "live-approved".`
        );
        console.error(
          `Run: ${APP_NAME} pair edit ${pairRecord.id} --mode live-approved`
        );
        process.exit(1);
      }

      const overlengthStrategy = parseOverlengthStrategy(opts.overlengthStrategy);

      const result = await runBackfill(pairRecord, {
        max: parsePositiveInteger(opts.max, "max"),
        pages: parsePositiveInteger(opts.pages, "pages"),
        pageSize: parsePositiveInteger(opts.pageSize, "page-size"),
        intervalMinutes:
          parsePositiveInteger(opts.intervalMinutes, "interval-minutes") ?? 10,
        dryRun,
        allowPublish,
        overlengthStrategy,
      });

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        console.log("");
        console.log(`Pair: ${result.pairId}`);
        console.log(`Started:  ${result.startedAt}`);
        console.log(`Finished: ${result.finishedAt}`);
        console.log(`Duration: ${result.durationMs}ms`);
        console.log(
          `Totals: considered=${result.totals.considered} published=${result.totals.published} skippedLocal=${result.totals.skippedLocal} skippedDestination=${result.totals.skippedDestination} skippedAlreadyInRun=${result.totals.skippedAlreadyInRun} skippedOverlength=${result.totals.skippedOverlength} truncated=${result.totals.truncated} failed=${result.totals.failed} dryRunSkipped=${result.totals.dryRunSkipped}`
        );
        if (result.dryRun) {
          console.log("Mode: DRY RUN — no items were published.");
        } else if (!result.allowPublish) {
          console.log("Mode: plan-only — pass --allow-publish to actually publish.");
        }
      }

      if (result.totals.failed > 0) {
        process.exit(2);
      }
    }
  );

pair
  .command("scheduled-run")
  .description(
    "Deterministic scheduled-tick runner. Host scheduler (OpenClaw cron / launchd / cron) should invoke this. " +
      "Always runs preview; only publishes when --allow-publish is passed AND the pair mode is live-approved. " +
      "This is the entry point for `runMode=listen-for-future` pairs."
  )
  .argument("<id>", "Pair id")
  .option(
    "--allow-publish",
    "Permit live publishing during this scheduled tick. Requires pair.mode=live-approved."
  )
  .option("--json", "Emit a single JSON object on stdout (for host announce delivery).")
  .action(async (id: string, opts: { allowPublish?: boolean; json?: boolean }) => {
    const pairRecord = requirePair(id);
    const result = await runScheduled(pairRecord, {
      allowPublish: Boolean(opts.allowPublish),
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      console.log(`Pair: ${result.pairId} (${result.pairName})`);
      console.log(`Outcome: ${result.outcome}`);
      if (result.reason) console.log(`Reason: ${result.reason}`);
      console.log(`Source: ${result.sourceUrl ?? "(not set)"}`);
      console.log(`Destination: ${result.destinationTarget ?? "(not set)"}`);
      console.log(`Candidates considered: ${result.candidateCount}`);
      console.log(`Duration: ${result.durationMs}ms`);
      if (result.draft) {
        console.log(`Draft (${result.draft.chars} chars): ${result.draft.preview}`);
        if (result.draft.warnings.length > 0) {
          console.log(`Warnings: ${result.draft.warnings.join(" | ")}`);
        }
      }
      if (result.publish?.destinationUrl) {
        console.log(`Posted: ${result.publish.destinationUrl}`);
      }
    }
    if (
      result.outcome === "publish-failed" ||
      result.outcome === "auth-failed"
    ) {
      process.exit(2);
    }
  });

pair
  .command("schedule")
  .description(
    "Render or install scheduling artifacts (launchd plist / crontab line / openclaw cron command) for a pair."
  )
  .argument("<id>", "Pair id")
  .option(
    "--apply <target>",
    "Apply the schedule. Targets: launchd (writes plist + prints load cmd), print (default; render only)."
  )
  .option("--allow-publish", "Render the scheduled-run invocation with --allow-publish.")
  .action(
    (
      id: string,
      opts: { apply?: string; allowPublish?: boolean }
    ) => {
      const pairRecord = requirePair(id);
      const inputs = {
        pair: pairRecord,
        allowPublish: Boolean(opts.allowPublish),
      };
      const target = opts.apply || "print";
      if (target === "launchd") {
        const result = installLaunchdPlist(inputs);
        console.log(`Installed launchd plist: ${result.plistPath}`);
        console.log("Load it with:");
        console.log(`  launchctl unload ${result.plistPath} 2>/dev/null || true`);
        console.log(`  launchctl load ${result.plistPath}`);
        console.log(
          "Inspect with: launchctl list | grep com.repost-with-agent"
        );
        return;
      }
      if (target === "print") {
        const plist = renderLaunchdPlist(inputs);
        console.log("# launchd plist");
        console.log(`# Save as ~/Library/LaunchAgents/${plist.filename}`);
        console.log(plist.contents);
        console.log("# crontab line");
        console.log(renderCrontabLine(inputs));
        console.log();
        console.log("# OpenClaw cron command");
        console.log(renderOpenClawCronCommand(inputs));
        console.log();
        console.log("# Direct shell invocation");
        console.log(renderShellCommand(inputs));
        return;
      }
      console.error(
        `Unknown --apply target: ${target}. Expected 'launchd' or 'print'.`
      );
      process.exit(1);
    }
  );

pair
  .command("unschedule")
  .description("Remove an installed launchd plist for a pair (idempotent).")
  .argument("<id>", "Pair id")
  .action((id: string) => {
    requirePair(id);
    const result = uninstallLaunchdPlist(id);
    if (result.removed) {
      console.log(`Removed launchd plist: ${result.plistPath}`);
      console.log(
        `Run: launchctl unload ${result.plistPath} 2>/dev/null || true`
      );
    } else {
      console.log(`No launchd plist installed at ${result.plistPath}`);
    }
    console.log(
      "If you used OpenClaw cron, remove it with: openclaw cron list | grep " +
        `'repost-with-agent ${id}' && openclaw cron rm <job-id>`
    );
  });

pair
  .command("edit")
  .description("Patch fields on a saved pair (mode, run-mode, enabled, schedule, policy, accounts).")
  .argument("<id>", "Pair id")
  .option("--mode <mode>", "preview-only | approval-required | live-approved")
  .option("--run-mode <mode>", "listen-for-future | backfill")
  .option("--enable", "Set enabled=true")
  .option("--disable", "Set enabled=false")
  .option("--schedule-kind <kind>", "manual | cron | every")
  .option("--schedule-expression <expr>", "Cron expression (when kind=cron)")
  .option("--every-minutes <minutes>", "Interval in minutes (when kind=every)")
  .option("--timezone <tz>", "Schedule timezone (IANA)")
  .option("--max-items-per-run <n>", "policy.maxItemsPerRun")
  .option("--min-delay-minutes <n>", "policy.minDelayBetweenPostsMinutes")
  .option("--source-url <url>", "Update source url/profile url")
  .option("--source-platform <platform>", "Update source platform label")
  .option("--destination-account <acct>", "Update destination accountHint")
  .option("--destination-platform <platform>", "Update destination platform label")
  .action((id: string, opts: Record<string, unknown>) => {
    const existing = requirePair(id);
    const next: PairRecord = {
      ...existing,
      source: { ...existing.source },
      destination: { ...existing.destination },
      schedule: { ...existing.schedule },
      policy: { ...existing.policy },
      dedupe: { ...existing.dedupe },
    };

    if (typeof opts.mode === "string") {
      next.mode = parsePairMode(opts.mode as string);
    }
    if (typeof opts.runMode === "string") {
      next.runMode = parseRunMode(opts.runMode as string);
    }
    if (opts.enable === true) next.enabled = true;
    if (opts.disable === true) next.enabled = false;
    if (typeof opts.scheduleKind === "string") {
      next.schedule.kind = parseScheduleKind(opts.scheduleKind as string);
    }
    if (typeof opts.scheduleExpression === "string") {
      next.schedule.expression = opts.scheduleExpression as string;
    }
    if (typeof opts.everyMinutes === "string") {
      next.schedule.everyMinutes = parsePositiveInteger(
        opts.everyMinutes as string,
        "every-minutes"
      );
    }
    if (typeof opts.timezone === "string") {
      next.schedule.tz = resolveScheduleTimezone(opts.timezone as string);
    }
    if (typeof opts.maxItemsPerRun === "string") {
      const n = parsePositiveInteger(
        opts.maxItemsPerRun as string,
        "max-items-per-run"
      );
      if (n) next.policy.maxItemsPerRun = n;
    }
    if (typeof opts.minDelayMinutes === "string") {
      const n = parsePositiveInteger(
        opts.minDelayMinutes as string,
        "min-delay-minutes"
      );
      if (n !== undefined) next.policy.minDelayBetweenPostsMinutes = n;
    }
    if (typeof opts.sourceUrl === "string") {
      next.source.url = opts.sourceUrl as string;
      next.source.profileUrl = opts.sourceUrl as string;
    }
    if (typeof opts.sourcePlatform === "string") {
      next.source.platform = opts.sourcePlatform as string;
    }
    if (typeof opts.destinationAccount === "string") {
      next.destination.accountHint = opts.destinationAccount as string;
    }
    if (typeof opts.destinationPlatform === "string") {
      next.destination.platform = opts.destinationPlatform as string;
    }

    next.updatedAt = nowIso();
    next.schemaVersion = 3;
    upsertPair(next);
    appendAuditEvent({
      at: next.updatedAt,
      event: "pair.edited",
      pairId: next.id,
      details: {
        mode: next.mode,
        runMode: next.runMode,
        enabled: next.enabled,
        schedule: next.schedule,
      },
    });
    console.log(`Updated pair ${next.id}`);
    printPair(next);
  });

const notify = program
  .command("notify")
  .description(
    "Manage the Telegram-on-publish notifier. Every successful publish from this CLI " +
      "fires a Telegram message via this configured channel — silent publishes are a project bug."
  );

notify
  .command("configure")
  .description(
    "Save bot token + chat id to ~/.repost-with-agent/notify.json (perms 0600). " +
      "Pass --test to send a verification message immediately."
  )
  .requiredOption("--bot-token <token>", "Telegram bot token")
  .requiredOption("--chat-id <id>", "Telegram chat id (DM, group, or channel)")
  .option("--test", "Send a verification 'wired up' message immediately")
  .option("--disable", "Set telegram.enabled=false (keeps token saved but mutes notifies)")
  .action(
    async (opts: {
      botToken: string;
      chatId: string;
      test?: boolean;
      disable?: boolean;
    }) => {
      const enabled = !opts.disable;
      const written = writeNotifyConfig({
        enabled,
        botToken: opts.botToken,
        chatId: opts.chatId,
      });
      console.log(`Wrote ${written.path} (mode 0600).`);
      console.log(`Telegram notify ${enabled ? "ENABLED" : "DISABLED"}.`);
      if (opts.test) {
        const config = loadNotifyConfig();
        if (config.source === "none" || !config.telegram) {
          console.error("Test send skipped: notify is disabled in saved config.");
          process.exit(1);
        }
        const text =
          "✅ <b>[Repost-with-agent]</b> Telegram notify wired up.\n" +
          "Future successful publishes from this CLI will Telegram-confirm here.";
        try {
          await sendTelegramMessage(config.telegram, text);
          console.log("Test message delivered.");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Test message failed: ${message}`);
          process.exit(2);
        }
      }
    }
  );

notify
  .command("status")
  .description("Show current notify config source (file / env / none) + masked token.")
  .action(() => {
    const config = loadNotifyConfig();
    const path = getNotifyConfigPath();
    console.log(`Config file: ${path}`);
    console.log(`Resolved source: ${config.source}`);
    if (config.telegram) {
      const t = config.telegram.botToken;
      const masked = t.length > 8 ? `${t.slice(0, 4)}…${t.slice(-4)}` : "(short)";
      console.log(`telegram.enabled: ${config.telegram.enabled}`);
      console.log(`telegram.botToken: ${masked}`);
      console.log(`telegram.chatId: ${config.telegram.chatId}`);
    } else {
      console.log("(unconfigured — every successful publish will warn)");
    }
  });

notify
  .command("test")
  .description("Send a one-off test notify using the currently resolved config.")
  .option("--pair-id <id>", "Pair id to embed in the test body", "test-pair")
  .action(async (opts: { pairId?: string }) => {
    const config = loadNotifyConfig();
    if (config.source === "none" || !config.telegram) {
      console.error(
        "Notify is unconfigured. Run `repost-with-agent notify configure --bot-token <T> --chat-id <C>` first."
      );
      process.exit(1);
    }
    const text = buildPublishMessage({
      pairId: opts.pairId || "test-pair",
      pairName: "Test pair",
      sourceUrl: "https://example.com/source",
      destinationUrl: "https://example.com/destination",
      destinationType: "test",
      content: "This is a test notify from `repost-with-agent notify test`.",
      trigger: "manual-test",
    });
    try {
      await sendTelegramMessage(config.telegram, text);
      console.log("Test notify delivered.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Test notify failed: ${message}`);
      process.exit(2);
    }
  });

// --- URL expander helper commands ---

const urls = program.command("urls").description("URL expander helpers.");

urls
  .command("expand")
  .description("Expand a single URL by following redirects.")
  .argument("<url>", "URL to expand (any 30x-following URL)")
  .action(async (url: string) => {
    const result = await expandUrl(url);
    console.log(JSON.stringify(result, null, 2));
  });

urls
  .command("expand-text")
  .description("Expand every URL in a block of text and emit the rewritten text + per-URL records.")
  .argument("<text>", "Text containing one or more URLs")
  .action(async (text: string) => {
    const result = await expandUrlsInText(text);
    console.log(JSON.stringify(result, null, 2));
  });

program.parse();
