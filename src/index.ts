#!/usr/bin/env node

import { Command } from "commander";
import { linkedInSourceAdapter } from "./adapters/sources/linkedin.js";
import { xDestinationAdapter } from "./adapters/destinations/x.js";
import { startOAuth2Flow } from "./x-client.js";
import { loadTracker } from "./tracker.js";
import {
  getLegacyTrackerPath,
  loadPostedHistory,
} from "./core/runtime.js";
import { runLegacyList, runLegacyStart, runLegacySync } from "./legacy-commands.js";
import { previewPair, publishNextForPair } from "./core/orchestrator.js";
import { DEFAULT_POLICY, normalizePolicy } from "./core/policy.js";
import {
  appendAuditEvent,
  appendPostedHistory,
  defaultPairName,
  getEnvironmentSummary,
  getPairById,
  getPairPaths,
  loadAuditHistory,
  loadPairsStore,
  nowIso,
  resolveScheduleTimezone,
  slugifyPairId,
  upsertPair,
  writeDefaultLearnings,
} from "./core/runtime.js";
import { PairMode, PairRecord, PairScheduleKind } from "./core/types.js";
import { contentHash, summarizeText } from "./core/dedupe.js";
import { APP_NAME, getLegacyDataDir, getLegacyTokensPath } from "./config.js";

const VERSION = "2.2.0";

const SOURCE_ADAPTERS = new Map([[linkedInSourceAdapter.type, linkedInSourceAdapter]]);
const DESTINATION_ADAPTERS = new Map([[xDestinationAdapter.type, xDestinationAdapter]]);

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

async function createPair(opts: {
  id?: string;
  name?: string;
  sourceType: string;
  sourceUrl?: string;
  destinationType: string;
  destinationAccount?: string;
  mode?: string;
  enabled?: boolean;
  scheduleKind?: string;
  scheduleExpression?: string;
  everyMinutes?: string;
  timezone?: string;
  authRefSource?: string;
  authRefDestination?: string;
}): Promise<void> {
  const idBase =
    opts.id ||
    opts.name ||
    `${opts.sourceType}-${opts.destinationType}`;
  const pairId = slugifyPairId(idBase);
  const existing = getPairById(pairId);
  if (existing) {
    console.error(`Pair already exists: ${pairId}`);
    process.exit(1);
  }

  const now = nowIso();
  const mode = parsePairMode(opts.mode);
  const scheduleKind = parseScheduleKind(opts.scheduleKind);
  const everyMinutes = parsePositiveInteger(opts.everyMinutes, "every-minutes");
  const pair: PairRecord = {
    id: pairId,
    name: opts.name || defaultPairName(opts.sourceType, opts.destinationType),
    enabled: Boolean(opts.enabled),
    mode,
    source: {
      type: opts.sourceType,
      url: opts.sourceUrl,
      profileUrl: opts.sourceUrl,
      authRef: opts.authRefSource,
    },
    destination: {
      type: opts.destinationType,
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
  };

  upsertPair(pair);
  writeDefaultLearnings(pair.id);
  appendAuditEvent({
    at: now,
    event: "pair.created",
    pairId: pair.id,
    details: {
      sourceType: pair.source.type,
      destinationType: pair.destination.type,
      mode: pair.mode,
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
  const sourceAdapter = SOURCE_ADAPTERS.get(pair.source.type);
  const destinationAdapter = DESTINATION_ADAPTERS.get(pair.destination.type);

  if (!sourceAdapter) {
    console.error(`No source adapter registered for ${pair.source.type}`);
    process.exit(1);
  }
  if (!destinationAdapter) {
    console.error(`No destination adapter registered for ${pair.destination.type}`);
    process.exit(1);
  }

  const result = await previewPair(pair, sourceAdapter, destinationAdapter);
  console.log(`Pair: ${pair.id} (${pair.name})`);
  console.log(`Mode: ${pair.mode}`);
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
    console.log();
  });
}

async function postPairCommand(
  pairId: string,
  opts: { approve: boolean; allowUncertain: boolean }
): Promise<void> {
  const pair = requirePair(pairId);
  const sourceAdapter = SOURCE_ADAPTERS.get(pair.source.type);
  const destinationAdapter = DESTINATION_ADAPTERS.get(pair.destination.type);

  if (!sourceAdapter) {
    console.error(`No source adapter registered for ${pair.source.type}`);
    process.exit(1);
  }
  if (!destinationAdapter) {
    console.error(`No destination adapter registered for ${pair.destination.type}`);
    process.exit(1);
  }

  const outcome = await publishNextForPair(pair, sourceAdapter, destinationAdapter, {
    approve: opts.approve,
    allowUncertain: opts.allowUncertain,
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
    if (entry.destinationId) {
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

function importLegacyTracker(pairId: string): number {
  const trackerPath = getLegacyTrackerPath();
  const entries = loadTracker(trackerPath);
  for (const entry of entries) {
    appendPostedHistory(pairId, {
      contentHash: contentHash(entry.linkedinSnippet),
      destinationType: "x-account",
      destinationId: entry.xPostId,
      postedAt: entry.datePostedToX,
      summary: entry.linkedinSnippet,
      importedFrom: trackerPath,
    });
  }
  return entries.length;
}

async function migrateLegacyPair(opts: {
  id?: string;
  name?: string;
  sourceUrl?: string;
  destinationAccount?: string;
}): Promise<void> {
  const pairId = slugifyPairId(opts.id || "linkedin-to-x");
  const existing = getPairById(pairId);
  if (existing) {
    console.error(`Pair already exists: ${pairId}`);
    process.exit(1);
  }

  const now = nowIso();
  const pair: PairRecord = {
    id: pairId,
    name: opts.name || "Legacy LinkedIn to X",
    enabled: false,
    mode: "preview-only",
    source: {
      type: "linkedin-profile-activity",
      url: opts.sourceUrl || process.env.LINKEDIN_PROFILE_URL,
      profileUrl: opts.sourceUrl || process.env.LINKEDIN_PROFILE_URL,
      authRef: "browser:playwright:linkedin",
    },
    destination: {
      type: "x-account",
      accountHint: opts.destinationAccount,
      authRef: "oauth:x",
    },
    schedule: {
      kind: "manual",
      tz: resolveScheduleTimezone(undefined),
    },
    policy: { ...DEFAULT_POLICY },
    dedupe: {
      strategy: "source-id-url-content-hash",
    },
    createdAt: now,
    updatedAt: now,
  };

  upsertPair(pair);
  writeDefaultLearnings(pair.id);
  const importedCount = importLegacyTracker(pair.id);
  appendAuditEvent({
    at: now,
    event: "pair.migrated.linkedin-to-x",
    pairId: pair.id,
    details: {
      importedCount,
      legacyDataDir: getLegacyDataDir(),
      legacyTokensPath: getLegacyTokensPath(),
      duplicateReference: "https://x.com/i/status/2036422890271215716",
      fixCommit: "9d37108",
    },
  });

  console.log(`Migrated legacy pair to ${pair.id}`);
  console.log(`Imported ${importedCount} legacy tracker entries from ${getLegacyTrackerPath()}`);
  console.log("Legacy files were left untouched.");
}

const program = new Command();

program
  .name(APP_NAME)
  .description("Generic source-to-destination reposting with pair-based, preview-first workflows")
  .version(VERSION);

program
  .command("auth")
  .description("Authorize an X account via OAuth 2.0 PKCE")
  .action(async () => {
    const clientId = process.env.X_CLIENT_ID;
    const clientSecret = process.env.X_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.error("Missing X_CLIENT_ID or X_CLIENT_SECRET in environment.");
      process.exit(1);
    }

    await startOAuth2Flow(clientId, clientSecret);
  });

const pair = program.command("pair").description("Manage saved repost source-to-destination pairs");

pair
  .command("create")
  .description("Create a saved pair using flags")
  .requiredOption("--source-type <type>", "Source adapter type, e.g. linkedin-profile-activity")
  .requiredOption("--destination-type <type>", "Destination adapter type, e.g. x-account")
  .option("--id <id>", "Pair id")
  .option("--name <name>", "Human-friendly pair name")
  .option("--source-url <url>", "Source profile/feed URL")
  .option("--destination-account <account>", "Destination account hint, e.g. @example")
  .option("--mode <mode>", "preview-only | approval-required | live-approved")
  .option("--enabled", "Enable the pair immediately")
  .option("--schedule-kind <kind>", "manual | cron | every", "manual")
  .option("--schedule-expression <expr>", "Cron expression")
  .option("--every-minutes <minutes>", "Every N minutes")
  .option("--timezone <tz>", "Schedule timezone")
  .option("--auth-ref-source <ref>", "Source auth reference")
  .option("--auth-ref-destination <ref>", "Destination auth reference")
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
      console.log(
        `${entry.id} | ${entry.enabled ? "enabled" : "disabled"} | ${entry.mode} | ${entry.source.type} -> ${entry.destination.type}`
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
  .action(async (id, opts) => {
    await postPairCommand(id, {
      approve: Boolean(opts.approve),
      allowUncertain: Boolean(opts.allowUncertain),
    });
  });

const migrate = program.command("migrate").description("Migration helpers");

migrate
  .command("linkedin-to-x")
  .description("Create a pair and import legacy tracker history")
  .option("--id <id>", "Pair id", "linkedin-to-x")
  .option("--name <name>", "Pair name", "Legacy LinkedIn to X")
  .option("--source-url <url>", "LinkedIn source URL")
  .option("--destination-account <account>", "Destination X account hint")
  .action(migrateLegacyPair);

program
  .command("sync")
  .description("Legacy direct LinkedIn -> X/Facebook sync (deprecated)")
  .option("--dry-run", "Show what would be posted without actually posting")
  .option("--facebook-only", "Only post to Facebook (skip X)")
  .option("--x-only", "Only post to X (skip Facebook even if enabled)")
  .action(runLegacySync);

program
  .command("list")
  .description("Legacy direct LinkedIn -> X/Facebook status (deprecated)")
  .action(runLegacyList);

program
  .command("start")
  .description("Legacy continuous LinkedIn -> X sync loop (deprecated)")
  .option("--interval <minutes>", "Minutes between checks", "60")
  .action(runLegacyStart);

program.parse();
