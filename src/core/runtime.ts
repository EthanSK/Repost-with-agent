import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  APP_NAME,
  DEFAULT_DATA_DIR,
  LEGACY_DATA_DIR,
  getRuntimeDataDir,
} from "../config.js";
import {
  AuditEvent,
  PairRecord,
  PairsStoreFile,
  PostedHistoryEntry,
} from "./types.js";

const STORE_VERSION = 1;

export interface PairPaths {
  rootDir: string;
  stateFile: string;
  auditFile: string;
  findingsFile: string;
  draftsFile: string;
  postedFile: string;
  learningsFile: string;
}

export function getAppDataDir(): string {
  return getRuntimeDataDir();
}

export function getPairsFilePath(): string {
  return path.join(getAppDataDir(), "pairs.json");
}

export function getPairsBackupPath(suffix: string): string {
  return path.join(getAppDataDir(), `pairs.json.${suffix}.bak`);
}

export function getPairPaths(pairId: string): PairPaths {
  const rootDir = path.join(getAppDataDir(), "pairs", pairId);
  return {
    rootDir,
    stateFile: path.join(rootDir, "state.json"),
    auditFile: path.join(rootDir, "audit.jsonl"),
    findingsFile: path.join(rootDir, "findings.jsonl"),
    draftsFile: path.join(rootDir, "drafts.jsonl"),
    postedFile: path.join(rootDir, "posted.jsonl"),
    learningsFile: path.join(rootDir, "learnings.md"),
  };
}

export function ensureAppDirs(): void {
  fs.mkdirSync(getAppDataDir(), { recursive: true });
  fs.mkdirSync(path.join(getAppDataDir(), "pairs"), { recursive: true });
}

export function ensurePairDirs(pairId: string): PairPaths {
  ensureAppDirs();
  const paths = getPairPaths(pairId);
  fs.mkdirSync(paths.rootDir, { recursive: true });
  return paths;
}

export function slugifyPairId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * v2 → v3 pair migration. v2 pairs only carried `endpoint.type` (the adapter
 * id); v3 pairs add `endpoint.platform` (free-form label). This shim
 * recognizes the small set of v2 adapter ids actually shipped and copies
 * them into a v3 platform label without losing any other field.
 */
const V2_TYPE_TO_V3_PLATFORM: Record<string, string> = {
  "linkedin-profile-activity": "linkedin",
  "x-account": "x",
  "x-post": "x",
  "facebook-page": "facebook",
  "bluesky-account": "bluesky",
  "threads-account": "threads",
};

function migrateV2Pair(raw: PairRecord): PairRecord {
  const next: PairRecord = {
    ...raw,
    source: { ...raw.source },
    destination: { ...raw.destination },
    schedule: { ...raw.schedule },
    policy: { ...raw.policy },
    dedupe: { ...raw.dedupe },
  };
  if (!next.source.platform && next.source.type) {
    next.source.platform =
      V2_TYPE_TO_V3_PLATFORM[next.source.type] || next.source.type;
  }
  if (!next.destination.platform && next.destination.type) {
    next.destination.platform =
      V2_TYPE_TO_V3_PLATFORM[next.destination.type] || next.destination.type;
  }
  if (!next.runMode) {
    // v2 pairs only had the listen path; preserve that semantics by default.
    next.runMode = "listen-for-future";
  }
  if (next.schemaVersion === undefined) {
    next.schemaVersion = 3;
  }
  return next;
}

/**
 * Detect whether a pairs.json file looks v2-shaped (no `platform` fields).
 */
function isV2Shape(pairs: PairRecord[]): boolean {
  return pairs.some(
    (p) =>
      (!p.source.platform && p.source.type) ||
      (!p.destination.platform && p.destination.type) ||
      p.schemaVersion === undefined
  );
}

export function loadPairsStore(): PairsStoreFile {
  ensureAppDirs();
  const filePath = getPairsFilePath();
  if (!fs.existsSync(filePath)) {
    return { version: STORE_VERSION, pairs: [] };
  }
  let parsed: PairsStoreFile;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as PairsStoreFile;
  } catch {
    return { version: STORE_VERSION, pairs: [] };
  }
  if (!Array.isArray(parsed.pairs)) {
    return { version: STORE_VERSION, pairs: [] };
  }

  // One-shot v2 → v3 migration on read. Back up the original shape once
  // before rewriting.
  if (isV2Shape(parsed.pairs)) {
    const backupPath = getPairsBackupPath("v2");
    if (!fs.existsSync(backupPath)) {
      try {
        fs.copyFileSync(filePath, backupPath);
      } catch {
        // best-effort; if the copy fails we still proceed (we never delete the
        // original — savePairsStore writes the migrated form).
      }
    }
    const migrated = parsed.pairs.map(migrateV2Pair);
    const next: PairsStoreFile = { version: STORE_VERSION, pairs: migrated };
    try {
      savePairsStore(next);
    } catch {
      // best-effort
    }
    return next;
  }

  return parsed;
}

export function savePairsStore(store: PairsStoreFile): void {
  ensureAppDirs();
  fs.writeFileSync(getPairsFilePath(), JSON.stringify(store, null, 2) + "\n", "utf-8");
}

export function upsertPair(pair: PairRecord): void {
  const store = loadPairsStore();
  const existingIndex = store.pairs.findIndex((entry) => entry.id === pair.id);
  if (existingIndex >= 0) {
    store.pairs[existingIndex] = pair;
  } else {
    store.pairs.push(pair);
  }
  savePairsStore({ version: STORE_VERSION, pairs: store.pairs });
  ensurePairDirs(pair.id);
}

export function getPairById(pairId: string): PairRecord | undefined {
  return loadPairsStore().pairs.find((pair) => pair.id === pairId);
}

export function appendJsonl(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(value) + "\n", "utf-8");
}

export function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

export function appendAuditEvent(event: AuditEvent): void {
  const paths = ensurePairDirs(event.pairId);
  appendJsonl(paths.auditFile, event);
}

export function appendPostedHistory(pairId: string, entry: PostedHistoryEntry): void {
  const paths = ensurePairDirs(pairId);
  appendJsonl(paths.postedFile, entry);
}

export function loadPostedHistory(pairId: string): PostedHistoryEntry[] {
  const paths = ensurePairDirs(pairId);
  return readJsonl<PostedHistoryEntry>(paths.postedFile);
}

export function loadAuditHistory(pairId: string): AuditEvent[] {
  const paths = ensurePairDirs(pairId);
  return readJsonl<AuditEvent>(paths.auditFile);
}

export function loadLearnings(pairId: string): string {
  const paths = ensurePairDirs(pairId);
  if (!fs.existsSync(paths.learningsFile)) {
    return "";
  }
  return fs.readFileSync(paths.learningsFile, "utf-8");
}

export function writeDefaultLearnings(pairId: string): void {
  const paths = ensurePairDirs(pairId);
  if (!fs.existsSync(paths.learningsFile)) {
    fs.writeFileSync(
      paths.learningsFile,
      [
        `# ${pairId} learnings`,
        "",
        "- Loaded before each preview/run.",
        "- Record duplicate patterns, formatting preferences, and platform-specific cautions here.",
        "- The agent reads this file at task-execution time to refine its browser-driven behavior.",
        "",
      ].join("\n"),
      "utf-8"
    );
  }
}

export function getEnvironmentSummary(): string {
  return `${APP_NAME} runtime at ${getAppDataDir()} (legacy: ${LEGACY_DATA_DIR}, home: ${os.homedir()})`;
}

export function resolveScheduleTimezone(value?: string): string {
  return value || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function defaultPairName(sourcePlatform: string, destinationPlatform: string): string {
  return `${sourcePlatform} to ${destinationPlatform}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function repoLocalPath(...parts: string[]): string {
  return path.join(process.cwd(), ...parts);
}

export function defaultAppDataDirForDocs(): string {
  return DEFAULT_DATA_DIR;
}

/**
 * Resolve `pair.source.platform` falling back to the legacy `type` field for
 * v2-migrated pairs that haven't been re-saved.
 */
export function resolveSourcePlatform(pair: PairRecord): string {
  return pair.source.platform || pair.source.type || "unknown";
}

export function resolveDestinationPlatform(pair: PairRecord): string {
  return pair.destination.platform || pair.destination.type || "unknown";
}
