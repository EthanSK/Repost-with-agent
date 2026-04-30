import * as crypto from "crypto";
import {
  PairPolicy,
  PostedHistoryEntry,
  PreviewDecision,
  SourceItem,
} from "./types.js";

export function normalizeContent(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function contentHash(text: string): string {
  return crypto.createHash("sha256").update(normalizeContent(text)).digest("hex");
}

export function summarizeText(text: string, max = 100): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) {
    return singleLine;
  }
  return `${singleLine.slice(0, max - 3)}...`;
}

export function decidePreviewStatus(
  item: SourceItem,
  posted: PostedHistoryEntry[],
  policy: PairPolicy
): PreviewDecision {
  const itemHash = contentHash(item.text);

  if (
    item.sourceItemId &&
    posted.some((entry) => entry.sourceItemId && entry.sourceItemId === item.sourceItemId)
  ) {
    return { status: "duplicate", reason: "Matched source item id in pair history." };
  }

  if (
    item.canonicalUrl &&
    posted.some((entry) => entry.canonicalUrl && entry.canonicalUrl === item.canonicalUrl)
  ) {
    return { status: "duplicate", reason: "Matched canonical source URL in pair history." };
  }

  if (posted.some((entry) => entry.contentHash && entry.contentHash === itemHash)) {
    return { status: "duplicate", reason: "Matched normalized content hash in pair history." };
  }

  if (policy.blockOnUncertainDuplicate) {
    const normalized = normalizeContent(item.text);
    const maybe = posted.find((entry) => entry.summary && normalizeContent(entry.summary) === normalized);
    if (maybe) {
      return {
        status: "uncertain",
        reason: "Matched normalized summary only; preview required before any live run.",
      };
    }
  }

  return { status: "new", reason: "No exact prior match found in pair history." };
}
