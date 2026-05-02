/**
 * Backfill mode — v3.0.0 platform-agnostic, agent-driven.
 *
 * Walks back through the source platform's history (multiple pages) via the
 * agent's `fetch-source` task, cross-checks both local `posted.jsonl` and
 * the destination platform itself (via the agent's `check-destination`
 * task), and publishes anything missing on a staggered schedule.
 *
 * Ordering change in v3 (Ethan voice 6021, 2026-05-01): backfill now orders
 * candidates **newest-first**. v2 ordered oldest-first; the rationale flipped
 * because Ethan wanted recent-old posts to land first when re-bootstrapping a
 * destination account, since they're more likely to still be relevant.
 *
 * The loop, the resume state file, and the audit-event taxonomy match v2 so
 * existing tooling and dashboards continue to work.
 */

import * as fs from "fs";
import * as path from "path";
import {
  CheckDestinationResult,
  FetchSourceResult,
  PostToDestinationResult,
  isErrorResult,
  newCorrelationId,
} from "./agent-task-contract.js";
import { RunAgentTaskOptions, runAgentTask } from "./agent-runner.js";
import { contentHash, summarizeText } from "./dedupe.js";
import { notifyPublishSuccess } from "./notify.js";
import {
  buildDraftForItem,
  sourceItemFromAgent,
  DEFAULT_PLATFORM_MAX_LENGTH,
} from "./orchestrator.js";
import {
  appendAuditEvent,
  appendPostedHistory,
  ensurePairDirs,
  loadPostedHistory,
  nowIso,
  resolveDestinationPlatform,
  resolveSourcePlatform,
} from "./runtime.js";
import { truncate } from "./truncate.js";
import {
  AuditEvent,
  DraftPost,
  PairRecord,
  PostedHistoryEntry,
  SourceItem,
} from "./types.js";

export type OverlengthStrategy = "skip" | "truncate";

/** Default policy when the user doesn't pass `--overlength-strategy`. */
export const DEFAULT_OVERLENGTH_STRATEGY: OverlengthStrategy = "skip";

export interface BackfillOptions {
  /** Maximum number of items to publish in this run. Default: 20. */
  max?: number;
  /** Number of source pages to fetch. Default: 2. */
  pages?: number;
  /** Page size hint passed to the source skill. Default: 10. */
  pageSize?: number;
  /** Interval between successive publishes, in minutes. Default: 10. */
  intervalMinutes?: number;
  /** When false (default), produce a plan but do not actually publish. */
  allowPublish?: boolean;
  /**
   * If true, return after producing the plan without entering the publish
   * loop. Useful for dry-runs from CI / agent scripts.
   */
  dryRun?: boolean;
  /** Override clock used for scheduling (testing only). */
  now?: () => Date;
  /** Override the per-tick wait. Defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Override stdout writer (testing only). Default writes to process.stdout. */
  writeLine?: (line: string) => void;
  /**
   * Test/inline override for the agent runner. When omitted, tasks go through
   * the inbox path.
   */
  agent?: RunAgentTaskOptions;
  /**
   * Behavior when a draft exceeds the destination's `maxLength`:
   *  - "skip" (default): drop the candidate at plan time with audit event
   *    `pair.backfill.skipped_overlength`. The publish loop never sees it.
   *  - "truncate": call `truncate(draft, maxLength)` to smart-shorten the
   *    draft at sentence/word boundary + ellipsis.
   * Adapters that don't declare `maxLength` are unaffected by this option.
   */
  overlengthStrategy?: OverlengthStrategy;
  /**
   * Override the destination char cap. When omitted, falls back to
   * `DEFAULT_PLATFORM_MAX_LENGTH[destPlatform]`. Pass `null` to disable
   * cap enforcement entirely (e.g. for a verified / Premium account).
   */
  destinationMaxLength?: number | null;
}

export interface BackfillCandidatePlan {
  index: number;
  sourceItemId?: string;
  canonicalUrl?: string | null;
  page: number;
  publishedAtSource?: string;
  draftChars: number;
  draftPreview: string;
  scheduledAt: string;
  decisionAtPlan: "publish" | "skip-local" | "skip-too-long" | "truncate";
  reason?: string;
  destinationMaxLength?: number;
  truncatedDraftText?: string;
  truncatedDraftChars?: number;
}

export interface BackfillPlan {
  pairId: string;
  pairName: string;
  generatedAt: string;
  options: Required<
    Pick<
      BackfillOptions,
      | "max"
      | "pages"
      | "pageSize"
      | "intervalMinutes"
      | "allowPublish"
      | "overlengthStrategy"
    >
  >;
  totalConsidered: number;
  skippedLocal: number;
  skippedOverlength: number;
  truncatedCount: number;
  destinationMaxLength?: number;
  candidates: BackfillCandidatePlan[];
  postedHistoryCount: number;
  destinationLookupSupported: boolean;
}

export type BackfillItemOutcome =
  | "published"
  | "skip-local"
  | "skip-destination"
  | "skip-already-published-in-run"
  | "skip-too-long"
  | "publish-failed"
  | "auth-failed"
  | "dry-run-skipped"
  | "lookup-error";

export interface BackfillItemResult {
  index: number;
  sourceItemId?: string;
  canonicalUrl?: string | null;
  decision: BackfillItemOutcome;
  reason?: string;
  destinationUrl?: string;
  destinationId?: string;
  scheduledAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  destinationLookup?: CheckDestinationResult;
  truncated?: boolean;
  originalDraftChars?: number;
  finalDraftChars?: number;
}

export interface BackfillResult {
  pairId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  plan: BackfillPlan;
  items: BackfillItemResult[];
  totals: {
    considered: number;
    published: number;
    skippedLocal: number;
    skippedDestination: number;
    skippedAlreadyInRun: number;
    skippedOverlength: number;
    truncated: number;
    failed: number;
    dryRunSkipped: number;
  };
  dryRun: boolean;
  allowPublish: boolean;
}

interface BackfillStateFile {
  pairId: string;
  startedAt: string;
  updatedAt: string;
  publishedSourceItemIds: string[];
  publishedCanonicalUrls: string[];
  publishedContentHashes: string[];
  lastIndex: number;
}

const BACKFILL_PUBLISH_START = "pair.backfill.publish.start";
const BACKFILL_PUBLISH_END = "pair.backfill.publish.end";
const BACKFILL_SKIP_LOCAL = "pair.backfill.skip.local";
const BACKFILL_SKIP_DESTINATION = "pair.backfill.skip.destination";
const BACKFILL_SKIP_ALREADY = "pair.backfill.skip.already-in-run";
const BACKFILL_SKIPPED_OVERLENGTH = "pair.backfill.skipped_overlength";
const BACKFILL_TRUNCATED = "pair.backfill.truncated";
const BACKFILL_PLAN = "pair.backfill.plan";
const BACKFILL_START = "pair.backfill.start";
const BACKFILL_COMPLETE = "pair.backfill.complete";
const BACKFILL_ERROR = "pair.backfill.error";
const BACKFILL_WAIT = "pair.backfill.wait";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultWriteLine(line: string): void {
  process.stdout.write(line + "\n");
}

function backfillStatePath(pairId: string): string {
  const paths = ensurePairDirs(pairId);
  return path.join(paths.rootDir, "backfill-state.json");
}

function loadBackfillState(pairId: string): BackfillStateFile | null {
  const file = backfillStatePath(pairId);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as BackfillStateFile;
    return parsed;
  } catch {
    return null;
  }
}

function saveBackfillState(state: BackfillStateFile): void {
  const file = backfillStatePath(state.pairId);
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function clearBackfillState(pairId: string): void {
  const file = backfillStatePath(pairId);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

function hasLocalMatch(
  item: SourceItem,
  posted: PostedHistoryEntry[]
): { match: boolean; reason?: string } {
  if (
    item.sourceItemId &&
    posted.some((entry) => entry.sourceItemId && entry.sourceItemId === item.sourceItemId)
  ) {
    return { match: true, reason: "Matched source item id in pair history." };
  }
  if (
    item.canonicalUrl &&
    posted.some((entry) => entry.canonicalUrl && entry.canonicalUrl === item.canonicalUrl)
  ) {
    return { match: true, reason: "Matched canonical source URL in pair history." };
  }
  const itemHash = contentHash(item.text);
  if (posted.some((entry) => entry.contentHash && entry.contentHash === itemHash)) {
    return { match: true, reason: "Matched normalized content hash in pair history." };
  }
  return { match: false };
}

function alreadyInRunState(
  item: SourceItem,
  draft: DraftPost,
  state: BackfillStateFile
): boolean {
  if (item.sourceItemId && state.publishedSourceItemIds.includes(item.sourceItemId)) {
    return true;
  }
  if (item.canonicalUrl && state.publishedCanonicalUrls.includes(item.canonicalUrl)) {
    return true;
  }
  const draftHash = contentHash(draft.text);
  if (state.publishedContentHashes.includes(draftHash)) {
    return true;
  }
  return false;
}

export interface FetchedPage {
  page: number;
  items: SourceItem[];
}

/**
 * Fetch all requested pages from the source via the agent.
 */
export async function fetchAllPages(
  pair: PairRecord,
  pages: number,
  pageSize: number,
  agent?: RunAgentTaskOptions
): Promise<FetchedPage[]> {
  const out: FetchedPage[] = [];
  let cursor: string | undefined;
  const sourcePlatform = resolveSourcePlatform(pair);
  for (let page = 1; page <= pages; page += 1) {
    const task = {
      kind: "fetch-source" as const,
      platform: sourcePlatform,
      source_url: pair.source.url || pair.source.profileUrl || "",
      max_items: pageSize,
      page,
      cursor,
      correlation_id: newCorrelationId(`fetch-${pair.id}-p${page}`),
      pair_id: pair.id,
    };
    const result = await runAgentTask(task, agent);
    if (isErrorResult(result)) {
      // Bail; the caller decides what to do with `out`.
      throw new Error(
        `Source fetch (page ${page}) failed: ${result.error}` +
          (result.category ? ` [${result.category}]` : "")
      );
    }
    if (result.kind !== "fetch-source-result") {
      throw new Error(
        `Source fetch (page ${page}) returned wrong result kind: ${result.kind}`
      );
    }
    const fetchResult = result as FetchSourceResult;
    out.push({
      page,
      items: fetchResult.items.map(sourceItemFromAgent),
    });
    cursor = fetchResult.nextCursor;
    if (!fetchResult.hasMore && page < pages) {
      break;
    }
  }
  return out;
}

/**
 * v3.0.0: order **newest-first** based on `publishedAt` when present, falling
 * back to original source order. Stable across ties.
 *
 * (v2 ordered oldest-first; flipped per Ethan voice 6021 — recent-old posts
 * are more relevant to a destination account being re-bootstrapped.)
 */
export function orderNewestFirst<T extends { publishedAt?: string }>(items: T[]): T[] {
  const indexed = items.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => {
    const aTime = a.value.publishedAt ? Date.parse(a.value.publishedAt) : NaN;
    const bTime = b.value.publishedAt ? Date.parse(b.value.publishedAt) : NaN;
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);
    if (aValid && bValid) {
      if (aTime !== bTime) return bTime - aTime; // descending = newest first
      return a.index - b.index;
    }
    if (aValid) return -1;
    if (bValid) return 1;
    // Neither has publishedAt — use ORIGINAL order (sources typically return
    // newest first already).
    return a.index - b.index;
  });
  return indexed.map((entry) => entry.value);
}

/**
 * Build the publish plan from fetched pages + posted history. Pure function;
 * used both by the live runner and by tests.
 */
export function buildBackfillPlan(args: {
  pair: PairRecord;
  pages: FetchedPage[];
  posted: PostedHistoryEntry[];
  options: BackfillOptions;
  destinationLookupSupported: boolean;
  generatedAt?: Date;
  /** Look up the destination draft text for an item (already previewed). */
  draftTextFor?: (item: SourceItem) => string | undefined;
  /** Destination's hard char limit. Pass null to disable. */
  destinationMaxLength?: number | null;
}): BackfillPlan {
  const max = Math.max(1, args.options.max ?? 20);
  const pageCount = Math.max(1, args.options.pages ?? 2);
  const pageSize = Math.max(1, args.options.pageSize ?? 10);
  const intervalMinutes = Math.max(0, args.options.intervalMinutes ?? 10);
  const allowPublish = Boolean(args.options.allowPublish);
  const overlengthStrategy: OverlengthStrategy =
    args.options.overlengthStrategy ?? DEFAULT_OVERLENGTH_STRATEGY;
  const generatedAt = args.generatedAt ?? new Date();
  const maxLen = args.destinationMaxLength === null
    ? undefined
    : args.destinationMaxLength;

  // Tag each item with its page and dedupe across pages.
  const seen = new Set<string>();
  const tagged: Array<{ item: SourceItem; page: number }> = [];
  for (const page of args.pages) {
    for (const item of page.items) {
      const key = item.sourceItemId || item.canonicalUrl || contentHash(item.text);
      if (seen.has(key)) continue;
      seen.add(key);
      tagged.push({ item, page: page.page });
    }
  }

  const ordered = orderNewestFirst(
    tagged.map((entry) => ({ ...entry.item, _page: entry.page }))
  );

  const candidates: BackfillCandidatePlan[] = [];
  let skippedLocal = 0;
  let skippedOverlength = 0;
  let truncatedCount = 0;
  let publishCount = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    if (publishCount >= max) break;
    const enriched = ordered[i] as SourceItem & { _page: number };
    const local = hasLocalMatch(enriched, args.posted);
    if (local.match) {
      skippedLocal += 1;
      continue;
    }
    const scheduledAt = new Date(
      generatedAt.getTime() + publishCount * intervalMinutes * 60 * 1000
    ).toISOString();

    const draftText = args.draftTextFor?.(enriched) ?? enriched.text;
    const draftChars = draftText.length;

    let decisionAtPlan: BackfillCandidatePlan["decisionAtPlan"] = "publish";
    let truncatedDraftText: string | undefined;
    let truncatedDraftChars: number | undefined;
    let reason: string | undefined;
    if (typeof maxLen === "number" && draftChars > maxLen) {
      if (overlengthStrategy === "skip") {
        decisionAtPlan = "skip-too-long";
        reason = `Draft (${draftChars} chars) exceeds destination max-length (${maxLen}); strategy=skip.`;
        skippedOverlength += 1;
      } else {
        const result = truncate(draftText, maxLen);
        if (result.truncated) {
          decisionAtPlan = "truncate";
          truncatedDraftText = result.text;
          truncatedDraftChars = result.text.length;
          truncatedCount += 1;
          reason = `Draft (${draftChars} chars) truncated to ${truncatedDraftChars} chars to fit destination max-length (${maxLen}).`;
        }
      }
    }

    candidates.push({
      index: candidates.length,
      sourceItemId: enriched.sourceItemId,
      canonicalUrl: enriched.canonicalUrl ?? null,
      page: enriched._page,
      publishedAtSource: enriched.publishedAt,
      draftChars,
      draftPreview: summarizeText(draftText, 160),
      scheduledAt,
      decisionAtPlan,
      reason,
      destinationMaxLength:
        decisionAtPlan === "skip-too-long" || decisionAtPlan === "truncate"
          ? maxLen
          : undefined,
      truncatedDraftText,
      truncatedDraftChars,
    });
    if (decisionAtPlan !== "skip-too-long") {
      publishCount += 1;
    }
  }

  return {
    pairId: args.pair.id,
    pairName: args.pair.name,
    generatedAt: generatedAt.toISOString(),
    options: {
      max,
      pages: pageCount,
      pageSize,
      intervalMinutes,
      allowPublish,
      overlengthStrategy,
    },
    totalConsidered: tagged.length,
    skippedLocal,
    skippedOverlength,
    truncatedCount,
    destinationMaxLength: maxLen,
    candidates,
    postedHistoryCount: args.posted.length,
    destinationLookupSupported: args.destinationLookupSupported,
  };
}

/**
 * Top-level backfill runner. Produces a plan, optionally publishes each
 * eligible item with destination-dedupe + interval-based pacing.
 */
export async function runBackfill(
  pair: PairRecord,
  options: BackfillOptions = {}
): Promise<BackfillResult> {
  ensurePairDirs(pair.id);
  const startedAt = nowIso();
  const startWall = Date.now();
  const writeLine = options.writeLine ?? defaultWriteLine;
  const sleep = options.sleep ?? defaultSleep;
  const max = Math.max(1, options.max ?? 20);
  const pages = Math.max(1, options.pages ?? 2);
  const pageSize = Math.max(1, options.pageSize ?? 10);
  const intervalMinutes = Math.max(0, options.intervalMinutes ?? 10);
  const dryRun = Boolean(options.dryRun);
  const allowPublish = Boolean(options.allowPublish) && !dryRun;
  const overlengthStrategy: OverlengthStrategy =
    options.overlengthStrategy ?? DEFAULT_OVERLENGTH_STRATEGY;
  const destPlatform = resolveDestinationPlatform(pair);
  const destinationMaxLength =
    options.destinationMaxLength === null
      ? null
      : options.destinationMaxLength ?? DEFAULT_PLATFORM_MAX_LENGTH[destPlatform];
  // For agent-driven dedupe, we ALWAYS support it (the agent can scrape its
  // own destination). The skill is responsible for actually doing the work.
  const destinationLookupSupported = true;

  const baseEvent: Omit<AuditEvent, "event" | "details"> = {
    at: startedAt,
    pairId: pair.id,
  };

  appendAuditEvent({
    ...baseEvent,
    event: BACKFILL_START,
    details: {
      max,
      pages,
      pageSize,
      intervalMinutes,
      allowPublish,
      dryRun,
      destinationLookupSupported,
      overlengthStrategy,
      destinationMaxLength,
      destPlatform,
      sourcePlatform: resolveSourcePlatform(pair),
      ordering: "newest-first",
    },
  });
  writeLine(
    `[backfill] start pair=${pair.id} max=${max} pages=${pages} interval=${intervalMinutes}m dryRun=${dryRun} allowPublish=${allowPublish} overlength=${overlengthStrategy} order=newest-first`
  );

  // Fetch source pages.
  let fetched: FetchedPage[];
  try {
    fetched = await fetchAllPages(pair, pages, pageSize, options.agent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendAuditEvent({
      at: nowIso(),
      pairId: pair.id,
      event: BACKFILL_ERROR,
      details: { phase: "fetch", error: message },
    });
    writeLine(`[backfill] error during source fetch: ${message}`);
    throw err;
  }
  const totalFetched = fetched.reduce((sum, p) => sum + p.items.length, 0);
  writeLine(
    `[backfill] fetched ${totalFetched} item(s) across ${fetched.length} page(s) (page sizes: ${fetched.map((p) => p.items.length).join(", ")})`
  );

  // Pre-build drafts for plan-time overlength evaluation. The agent's
  // `post-to-destination` task at publish time will use the same shape.
  const draftCache = new Map<string, DraftPost>();
  const itemKey = (item: SourceItem): string =>
    item.sourceItemId || item.canonicalUrl || contentHash(item.text);
  for (const page of fetched) {
    for (const item of page.items) {
      const key = itemKey(item);
      if (draftCache.has(key)) continue;
      try {
        const draft = await buildDraftForItem(item, pair, {
          agent: options.agent,
        });
        draftCache.set(key, draft);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeLine(
          `[backfill] draft build error for ${item.canonicalUrl || "(no-url)"}: ${message}`
        );
      }
    }
  }

  const posted = loadPostedHistory(pair.id);
  const plan = buildBackfillPlan({
    pair,
    pages: fetched,
    posted,
    options: {
      max,
      pages,
      pageSize,
      intervalMinutes,
      allowPublish,
      overlengthStrategy,
    },
    destinationLookupSupported,
    generatedAt: options.now ? options.now() : new Date(),
    draftTextFor: (item) => draftCache.get(itemKey(item))?.text,
    destinationMaxLength,
  });

  appendAuditEvent({
    ...baseEvent,
    at: plan.generatedAt,
    event: BACKFILL_PLAN,
    details: {
      candidateCount: plan.candidates.length,
      totalConsidered: plan.totalConsidered,
      skippedLocal: plan.skippedLocal,
      skippedOverlength: plan.skippedOverlength,
      truncatedCount: plan.truncatedCount,
      postedHistoryCount: plan.postedHistoryCount,
      destinationLookupSupported,
      overlengthStrategy,
      destinationMaxLength: plan.destinationMaxLength,
      ordering: "newest-first",
    },
  });

  // Plan-time overlength events.
  for (const candidate of plan.candidates) {
    if (
      candidate.decisionAtPlan === "skip-too-long" &&
      candidate.destinationMaxLength !== undefined
    ) {
      appendAuditEvent({
        ...baseEvent,
        at: plan.generatedAt,
        event: BACKFILL_SKIPPED_OVERLENGTH,
        details: {
          pairId: pair.id,
          sourceItemId: candidate.sourceItemId,
          canonicalUrl: candidate.canonicalUrl,
          draftChars: candidate.draftChars,
          destinationMaxLength: candidate.destinationMaxLength,
          strategy: overlengthStrategy,
        },
      });
    } else if (
      candidate.decisionAtPlan === "truncate" &&
      candidate.destinationMaxLength !== undefined
    ) {
      appendAuditEvent({
        ...baseEvent,
        at: plan.generatedAt,
        event: BACKFILL_TRUNCATED,
        details: {
          pairId: pair.id,
          sourceItemId: candidate.sourceItemId,
          canonicalUrl: candidate.canonicalUrl,
          originalDraftChars: candidate.draftChars,
          truncatedDraftChars: candidate.truncatedDraftChars,
          destinationMaxLength: candidate.destinationMaxLength,
          strategy: overlengthStrategy,
        },
      });
    }
  }

  writeLine(
    `[backfill] plan: ${plan.candidates.length} candidate(s) (publish=${plan.candidates.filter((c) => c.decisionAtPlan === "publish" || c.decisionAtPlan === "truncate").length} truncated=${plan.truncatedCount} skip-too-long=${plan.skippedOverlength}), ${plan.skippedLocal} skipped by local dedupe, posted history has ${plan.postedHistoryCount} entr${plan.postedHistoryCount === 1 ? "y" : "ies"}`
  );
  for (const candidate of plan.candidates) {
    const tag =
      candidate.decisionAtPlan === "skip-too-long"
        ? " [skip-too-long]"
        : candidate.decisionAtPlan === "truncate"
          ? ` [truncated→${candidate.truncatedDraftChars}]`
          : "";
    writeLine(
      `[backfill]   #${candidate.index + 1} page=${candidate.page} scheduledAt=${candidate.scheduledAt} chars=${candidate.draftChars}${tag} ${candidate.canonicalUrl || "(no-url)"}`
    );
  }

  const items: BackfillItemResult[] = [];
  const totals = {
    considered: plan.candidates.length,
    published: 0,
    skippedLocal: plan.skippedLocal,
    skippedDestination: 0,
    skippedAlreadyInRun: 0,
    skippedOverlength: plan.skippedOverlength,
    truncated: 0,
    failed: 0,
    dryRunSkipped: 0,
  };

  if (dryRun || !allowPublish) {
    for (const candidate of plan.candidates) {
      if (candidate.decisionAtPlan === "skip-too-long") {
        items.push({
          index: candidate.index,
          sourceItemId: candidate.sourceItemId,
          canonicalUrl: candidate.canonicalUrl,
          decision: "skip-too-long",
          reason: candidate.reason,
          scheduledAt: candidate.scheduledAt,
          originalDraftChars: candidate.draftChars,
        });
        continue;
      }
      const truncated = candidate.decisionAtPlan === "truncate";
      items.push({
        index: candidate.index,
        sourceItemId: candidate.sourceItemId,
        canonicalUrl: candidate.canonicalUrl,
        decision: "dry-run-skipped",
        reason: dryRun
          ? "dry-run mode — plan only"
          : "allowPublish=false — plan only",
        scheduledAt: candidate.scheduledAt,
        truncated: truncated || undefined,
        originalDraftChars: truncated ? candidate.draftChars : undefined,
        finalDraftChars: truncated
          ? candidate.truncatedDraftChars
          : candidate.draftChars,
      });
      if (truncated) totals.truncated += 1;
      totals.dryRunSkipped += 1;
    }
    const finishedAt = nowIso();
    appendAuditEvent({
      ...baseEvent,
      at: finishedAt,
      event: BACKFILL_COMPLETE,
      details: { ...totals, dryRun, allowPublish, durationMs: Date.now() - startWall },
    });
    writeLine(
      `[backfill] complete (dry-run) considered=${totals.considered} dryRunSkipped=${totals.dryRunSkipped} skippedOverlength=${totals.skippedOverlength} truncated=${totals.truncated}`
    );
    return {
      pairId: pair.id,
      startedAt,
      finishedAt,
      durationMs: Date.now() - startWall,
      plan,
      items,
      totals,
      dryRun,
      allowPublish,
    };
  }

  // Live publish path. Resume state file.
  let state = loadBackfillState(pair.id);
  if (!state) {
    state = {
      pairId: pair.id,
      startedAt,
      updatedAt: startedAt,
      publishedSourceItemIds: [],
      publishedCanonicalUrls: [],
      publishedContentHashes: [],
      lastIndex: -1,
    };
    saveBackfillState(state);
  }

  for (const candidate of plan.candidates) {
    // Plan-time skip-too-long candidates.
    if (candidate.decisionAtPlan === "skip-too-long") {
      const result: BackfillItemResult = {
        index: candidate.index,
        sourceItemId: candidate.sourceItemId,
        canonicalUrl: candidate.canonicalUrl,
        decision: "skip-too-long",
        reason: candidate.reason,
        scheduledAt: candidate.scheduledAt,
        originalDraftChars: candidate.draftChars,
      };
      writeLine(
        `[backfill] #${candidate.index + 1} skip (too-long) ${candidate.canonicalUrl || "(no-url)"} chars=${candidate.draftChars} max=${candidate.destinationMaxLength}`
      );
      items.push(result);
      continue;
    }

    const item = await rehydrateItem(candidate, fetched);
    if (!item) {
      continue;
    }
    let draft = await buildDraftForItem(item, pair, { agent: options.agent });

    let didTruncate = false;
    let originalDraftChars: number | undefined;
    if (
      candidate.decisionAtPlan === "truncate" &&
      candidate.destinationMaxLength !== undefined
    ) {
      originalDraftChars = draft.text.length;
      const result = truncate(draft.text, candidate.destinationMaxLength);
      if (result.truncated) {
        draft = { ...draft, text: result.text };
        didTruncate = true;
        totals.truncated += 1;
      }
    }

    // Resume guard.
    if (alreadyInRunState(item, draft, state)) {
      totals.skippedAlreadyInRun += 1;
      const result: BackfillItemResult = {
        index: candidate.index,
        sourceItemId: item.sourceItemId,
        canonicalUrl: item.canonicalUrl,
        decision: "skip-already-published-in-run",
        reason: "Marked as published in earlier backfill-state for this pair.",
        scheduledAt: candidate.scheduledAt,
      };
      appendAuditEvent({
        ...baseEvent,
        at: nowIso(),
        event: BACKFILL_SKIP_ALREADY,
        details: { ...result } as Record<string, unknown>,
      });
      writeLine(
        `[backfill] #${candidate.index + 1} skip (already-in-run) ${item.canonicalUrl || "(no-url)"}`
      );
      items.push(result);
      continue;
    }

    // Re-check local dedupe.
    const freshPosted = loadPostedHistory(pair.id);
    const localCheck = hasLocalMatch(item, freshPosted);
    if (localCheck.match) {
      totals.skippedLocal += 1;
      const result: BackfillItemResult = {
        index: candidate.index,
        sourceItemId: item.sourceItemId,
        canonicalUrl: item.canonicalUrl,
        decision: "skip-local",
        reason: localCheck.reason,
        scheduledAt: candidate.scheduledAt,
      };
      appendAuditEvent({
        ...baseEvent,
        at: nowIso(),
        event: BACKFILL_SKIP_LOCAL,
        details: { ...result } as Record<string, unknown>,
      });
      writeLine(
        `[backfill] #${candidate.index + 1} skip (local) ${localCheck.reason}`
      );
      items.push(result);
      continue;
    }

    // Destination-side dedupe via the agent's check-destination task.
    const checkTask = {
      kind: "check-destination" as const,
      platform: destPlatform,
      destination_account: pair.destination.accountHint || pair.destination.pageHint || "",
      candidate_text: draft.text,
      correlation_id: newCorrelationId(`check-${pair.id}-${candidate.index}`),
      pair_id: pair.id,
    };
    const checkResult = await runAgentTask(checkTask, options.agent);
    let destinationLookup: CheckDestinationResult | undefined;
    if (isErrorResult(checkResult)) {
      destinationLookup = {
        kind: "check-destination-result",
        correlation_id: checkTask.correlation_id,
        exists: false,
        reason: `lookup-error: ${checkResult.error}`,
      };
    } else if (checkResult.kind === "check-destination-result") {
      destinationLookup = checkResult as CheckDestinationResult;
    } else {
      destinationLookup = {
        kind: "check-destination-result",
        correlation_id: checkTask.correlation_id,
        exists: false,
        reason: `lookup-error: agent returned wrong result kind ${checkResult.kind}`,
      };
    }

    if (destinationLookup.exists) {
      totals.skippedDestination += 1;
      const result: BackfillItemResult = {
        index: candidate.index,
        sourceItemId: item.sourceItemId,
        canonicalUrl: item.canonicalUrl,
        decision: "skip-destination",
        reason:
          destinationLookup.reason || "Destination already has equivalent post.",
        destinationUrl: destinationLookup.url,
        destinationId: destinationLookup.posted_id,
        scheduledAt: candidate.scheduledAt,
        destinationLookup,
      };
      appendAuditEvent({
        ...baseEvent,
        at: nowIso(),
        event: BACKFILL_SKIP_DESTINATION,
        details: { ...result } as Record<string, unknown>,
      });
      writeLine(
        `[backfill] #${candidate.index + 1} skip (destination) ${destinationLookup.url || destinationLookup.posted_id || destinationLookup.reason}`
      );
      // Append to posted.jsonl so future runs short-circuit on local dedupe.
      appendPostedHistory(pair.id, {
        sourceItemId: item.sourceItemId,
        canonicalUrl: item.canonicalUrl,
        contentHash: contentHash(item.text),
        destinationType: destPlatform,
        destinationId: destinationLookup.posted_id,
        destinationUrl: destinationLookup.url,
        postedAt: destinationLookup.postedAt || nowIso(),
        summary: summarizeText(item.text, 240),
        importedFrom: `backfill-destination-dedupe`,
      });
      items.push(result);
      continue;
    }

    // Wait until the scheduled time before publishing.
    const scheduledMs = Date.parse(candidate.scheduledAt);
    const nowFn = options.now ?? (() => new Date());
    const waitMs = Math.max(0, scheduledMs - nowFn().getTime());
    if (waitMs > 0) {
      writeLine(
        `[backfill] #${candidate.index + 1} wait ${Math.round(waitMs / 1000)}s until ${candidate.scheduledAt}`
      );
      appendAuditEvent({
        ...baseEvent,
        at: nowIso(),
        event: BACKFILL_WAIT,
        details: { index: candidate.index, scheduledAt: candidate.scheduledAt, waitMs },
      });
      await sleep(waitMs);
    }

    // Publish via agent.
    const startedItemAt = nowIso();
    appendAuditEvent({
      ...baseEvent,
      at: startedItemAt,
      event: BACKFILL_PUBLISH_START,
      details: {
        index: candidate.index,
        sourceItemId: item.sourceItemId,
        canonicalUrl: item.canonicalUrl,
        chars: draft.text.length,
        destPlatform,
      },
    });
    writeLine(
      `[backfill] #${candidate.index + 1} publish.start ${item.canonicalUrl || "(no-url)"} chars=${draft.text.length}`
    );

    // Audit URL expansions for this draft.
    const urlExpansions = (draft.metadata?.urlExpansions || []) as Array<{
      shortenedUrl: string;
      expandedUrl: string;
      hopCount: number;
    }>;
    for (const expansion of urlExpansions) {
      appendAuditEvent({
        ...baseEvent,
        at: nowIso(),
        event: "pair.publish.url_expanded",
        details: { ...expansion, destPlatform, backfillIndex: candidate.index },
      });
    }

    const postTask = {
      kind: "post-to-destination" as const,
      platform: destPlatform,
      destination_account: pair.destination.accountHint || pair.destination.pageHint || "",
      draft_text: draft.text,
      source_url: item.canonicalUrl ?? undefined,
      correlation_id: newCorrelationId(`post-${pair.id}-${candidate.index}`),
      pair_id: pair.id,
    };
    const postResult = await runAgentTask(postTask, options.agent);

    const finishedItemAt = nowIso();
    if (isErrorResult(postResult)) {
      const isAuth =
        postResult.category === "needs-login" ||
        postResult.category === "needs-config";
      const result: BackfillItemResult = {
        index: candidate.index,
        sourceItemId: item.sourceItemId,
        canonicalUrl: item.canonicalUrl,
        decision: isAuth ? "auth-failed" : "publish-failed",
        reason: postResult.error,
        scheduledAt: candidate.scheduledAt,
        startedAt: startedItemAt,
        finishedAt: finishedItemAt,
        durationMs: Date.parse(finishedItemAt) - Date.parse(startedItemAt),
      };
      totals.failed += 1;
      writeLine(
        `[backfill] #${candidate.index + 1} publish.end ${isAuth ? "AUTH-FAILED" : "FAILED"} ${result.reason}`
      );
      appendAuditEvent({
        ...baseEvent,
        at: finishedItemAt,
        event: BACKFILL_PUBLISH_END,
        details: { ...result } as Record<string, unknown>,
      });
      items.push(result);
      // Auth failure halts the rest of the backfill.
      if (isAuth) break;
      continue;
    }

    if (postResult.kind !== "post-to-destination-result") {
      const result: BackfillItemResult = {
        index: candidate.index,
        sourceItemId: item.sourceItemId,
        canonicalUrl: item.canonicalUrl,
        decision: "publish-failed",
        reason: `Agent returned wrong result kind for post: ${postResult.kind}`,
        scheduledAt: candidate.scheduledAt,
        startedAt: startedItemAt,
        finishedAt: finishedItemAt,
      };
      totals.failed += 1;
      appendAuditEvent({
        ...baseEvent,
        at: finishedItemAt,
        event: BACKFILL_PUBLISH_END,
        details: { ...result } as Record<string, unknown>,
      });
      items.push(result);
      continue;
    }

    const post = postResult as PostToDestinationResult;
    const result: BackfillItemResult = {
      index: candidate.index,
      sourceItemId: item.sourceItemId,
      canonicalUrl: item.canonicalUrl,
      decision: "published",
      destinationUrl: post.posted_url,
      destinationId: post.posted_id,
      scheduledAt: candidate.scheduledAt,
      startedAt: startedItemAt,
      finishedAt: finishedItemAt,
      durationMs: Date.parse(finishedItemAt) - Date.parse(startedItemAt),
      truncated: didTruncate || undefined,
      originalDraftChars: didTruncate ? originalDraftChars : undefined,
      finalDraftChars: draft.text.length,
    };
    totals.published += 1;
    appendPostedHistory(pair.id, {
      sourceItemId: item.sourceItemId,
      canonicalUrl: item.canonicalUrl,
      contentHash: contentHash(item.text),
      destinationType: destPlatform,
      destinationId: post.posted_id,
      destinationUrl: post.posted_url,
      postedAt: finishedItemAt,
      summary: summarizeText(item.text, 240),
      importedFrom: "backfill",
    });
    if (item.sourceItemId) state.publishedSourceItemIds.push(item.sourceItemId);
    if (item.canonicalUrl) state.publishedCanonicalUrls.push(item.canonicalUrl);
    state.publishedContentHashes.push(contentHash(item.text));
    state.lastIndex = candidate.index;
    state.updatedAt = finishedItemAt;
    saveBackfillState(state);

    appendAuditEvent({
      ...baseEvent,
      at: finishedItemAt,
      event: BACKFILL_PUBLISH_END,
      details: { ...result } as Record<string, unknown>,
    });
    writeLine(
      `[backfill] #${candidate.index + 1} publish.end OK ${post.posted_url}`
    );

    // Telegram-on-publish guarantee.
    const notifyOutcome = await notifyPublishSuccess({
      pairId: pair.id,
      pairName: pair.name,
      sourceUrl: item.canonicalUrl ?? undefined,
      destinationUrl: post.posted_url,
      destinationType: destPlatform,
      destinationId: post.posted_id,
      content: draft.text,
      trigger: "backfill",
    });
    if (notifyOutcome.delivered) {
      appendAuditEvent({
        ...baseEvent,
        at: nowIso(),
        event: "notify.publish.success",
        details: {
          channel: "telegram",
          configSource: notifyOutcome.source,
          bytes: notifyOutcome.body.length,
          backfillIndex: candidate.index,
        },
      });
    } else if (notifyOutcome.attempted) {
      appendAuditEvent({
        ...baseEvent,
        at: nowIso(),
        event: "notify.publish.failure",
        details: {
          channel: "telegram",
          configSource: notifyOutcome.source,
          error: notifyOutcome.error,
          backfillIndex: candidate.index,
        },
      });
      appendAuditEvent({
        ...baseEvent,
        at: nowIso(),
        event: "pair.publish.notify_failed",
        details: {
          channel: "telegram",
          error: notifyOutcome.error,
          trigger: "backfill",
          backfillIndex: candidate.index,
        },
      });
    } else {
      appendAuditEvent({
        ...baseEvent,
        at: nowIso(),
        event: "pair.publish.notify_skipped_unconfigured",
        details: {
          trigger: "backfill",
          backfillIndex: candidate.index,
          hint:
            "Run `repost-with-agent notify configure --bot-token <T> --chat-id <C>` " +
            "or set REPOST_TELEGRAM_BOT_TOKEN + REPOST_TELEGRAM_CHAT_ID.",
        },
      });
    }

    items.push(result);
  }

  const finishedAt = nowIso();
  const durationMs = Date.now() - startWall;
  appendAuditEvent({
    ...baseEvent,
    at: finishedAt,
    event: BACKFILL_COMPLETE,
    details: { ...totals, durationMs, dryRun, allowPublish },
  });
  writeLine(
    `[backfill] complete published=${totals.published} skippedLocal=${totals.skippedLocal} skippedDestination=${totals.skippedDestination} skippedAlready=${totals.skippedAlreadyInRun} failed=${totals.failed} duration=${durationMs}ms`
  );

  if (
    totals.published + totals.skippedLocal + totals.skippedDestination +
      totals.skippedAlreadyInRun >=
      plan.candidates.length &&
    totals.failed === 0
  ) {
    clearBackfillState(pair.id);
  }

  return {
    pairId: pair.id,
    startedAt,
    finishedAt,
    durationMs,
    plan,
    items,
    totals,
    dryRun,
    allowPublish,
  };
}

async function rehydrateItem(
  candidate: BackfillCandidatePlan,
  pages: FetchedPage[]
): Promise<SourceItem | null> {
  for (const page of pages) {
    for (const item of page.items) {
      if (
        candidate.sourceItemId &&
        item.sourceItemId === candidate.sourceItemId
      ) {
        return item;
      }
      if (
        candidate.canonicalUrl &&
        item.canonicalUrl === candidate.canonicalUrl
      ) {
        return item;
      }
    }
  }
  return null;
}

export const _internals = {
  hasLocalMatch,
  alreadyInRunState,
  backfillStatePath,
  loadBackfillState,
  saveBackfillState,
  clearBackfillState,
};
