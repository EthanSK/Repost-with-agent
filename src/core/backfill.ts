import * as fs from "fs";
import * as path from "path";
import {
  DestinationAdapter,
  DestinationLookupResult,
  PublishResult,
} from "../adapters/destination.js";
import { SourceAdapter } from "../adapters/source.js";
import { contentHash, summarizeText } from "./dedupe.js";
import { notifyPublishSuccess } from "./notify.js";
import {
  appendAuditEvent,
  appendPostedHistory,
  ensurePairDirs,
  loadPostedHistory,
  nowIso,
} from "./runtime.js";
import {
  AuditEvent,
  DraftPost,
  PairRecord,
  PostedHistoryEntry,
  SourceItem,
} from "./types.js";

/**
 * Backfill mode: walk back through the source's history (multiple pages),
 * cross-check both local `posted.jsonl` and the destination platform itself
 * for already-posted items, and publish anything missing on a staggered
 * schedule.
 *
 * Default policy: 2 pages, 20 max publishes, 10-minute interval between
 * posts, oldest-first ordering. Re-running the same backfill against the
 * same pair is idempotent — items already in `posted.jsonl` are skipped, and
 * a `backfill-state.json` file in the pair dir records progress.
 *
 * Live progress is emitted both to stdout (one line per state transition,
 * tail-friendly) and to `audit.jsonl` (structured `pair.backfill.*` events).
 */

export interface BackfillOptions {
  /** Maximum number of items to publish in this run. Default: 20. */
  max?: number;
  /** Number of source pages to fetch. Default: 2. */
  pages?: number;
  /** Page size hint passed to the source adapter. Default: 10. */
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
  /**
   * Override clock used for scheduling (testing only).
   */
  now?: () => Date;
  /**
   * Override the per-tick wait. Defaults to a real `setTimeout`. Tests inject
   * a no-op.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Override stdout writer (testing only). Default writes to process.stdout.
   */
  writeLine?: (line: string) => void;
  /**
   * Override the destination-dedupe lookup (testing only). When omitted, the
   * destination adapter's `findExistingPost()` is used (or "skipped" if the
   * adapter doesn't implement it).
   */
  lookupOverride?: (
    draft: DraftPost,
    pair: PairRecord
  ) => Promise<DestinationLookupResult>;
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
  /**
   * Local-dedupe verdict run at planning time. Items decided as "skip-local"
   * are filtered out of the plan and never reach the publish loop.
   */
  decisionAtPlan: "publish" | "skip-local";
  reason?: string;
}

export interface BackfillPlan {
  pairId: string;
  pairName: string;
  generatedAt: string;
  options: Required<
    Pick<
      BackfillOptions,
      "max" | "pages" | "pageSize" | "intervalMinutes" | "allowPublish"
    >
  >;
  totalConsidered: number;
  skippedLocal: number;
  candidates: BackfillCandidatePlan[];
  /** Total items already in posted.jsonl when planning was done. */
  postedHistoryCount: number;
  destinationLookupSupported: boolean;
}

export type BackfillItemOutcome =
  | "published"
  | "skip-local"
  | "skip-destination"
  | "skip-already-published-in-run"
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
  destinationLookup?: DestinationLookupResult;
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

export async function fetchAllPages(
  pair: PairRecord,
  source: SourceAdapter,
  pages: number,
  pageSize: number
): Promise<FetchedPage[]> {
  const out: FetchedPage[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= pages; page += 1) {
    if (source.fetchPage) {
      const result = await source.fetchPage(pair, { page, pageSize, cursor });
      out.push({ page, items: result.items });
      cursor = result.nextCursor;
      if (!result.hasMore && page < pages) {
        // Source said no more — stop early.
        break;
      }
    } else {
      // Adapter doesn't support pagination — single fallback fetch.
      const items = await source.fetchCandidates(pair);
      out.push({ page: 1, items });
      break;
    }
  }
  return out;
}

/**
 * Order items oldest-first based on `publishedAt` when present, falling back
 * to the original (newest-first) source ordering reversed. Stable across
 * ties.
 */
export function orderOldestFirst<T extends { publishedAt?: string }>(items: T[]): T[] {
  // Capture the original index so ties stay deterministic.
  const indexed = items.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => {
    const aTime = a.value.publishedAt ? Date.parse(a.value.publishedAt) : NaN;
    const bTime = b.value.publishedAt ? Date.parse(b.value.publishedAt) : NaN;
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);
    if (aValid && bValid) {
      if (aTime !== bTime) return aTime - bTime;
      return a.index - b.index;
    }
    if (aValid) return -1;
    if (bValid) return 1;
    // Neither has a publishedAt — use REVERSE original order (newest-first
    // becomes oldest-first).
    return b.index - a.index;
  });
  return indexed.map((entry) => entry.value);
}

/**
 * Build the publish plan WITHOUT calling the destination. Pure function over
 * fetched pages + posted history; used both by the live runner and by tests
 * to verify ordering / pagination / cap behavior.
 */
export function buildBackfillPlan(args: {
  pair: PairRecord;
  pages: FetchedPage[];
  posted: PostedHistoryEntry[];
  options: BackfillOptions;
  destinationLookupSupported: boolean;
  generatedAt?: Date;
}): BackfillPlan {
  const max = Math.max(1, args.options.max ?? 20);
  const pageCount = Math.max(1, args.options.pages ?? 2);
  const pageSize = Math.max(1, args.options.pageSize ?? 10);
  const intervalMinutes = Math.max(0, args.options.intervalMinutes ?? 10);
  const allowPublish = Boolean(args.options.allowPublish);
  const generatedAt = args.generatedAt ?? new Date();

  // Tag each item with its page and dedupe across pages (same canonical URL
  // can appear on consecutive pages if LinkedIn re-renders).
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

  const ordered = orderOldestFirst(
    tagged.map((entry) => ({ ...entry.item, _page: entry.page }))
  );

  const candidates: BackfillCandidatePlan[] = [];
  let skippedLocal = 0;
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
    candidates.push({
      index: candidates.length,
      sourceItemId: enriched.sourceItemId,
      canonicalUrl: enriched.canonicalUrl ?? null,
      page: enriched._page,
      publishedAtSource: enriched.publishedAt,
      draftChars: enriched.text.length,
      draftPreview: summarizeText(enriched.text, 160),
      scheduledAt,
      decisionAtPlan: "publish",
    });
    publishCount += 1;
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
    },
    totalConsidered: tagged.length,
    skippedLocal,
    candidates,
    postedHistoryCount: args.posted.length,
    destinationLookupSupported: args.destinationLookupSupported,
  };
}

/**
 * Top-level backfill runner. Produces a plan, optionally publishes each
 * eligible item with destination-dedupe + interval-based pacing, and emits
 * structured audit events.
 */
export async function runBackfill(
  pair: PairRecord,
  source: SourceAdapter,
  destination: DestinationAdapter,
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
  const destinationLookupSupported = Boolean(
    options.lookupOverride || destination.findExistingPost
  );

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
    },
  });
  writeLine(
    `[backfill] start pair=${pair.id} max=${max} pages=${pages} interval=${intervalMinutes}m dryRun=${dryRun} allowPublish=${allowPublish}`
  );

  // Fetch source pages.
  let fetched: FetchedPage[];
  try {
    fetched = await fetchAllPages(pair, source, pages, pageSize);
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

  const posted = loadPostedHistory(pair.id);
  const plan = buildBackfillPlan({
    pair,
    pages: fetched,
    posted,
    options: { max, pages, pageSize, intervalMinutes, allowPublish },
    destinationLookupSupported,
    generatedAt: options.now ? options.now() : new Date(),
  });

  appendAuditEvent({
    ...baseEvent,
    at: plan.generatedAt,
    event: BACKFILL_PLAN,
    details: {
      candidateCount: plan.candidates.length,
      totalConsidered: plan.totalConsidered,
      skippedLocal: plan.skippedLocal,
      postedHistoryCount: plan.postedHistoryCount,
      destinationLookupSupported,
    },
  });

  writeLine(
    `[backfill] plan: ${plan.candidates.length} candidate(s) to publish, ${plan.skippedLocal} skipped by local dedupe, posted history has ${plan.postedHistoryCount} entr${plan.postedHistoryCount === 1 ? "y" : "ies"}`
  );
  for (const candidate of plan.candidates) {
    writeLine(
      `[backfill]   #${candidate.index + 1} page=${candidate.page} scheduledAt=${candidate.scheduledAt} chars=${candidate.draftChars} ${candidate.canonicalUrl || "(no-url)"}`
    );
  }

  // If pure dry-run, return now.
  const items: BackfillItemResult[] = [];
  const totals = {
    considered: plan.candidates.length,
    published: 0,
    skippedLocal: plan.skippedLocal,
    skippedDestination: 0,
    skippedAlreadyInRun: 0,
    failed: 0,
    dryRunSkipped: 0,
  };

  if (dryRun || !allowPublish) {
    for (const candidate of plan.candidates) {
      items.push({
        index: candidate.index,
        sourceItemId: candidate.sourceItemId,
        canonicalUrl: candidate.canonicalUrl,
        decision: "dry-run-skipped",
        reason: dryRun
          ? "dry-run mode — plan only"
          : "allowPublish=false — plan only",
        scheduledAt: candidate.scheduledAt,
      });
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
      `[backfill] complete (dry-run) considered=${totals.considered} dryRunSkipped=${totals.dryRunSkipped}`
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

  // Live publish path. Load (or initialize) the resume state file so that
  // re-running this backfill picks up where it left off.
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

  const lookup = options.lookupOverride
    ? options.lookupOverride
    : destination.findExistingPost
      ? destination.findExistingPost.bind(destination)
      : null;

  for (const candidate of plan.candidates) {
    const item = await rehydrateItem(pair, source, candidate, fetched);
    if (!item) {
      // Should not happen — defensive.
      continue;
    }
    const draft = await destination.preview(item, pair);

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

    // Re-check local dedupe (covers concurrent posts via other code paths).
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

    // Destination dedupe.
    let destinationLookup: DestinationLookupResult | undefined;
    if (lookup) {
      try {
        destinationLookup = await lookup(draft, pair);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        destinationLookup = {
          exists: false,
          reason: `lookup-error: ${message}`,
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
          destinationId: destinationLookup.id,
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
          `[backfill] #${candidate.index + 1} skip (destination) ${destinationLookup.url || destinationLookup.id || destinationLookup.reason}`
        );
        // Also append to posted.jsonl so future runs short-circuit on local
        // dedupe and don't burn an X API call.
        appendPostedHistory(pair.id, {
          sourceItemId: item.sourceItemId,
          canonicalUrl: item.canonicalUrl,
          contentHash: contentHash(item.text),
          destinationType: destination.type,
          destinationId: destinationLookup.id,
          postedAt:
            destinationLookup.postedAt || nowIso(),
          summary: summarizeText(item.text, 240),
          importedFrom: `backfill-destination-dedupe`,
        });
        items.push(result);
        continue;
      }
    }

    // Wait until the scheduled time before publishing. We only wait when the
    // scheduledAt is in the future (so resume-after-kill doesn't eat the
    // remaining window of all skipped items).
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

    // Publish.
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
      },
    });
    writeLine(
      `[backfill] #${candidate.index + 1} publish.start ${item.canonicalUrl || "(no-url)"} chars=${draft.text.length}`
    );

    if (!destination.publish) {
      const result: BackfillItemResult = {
        index: candidate.index,
        sourceItemId: item.sourceItemId,
        canonicalUrl: item.canonicalUrl,
        decision: "publish-failed",
        reason: `Destination adapter ${destination.type} has no publish() implementation.`,
        scheduledAt: candidate.scheduledAt,
        startedAt: startedItemAt,
        finishedAt: nowIso(),
      };
      totals.failed += 1;
      writeLine(`[backfill] #${candidate.index + 1} publish.end FAILED ${result.reason}`);
      appendAuditEvent({
        ...baseEvent,
        at: result.finishedAt!,
        event: BACKFILL_PUBLISH_END,
        details: { ...result } as Record<string, unknown>,
      });
      items.push(result);
      continue;
    }

    // Refresh destination auth health right before posting.
    const auth = await destination.test(pair);
    if (!auth.ok) {
      const result: BackfillItemResult = {
        index: candidate.index,
        sourceItemId: item.sourceItemId,
        canonicalUrl: item.canonicalUrl,
        decision: "auth-failed",
        reason: auth.message,
        scheduledAt: candidate.scheduledAt,
        startedAt: startedItemAt,
        finishedAt: nowIso(),
      };
      totals.failed += 1;
      writeLine(`[backfill] #${candidate.index + 1} publish.end AUTH-FAILED ${auth.message}`);
      appendAuditEvent({
        ...baseEvent,
        at: result.finishedAt!,
        event: BACKFILL_PUBLISH_END,
        details: { ...result } as Record<string, unknown>,
      });
      items.push(result);
      // Auth failure halts the rest of the backfill — bail out so we don't
      // hammer the destination with N more failed calls.
      break;
    }

    let publishResult: PublishResult;
    try {
      publishResult = await destination.publish(item, draft, pair);
    } catch (err) {
      publishResult = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const finishedItemAt = nowIso();
    if (publishResult.success && publishResult.destinationId) {
      const result: BackfillItemResult = {
        index: candidate.index,
        sourceItemId: item.sourceItemId,
        canonicalUrl: item.canonicalUrl,
        decision: "published",
        destinationUrl: publishResult.destinationUrl,
        destinationId: publishResult.destinationId,
        scheduledAt: candidate.scheduledAt,
        startedAt: startedItemAt,
        finishedAt: finishedItemAt,
        durationMs: Date.parse(finishedItemAt) - Date.parse(startedItemAt),
      };
      totals.published += 1;
      // Persist to posted.jsonl.
      appendPostedHistory(pair.id, {
        sourceItemId: item.sourceItemId,
        canonicalUrl: item.canonicalUrl,
        contentHash: contentHash(item.text),
        destinationType: destination.type,
        destinationId: publishResult.destinationId,
        postedAt: finishedItemAt,
        summary: summarizeText(item.text, 240),
        importedFrom: "backfill",
      });
      // Persist resume state.
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
        `[backfill] #${candidate.index + 1} publish.end OK ${publishResult.destinationUrl}`
      );

      // Telegram-on-publish guarantee (Ethan voice 5977 + 5978, 2026-05-01).
      // Same pattern as `publishNextForPair`: fire AFTER the destination
      // confirms + after we've persisted posted.jsonl + state. Notify
      // failures never roll back the publish.
      const notifyOutcome = await notifyPublishSuccess({
        pairId: pair.id,
        pairName: pair.name,
        sourceUrl: item.canonicalUrl ?? undefined,
        destinationUrl: publishResult.destinationUrl,
        destinationType: destination.type,
        destinationId: publishResult.destinationId,
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
    } else {
      const result: BackfillItemResult = {
        index: candidate.index,
        sourceItemId: item.sourceItemId,
        canonicalUrl: item.canonicalUrl,
        decision: "publish-failed",
        reason: publishResult.error || "Unknown publish failure.",
        scheduledAt: candidate.scheduledAt,
        startedAt: startedItemAt,
        finishedAt: finishedItemAt,
        durationMs: Date.parse(finishedItemAt) - Date.parse(startedItemAt),
      };
      totals.failed += 1;
      appendAuditEvent({
        ...baseEvent,
        at: finishedItemAt,
        event: BACKFILL_PUBLISH_END,
        details: { ...result } as Record<string, unknown>,
      });
      writeLine(
        `[backfill] #${candidate.index + 1} publish.end FAILED ${result.reason}`
      );
      items.push(result);
    }
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

  // Clear backfill-state if we published the entire plan and didn't fail.
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

/**
 * Re-locate a SourceItem from the fetched pages by canonicalUrl/sourceItemId.
 * Needed because the plan only carries the lightweight projection.
 */
async function rehydrateItem(
  _pair: PairRecord,
  _source: SourceAdapter,
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
