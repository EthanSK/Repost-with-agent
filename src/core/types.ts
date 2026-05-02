/**
 * Pair / source / destination / draft types for v3.0.0.
 *
 * The v3 schema is intentionally **platform-agnostic**: `source.platform` and
 * `destination.platform` are free-form string labels (e.g. `"linkedin"`,
 * `"x"`, `"bluesky"`, `"threads"`, `"facebook"`). There is no per-platform
 * code in this repo. The agent reads the platform label off the pair config
 * and uses its own browser MCP to drive the corresponding logged-in tab.
 */

export type PairMode = "preview-only" | "approval-required" | "live-approved";
export type PairScheduleKind = "manual" | "cron" | "every";

/**
 * v3.0.0 pair execution mode. Distinct from `PairMode` (which is the
 * approval-gate level). `"backfill"` walks back through historical posts
 * newest-first; `"listen-for-future"` watches for new posts going forward via
 * the host scheduler.
 */
export type PairRunMode = "backfill" | "listen-for-future";

export interface PairEndpoint {
  /**
   * v3.0.0 platform label. Free-form string; the agent uses this to pick the
   * right URL templates and DOM selectors at task-execution time. Examples:
   * `"linkedin"`, `"x"`, `"bluesky"`, `"threads"`, `"facebook"`.
   *
   * For backwards compat with v2, `type` is preserved (it used to be the
   * adapter id, e.g. `"linkedin-profile-activity"`). New pairs MUST set
   * `platform`; the migration shim copies a recognized `type` into `platform`.
   */
  platform?: string;
  /** Legacy adapter type. Preserved for v2 pair migration. */
  type?: string;
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
  /**
   * v3.0.0: previously this hinted at "prefer official API over scraping".
   * In v3 there is no API path — the agent always drives the browser. Kept
   * in the schema for v2-pair-shape compatibility but ignored at runtime.
   */
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
  /**
   * v3.0.0: which run-mode this pair operates in. `"backfill"` walks history
   * newest-first; `"listen-for-future"` runs as a continuous tail via the host
   * scheduler (`pair scheduled-run`). Defaults to `"listen-for-future"` for
   * pairs migrated from v2 (which only supported the listen path).
   */
  runMode?: PairRunMode;
  source: PairEndpoint;
  destination: PairEndpoint;
  schedule: PairSchedule;
  policy: PairPolicy;
  dedupe: PairDedupeConfig;
  createdAt: string;
  updatedAt: string;
  /**
   * v3.0.0 schema marker. Present on pairs created by v3+; older pairs
   * (v2-migrated) keep `schemaVersion` undefined.
   */
  schemaVersion?: 3;
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
  /** Free-form metadata the source skill chose to surface. */
  metadata?: Record<string, unknown>;
}

export interface DraftPost {
  /** Platform label (matches `pair.destination.platform`). */
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
  destinationUrl?: string;
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
