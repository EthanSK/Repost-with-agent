import { DestinationAdapter, PublishResult } from "../adapters/destination.js";
import { SourceAdapter } from "../adapters/source.js";
import { contentHash, decidePreviewStatus, summarizeText } from "./dedupe.js";
import {
  appendAuditEvent,
  appendPostedHistory,
  ensurePairDirs,
  loadLearnings,
  loadPostedHistory,
  nowIso,
} from "./runtime.js";
import { PairRecord, PreviewItem } from "./types.js";

export async function previewPair(
  pair: PairRecord,
  sourceAdapter: SourceAdapter,
  destinationAdapter: DestinationAdapter
): Promise<{
  auth: { source: string; destination: string };
  learnings: string;
  items: PreviewItem[];
}> {
  ensurePairDirs(pair.id);
  const [sourceAuth, destinationAuth, sourceItems] = await Promise.all([
    sourceAdapter.test(pair),
    destinationAdapter.test(pair),
    sourceAdapter.fetchCandidates(pair),
  ]);

  const learnings = loadLearnings(pair.id);
  const posted = loadPostedHistory(pair.id);
  const limited = sourceItems.slice(0, Math.max(pair.policy.maxItemsPerRun, 1));
  const items: PreviewItem[] = [];

  for (const item of limited) {
    const draft = await destinationAdapter.preview(item, pair);
    const decision = decidePreviewStatus(item, posted, pair.policy);
    items.push({ item, draft, decision });
  }

  appendAuditEvent({
    at: nowIso(),
    event: "pair.preview",
    pairId: pair.id,
    details: {
      sourceType: pair.source.type,
      destinationType: pair.destination.type,
      sourceStatus: sourceAuth.status,
      destinationStatus: destinationAuth.status,
      candidateCount: sourceItems.length,
      previewCount: items.length,
      learningsLoaded: Boolean(learnings.trim()),
    },
  });

  return {
    auth: {
      source: sourceAuth.message,
      destination: destinationAuth.message,
    },
    learnings,
    items,
  };
}

export interface PublishPairOptions {
  approve: boolean;
  allowUncertain?: boolean;
}

export interface PublishPairOutcome {
  status:
    | "no-candidate"
    | "duplicate"
    | "uncertain-blocked"
    | "needs-approval"
    | "auth-failed"
    | "publish-failed"
    | "published";
  reason?: string;
  preview?: PreviewItem;
  publishResult?: PublishResult;
}

/**
 * Live-publish the next eligible candidate for a pair using the configured
 * destination adapter. Always preview-first, dedupe-first, approval-gated.
 *
 * - Refuses to act on `preview-only` pairs unless the caller passes approve=true
 *   AND the policy allows it (matches the `approval-required` / `live-approved`
 *   spirit of pair.mode).
 * - Re-checks dedupe right before posting (race-safe).
 * - On success, appends to posted.jsonl and audit.jsonl.
 */
export async function publishNextForPair(
  pair: PairRecord,
  sourceAdapter: SourceAdapter,
  destinationAdapter: DestinationAdapter,
  options: PublishPairOptions
): Promise<PublishPairOutcome> {
  ensurePairDirs(pair.id);

  if (!destinationAdapter.publish) {
    return {
      status: "publish-failed",
      reason: `Destination adapter ${destinationAdapter.type} has no publish() implementation.`,
    };
  }

  const previewResult = await previewPair(pair, sourceAdapter, destinationAdapter);
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

  const destAuth = await destinationAdapter.test(pair);
  if (!destAuth.ok) {
    appendAuditEvent({
      at: nowIso(),
      event: "pair.publish.auth-failed",
      pairId: pair.id,
      details: { destinationStatus: destAuth.status, message: destAuth.message },
    });
    return { status: "auth-failed", reason: destAuth.message, preview: top };
  }

  const publishResult = await destinationAdapter.publish(top.item, top.draft, pair);

  if (!publishResult.success) {
    appendAuditEvent({
      at: nowIso(),
      event: "pair.publish.failed",
      pairId: pair.id,
      details: {
        error: publishResult.error,
        sourceUrl: top.item.canonicalUrl,
      },
    });
    return {
      status: "publish-failed",
      reason: publishResult.error,
      preview: top,
      publishResult,
    };
  }

  const postedAt = nowIso();
  appendPostedHistory(pair.id, {
    sourceItemId: top.item.sourceItemId,
    canonicalUrl: top.item.canonicalUrl,
    contentHash: contentHash(top.item.text),
    destinationType: destinationAdapter.type,
    destinationId: publishResult.destinationId,
    postedAt,
    summary: summarizeText(top.item.text, 240),
  });

  appendAuditEvent({
    at: postedAt,
    event: "pair.publish.success",
    pairId: pair.id,
    details: {
      destinationId: publishResult.destinationId,
      destinationUrl: publishResult.destinationUrl,
      sourceUrl: top.item.canonicalUrl,
      chars: top.draft.text.length,
    },
  });

  return { status: "published", preview: top, publishResult };
}
