import { DestinationAdapter } from "../adapters/destination.js";
import { SourceAdapter } from "../adapters/source.js";
import { decidePreviewStatus } from "./dedupe.js";
import {
  appendAuditEvent,
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
