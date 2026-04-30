export type PairMode = "preview-only" | "approval-required" | "live-approved";
export type PairScheduleKind = "manual" | "cron" | "every";

export interface PairEndpoint {
  type: string;
  authRef?: string;
  profileUrl?: string;
  url?: string;
  accountHint?: string;
  pageHint?: string;
}

export interface PairSchedule {
  kind: PairScheduleKind;
  expression?: string;
  everyMinutes?: number;
  tz: string;
  jitterMinutes?: number;
}

export interface PairPolicy {
  requirePreviewBeforeFirstLiveRun: boolean;
  maxItemsPerRun: number;
  minDelayBetweenPostsMinutes: number;
  preferOfficialApi: boolean;
  blockOnUncertainDuplicate: boolean;
}

export interface PairDedupeConfig {
  strategy: string;
}

export interface PairRecord {
  id: string;
  name: string;
  enabled: boolean;
  mode: PairMode;
  source: PairEndpoint;
  destination: PairEndpoint;
  schedule: PairSchedule;
  policy: PairPolicy;
  dedupe: PairDedupeConfig;
  createdAt: string;
  updatedAt: string;
}

export interface PairsStoreFile {
  version: number;
  pairs: PairRecord[];
}

export interface SourceItem {
  sourceItemId?: string;
  canonicalUrl?: string | null;
  text: string;
  publishedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface DraftPost {
  destinationType: string;
  text: string;
  warnings: string[];
  metadata?: Record<string, unknown>;
}

export interface AuthHealth {
  ok: boolean;
  status: "ok" | "needs-login" | "needs-config" | "unknown";
  message: string;
}

export interface PostedHistoryEntry {
  sourceItemId?: string;
  canonicalUrl?: string | null;
  contentHash?: string;
  destinationType: string;
  destinationId?: string;
  postedAt: string;
  summary: string;
  importedFrom?: string;
}

export interface AuditEvent {
  at: string;
  event: string;
  pairId: string;
  details: Record<string, unknown>;
}

export interface PreviewDecision {
  status: "new" | "duplicate" | "uncertain";
  reason: string;
}

export interface PreviewItem {
  item: SourceItem;
  draft: DraftPost;
  decision: PreviewDecision;
}
