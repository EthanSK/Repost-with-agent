/**
 * Orchestrator — v3.0.0 platform-agnostic core.
 *
 * The orchestrator coordinates preview + publish flows by emitting typed
 * agent tasks (`fetch-source`, `post-to-destination`, `check-destination`)
 * and consuming the matching results. It does NOT touch a browser, an API,
 * or a Playwright instance; that's the agent's job.
 *
 * Every successful publish path calls `notifyPublishSuccess()` after the
 * agent confirms the post AND after `posted.jsonl` is appended. The
 * Telegram-on-publish guarantee is non-negotiable (Ethan voice 5977/5978).
 */

import {
  AgentResult,
  CheckDestinationResult,
  FetchSourceResult,
  PostToDestinationResult,
  isErrorResult,
  newCorrelationId,
} from "./agent-task-contract.js";
import { RunAgentTaskOptions, runAgentTask } from "./agent-runner.js";
import { contentHash, decidePreviewStatus, summarizeText } from "./dedupe.js";
import { notifyPublishSuccess } from "./notify.js";
import {
  appendAuditEvent,
  appendPostedHistory,
  ensurePairDirs,
  loadLearnings,
  loadPostedHistory,
  nowIso,
  resolveDestinationPlatform,
  resolveSourcePlatform,
} from "./runtime.js";
import { truncate } from "./truncate.js";
import { expandUrlsInText } from "./url-expander.js";
import {
  DraftPost,
  PairRecord,
  PreviewItem,
  SourceItem,
} from "./types.js";

/**
 * Public-shaped publish result, kept stable for tests / docs.
 */
export interface PublishResult {
  success: boolean;
  destinationId?: string;
  destinationUrl?: string;
  error?: string;
}

/**
 * Optional destination char limits per platform. Used by the truncate /
 * skip logic when the pair config doesn't override. None of these are hard
 * — the user can override via `pair edit --max-length`.
 *
 * Numbers reflect classic free-tier limits; users on Premium / Verified /
 * paid tiers can pass `--overlength-strategy truncate --no-cap` (or omit
 * entirely) to let longer drafts through.
 */
export const DEFAULT_PLATFORM_MAX_LENGTH: Record<string, number> = {
  x: 280,
  bluesky: 300,
  threads: 500,
  facebook: 63206,
  // LinkedIn destination caps at 3000 for posts, but is rarely used as a
  // destination in this project. Setting a defensive value.
  linkedin: 3000,
};

export interface PreviewOptions {
  /** Test/inline override: in-process agent task handler. */
  agent?: RunAgentTaskOptions;
  /**
   * Skip URL expansion (useful for unit tests). Defaults to enabled.
   */
  skipUrlExpand?: boolean;
}

export async function previewPair(
  pair: PairRecord,
  options: PreviewOptions = {}
): Promise<{
  auth: { source: string; destination: string };
  learnings: string;
  items: PreviewItem[];
}> {
  ensurePairDirs(pair.id);
  const sourcePlatform = resolveSourcePlatform(pair);
  const destPlatform = resolveDestinationPlatform(pair);

  const fetchTask = {
    kind: "fetch-source" as const,
    platform: sourcePlatform,
    source_url: pair.source.url || pair.source.profileUrl || "",
    max_items: Math.max(1, pair.policy.maxItemsPerRun),
    correlation_id: newCorrelationId(`fetch-${pair.id}`),
    pair_id: pair.id,
  };

  const fetchResult = await runAgentTask(fetchTask, options.agent);
  if (isErrorResult(fetchResult)) {
    appendAuditEvent({
      at: nowIso(),
      event: "pair.preview.fetch_failed",
      pairId: pair.id,
      details: {
        sourcePlatform,
        error: fetchResult.error,
        category: fetchResult.category,
      },
    });
    return {
      auth: {
        source: `Source fetch failed: ${fetchResult.error}`,
        destination: "Destination not exercised — source fetch failed first.",
      },
      learnings: loadLearnings(pair.id),
      items: [],
    };
  }
  const sourceItems = ((fetchResult as FetchSourceResult).items || []).map(
    sourceItemFromAgent
  );

  const learnings = loadLearnings(pair.id);
  const posted = loadPostedHistory(pair.id);
  const limited = sourceItems.slice(0, Math.max(pair.policy.maxItemsPerRun, 1));
  const items: PreviewItem[] = [];

  for (const item of limited) {
    const draft = await buildDraftForItem(item, pair, options);
    const decision = decidePreviewStatus(item, posted, pair.policy);
    items.push({ item, draft, decision });
  }

  appendAuditEvent({
    at: nowIso(),
    event: "pair.preview",
    pairId: pair.id,
    details: {
      sourcePlatform,
      destPlatform,
      candidateCount: sourceItems.length,
      previewCount: items.length,
      learningsLoaded: Boolean(learnings.trim()),
    },
  });

  return {
    auth: {
      source: (fetchResult as FetchSourceResult).auth_message || `${sourcePlatform} source fetched OK.`,
      destination: `${destPlatform} destination not exercised at preview time.`,
    },
    learnings,
    items,
  };
}

/**
 * Convert an agent fetch-source-result item into the orchestrator's
 * `SourceItem`. Pure shape adapter.
 */
export function sourceItemFromAgent(
  item: FetchSourceResult["items"][number]
): SourceItem {
  return {
    sourceItemId: item.sourceItemId,
    canonicalUrl: item.canonicalUrl ?? null,
    text: item.text,
    publishedAt: item.publishedAt,
  };
}

/**
 * Build a draft from a source item, applying URL expansion and platform
 * conventions. The "destination" formatting is intentionally minimal in v3 —
 * the agent skill at post-time also has freedom to clean up trailing
 * whitespace etc. The orchestrator just provides:
 *
 *   - URL expansion (lnkd.in/t.co/etc → final destination)
 *   - Optional canonical-source URL appended at the bottom
 *   - Char-limit warnings (informational; the publish path enforces)
 */
export async function buildDraftForItem(
  item: SourceItem,
  pair: PairRecord,
  options: PreviewOptions = {}
): Promise<DraftPost> {
  const destPlatform = resolveDestinationPlatform(pair);
  let body = item.text;
  const warnings: string[] = [];
  const metadata: Record<string, unknown> = { destPlatform };

  if (!options.skipUrlExpand) {
    try {
      const expanded = await expandUrlsInText(body);
      body = expanded.text;
      const realExpansions = expanded.expansions.filter(
        (e) => e.expanded && e.expandedUrl !== e.originalUrl
      );
      if (realExpansions.length > 0) {
        metadata.urlExpansions = realExpansions.map((e) => ({
          shortenedUrl: e.originalUrl,
          expandedUrl: e.expandedUrl,
          hopCount: e.hopCount,
        }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`URL expansion error (fail-soft, original kept): ${message}`);
    }
  }

  // Append canonical source URL when present + not already in body.
  if (item.canonicalUrl && !body.includes(item.canonicalUrl)) {
    body = `${body.trimEnd()}\n\n${item.canonicalUrl}`;
  }

  const maxLength = DEFAULT_PLATFORM_MAX_LENGTH[destPlatform];
  if (typeof maxLength === "number" && body.length > maxLength) {
    warnings.push(
      `Draft (${body.length} chars) exceeds ${destPlatform} max-length (${maxLength}); use --overlength-strategy truncate to auto-shorten or split manually.`
    );
  }

  if (!item.canonicalUrl) {
    warnings.push("Source item has no canonical URL; dedupe relies on source ID/content hash.");
  }

  return {
    destinationType: destPlatform,
    text: body,
    warnings,
    metadata: {
      ...metadata,
      chars: body.length,
      maxLength,
    },
  };
}

export interface PublishPairOptions {
  approve: boolean;
  allowUncertain?: boolean;
  /**
   * Origin of the publish call, recorded in audit events + Telegram notify.
   * "pair-post" (default), "scheduled-run", or "backfill".
   */
  trigger?: string;
  agent?: RunAgentTaskOptions;
  /**
   * Override-strategy when the draft exceeds the destination char cap.
   * "skip" (default) refuses; "truncate" shortens via the truncate helper.
   */
  overlengthStrategy?: "skip" | "truncate";
}

export interface PublishPairOutcome {
  status:
    | "no-candidate"
    | "duplicate"
    | "uncertain-blocked"
    | "needs-approval"
    | "auth-failed"
    | "publish-failed"
    | "overlength-blocked"
    | "published";
  reason?: string;
  preview?: PreviewItem;
  publishResult?: PublishResult;
}

/**
 * Live-publish the next eligible candidate for a pair. v3.0.0: this hands a
 * `post-to-destination` task to the agent and consumes the result.
 *
 * - Refuses to act on `preview-only` pairs unless the caller passes approve=true
 *   AND the policy allows it (matches the `approval-required` / `live-approved`
 *   spirit of pair.mode).
 * - Re-checks dedupe right before posting (race-safe).
 * - Applies URL expansion via `buildDraftForItem`.
 * - On success, appends to posted.jsonl, audit.jsonl, and fires Telegram.
 */
export async function publishNextForPair(
  pair: PairRecord,
  options: PublishPairOptions
): Promise<PublishPairOutcome> {
  ensurePairDirs(pair.id);
  const destPlatform = resolveDestinationPlatform(pair);

  const previewResult = await previewPair(pair, { agent: options.agent });
  const top = previewResult.items[0];

  if (!top) {
    appendAuditEvent({
      at: nowIso(),
      event: "pair.publish.no-candidate",
      pairId: pair.id,
      details: {},
    });
    return { status: "no-candidate", reason: "No candidate items returned by source." };
  }

  if (top.decision.status === "duplicate") {
    appendAuditEvent({
      at: nowIso(),
      event: "pair.publish.skipped",
      pairId: pair.id,
      details: { reason: "duplicate", decision: top.decision },
    });
    return { status: "duplicate", reason: top.decision.reason, preview: top };
  }

  if (top.decision.status === "uncertain" && !options.allowUncertain) {
    appendAuditEvent({
      at: nowIso(),
      event: "pair.publish.skipped",
      pairId: pair.id,
      details: { reason: "uncertain", decision: top.decision },
    });
    return { status: "uncertain-blocked", reason: top.decision.reason, preview: top };
  }

  if (!options.approve) {
    appendAuditEvent({
      at: nowIso(),
      event: "pair.publish.needs-approval",
      pairId: pair.id,
      details: { mode: pair.mode },
    });
    return { status: "needs-approval", reason: "Publish requires explicit --approve.", preview: top };
  }

  if (pair.mode === "preview-only") {
    appendAuditEvent({
      at: nowIso(),
      event: "pair.publish.blocked-by-mode",
      pairId: pair.id,
      details: { mode: pair.mode },
    });
    return {
      status: "needs-approval",
      reason: "Pair mode is preview-only. Set mode to approval-required or live-approved before publishing.",
      preview: top,
    };
  }

  // Re-load posted history right before publishing to catch races.
  const fresh = loadPostedHistory(pair.id);
  const reCheck = decidePreviewStatus(top.item, fresh, pair.policy);
  if (reCheck.status === "duplicate") {
    appendAuditEvent({
      at: nowIso(),
      event: "pair.publish.skipped",
      pairId: pair.id,
      details: { reason: "duplicate-on-recheck", decision: reCheck },
    });
    return { status: "duplicate", reason: reCheck.reason, preview: top };
  }

  // Overlength enforcement.
  let draftText = top.draft.text;
  const maxLen = DEFAULT_PLATFORM_MAX_LENGTH[destPlatform];
  const strategy = options.overlengthStrategy || "skip";
  if (typeof maxLen === "number" && draftText.length > maxLen) {
    if (strategy === "skip") {
      appendAuditEvent({
        at: nowIso(),
        event: "pair.publish.overlength-blocked",
        pairId: pair.id,
        details: {
          chars: draftText.length,
          maxLength: maxLen,
          destPlatform,
          strategy,
        },
      });
      return {
        status: "overlength-blocked",
        reason: `Draft (${draftText.length} chars) exceeds ${destPlatform} max-length (${maxLen}); use --overlength-strategy truncate to auto-shorten.`,
        preview: top,
      };
    }
    const truncResult = truncate(draftText, maxLen);
    if (truncResult.truncated) {
      draftText = truncResult.text;
      appendAuditEvent({
        at: nowIso(),
        event: "pair.publish.truncated",
        pairId: pair.id,
        details: {
          originalChars: truncResult.originalChars,
          finalChars: draftText.length,
          maxLength: maxLen,
          destPlatform,
        },
      });
    }
  }

  // Audit URL expansions before the publish task fires.
  const urlExpansions = (top.draft.metadata?.urlExpansions || []) as Array<{
    shortenedUrl: string;
    expandedUrl: string;
    hopCount: number;
  }>;
  for (const expansion of urlExpansions) {
    appendAuditEvent({
      at: nowIso(),
      event: "pair.publish.url_expanded",
      pairId: pair.id,
      details: { ...expansion, destPlatform },
    });
  }

  const postTask = {
    kind: "post-to-destination" as const,
    platform: destPlatform,
    destination_account: pair.destination.accountHint || pair.destination.pageHint || "",
    draft_text: draftText,
    source_url: top.item.canonicalUrl ?? undefined,
    correlation_id: newCorrelationId(`post-${pair.id}`),
    pair_id: pair.id,
  };

  const taskResult = await runAgentTask(postTask, options.agent);

  if (isErrorResult(taskResult)) {
    const category = taskResult.category;
    if (category === "needs-login" || category === "needs-config") {
      appendAuditEvent({
        at: nowIso(),
        event: "pair.publish.auth-failed",
        pairId: pair.id,
        details: {
          destPlatform,
          error: taskResult.error,
          category,
        },
      });
      return {
        status: "auth-failed",
        reason: taskResult.error,
        preview: top,
        publishResult: { success: false, error: taskResult.error },
      };
    }
    appendAuditEvent({
      at: nowIso(),
      event: "pair.publish.failed",
      pairId: pair.id,
      details: {
        destPlatform,
        error: taskResult.error,
        category,
        sourceUrl: top.item.canonicalUrl,
      },
    });
    return {
      status: "publish-failed",
      reason: taskResult.error,
      preview: top,
      publishResult: { success: false, error: taskResult.error },
    };
  }

  if (taskResult.kind !== "post-to-destination-result") {
    const reason = `Agent returned wrong result kind for post: expected post-to-destination-result, got ${taskResult.kind}`;
    appendAuditEvent({
      at: nowIso(),
      event: "pair.publish.failed",
      pairId: pair.id,
      details: { destPlatform, error: reason },
    });
    return {
      status: "publish-failed",
      reason,
      preview: top,
      publishResult: { success: false, error: reason },
    };
  }

  const postResult = taskResult as PostToDestinationResult;
  const publishResult: PublishResult = {
    success: true,
    destinationId: postResult.posted_id,
    destinationUrl: postResult.posted_url,
  };

  const postedAt = postResult.posted_at || nowIso();
  appendPostedHistory(pair.id, {
    sourceItemId: top.item.sourceItemId,
    canonicalUrl: top.item.canonicalUrl,
    contentHash: contentHash(top.item.text),
    destinationType: destPlatform,
    destinationId: postResult.posted_id,
    destinationUrl: postResult.posted_url,
    postedAt,
    summary: summarizeText(top.item.text, 240),
  });

  appendAuditEvent({
    at: postedAt,
    event: "pair.publish.success",
    pairId: pair.id,
    details: {
      destinationId: postResult.posted_id,
      destinationUrl: postResult.posted_url,
      sourceUrl: top.item.canonicalUrl,
      chars: draftText.length,
      destPlatform,
      trigger: options.trigger || "pair-post",
    },
  });

  // Telegram-on-publish guarantee (Ethan voice 5977 + 5978, 2026-05-01).
  // Same pattern as v2 — fire AFTER the destination publish is confirmed
  // and AFTER we've written the success audit + posted-history entries.
  // Notify failures never roll back the publish.
  const notifyOutcome = await notifyPublishSuccess({
    pairId: pair.id,
    pairName: pair.name,
    sourceUrl: top.item.canonicalUrl ?? undefined,
    destinationUrl: postResult.posted_url,
    destinationType: destPlatform,
    destinationId: postResult.posted_id,
    content: draftText,
    trigger: options.trigger || "pair-post",
  });

  if (notifyOutcome.delivered) {
    appendAuditEvent({
      at: nowIso(),
      event: "notify.publish.success",
      pairId: pair.id,
      details: {
        channel: "telegram",
        configSource: notifyOutcome.source,
        bytes: notifyOutcome.body.length,
      },
    });
  } else if (notifyOutcome.attempted) {
    appendAuditEvent({
      at: nowIso(),
      event: "notify.publish.failure",
      pairId: pair.id,
      details: {
        channel: "telegram",
        configSource: notifyOutcome.source,
        error: notifyOutcome.error,
      },
    });
    appendAuditEvent({
      at: nowIso(),
      event: "pair.publish.notify_failed",
      pairId: pair.id,
      details: {
        channel: "telegram",
        error: notifyOutcome.error,
      },
    });
  } else {
    appendAuditEvent({
      at: nowIso(),
      event: "pair.publish.notify_skipped_unconfigured",
      pairId: pair.id,
      details: {
        hint:
          "Run `repost-with-agent notify configure --bot-token <T> --chat-id <C>` " +
          "or set REPOST_TELEGRAM_BOT_TOKEN + REPOST_TELEGRAM_CHAT_ID.",
      },
    });
  }

  return { status: "published", preview: top, publishResult };
}

/**
 * Cross-state dedupe check via the agent. Used by backfill before publishing
 * each candidate. Fail-soft: lookup errors return `{exists: false}` so the
 * backfill doesn't false-skip on a transient browser hiccup.
 */
export async function checkDestinationForCandidate(
  pair: PairRecord,
  candidateText: string,
  options: { agent?: RunAgentTaskOptions } = {}
): Promise<CheckDestinationResult> {
  const destPlatform = resolveDestinationPlatform(pair);
  const correlation_id = newCorrelationId(`check-${pair.id}`);
  const task = {
    kind: "check-destination" as const,
    platform: destPlatform,
    destination_account: pair.destination.accountHint || pair.destination.pageHint || "",
    candidate_text: candidateText,
    correlation_id,
    pair_id: pair.id,
  };
  const result = await runAgentTask(task, options.agent);
  if (isErrorResult(result)) {
    return {
      kind: "check-destination-result",
      correlation_id,
      exists: false,
      reason: `lookup-error: ${result.error}`,
    };
  }
  if (result.kind !== "check-destination-result") {
    return {
      kind: "check-destination-result",
      correlation_id,
      exists: false,
      reason: `lookup-error: agent returned wrong result kind ${result.kind}`,
    };
  }
  return result as CheckDestinationResult;
}

/**
 * Re-export so the legacy AgentResult union stays accessible from a single
 * import in `index.ts`.
 */
export type { AgentResult };
