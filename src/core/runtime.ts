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

export function loadPairsStore(): PairsStoreFile {
  ensureAppDirs();
  const filePath = getPairsFilePath();
  if (!fs.existsSync(filePath)) {
    return { version: STORE_VERSION, pairs: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as PairsStoreFile;
    if (!Array.isArray(parsed.pairs)) {
      return { version: STORE_VERSION, pairs: [] };
    }
    return parsed;
  } catch {
    return { version: STORE_VERSION, pairs: [] };
  }
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
        "",
      ].join("\n"),
      "utf-8"
    );
  }
}

export function getEnvironmentSummary(): string {
  return `${APP_NAME} runtime at ${getAppDataDir()} (legacy: ${LEGACY_DATA_DIR}, home: ${os.homedir()})`;
}

export function getLegacyTrackerPath(): string {
  return path.join(LEGACY_DATA_DIR, "posted.md");
}

export function getLegacyFacebookTrackerPath(): string {
  return path.join(LEGACY_DATA_DIR, "posted-facebook.json");
}

export function getLegacyXTokensPath(): string {
  return path.join(LEGACY_DATA_DIR, "x-tokens.json");
}

export function resolveScheduleTimezone(value?: string): string {
  return value || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function defaultPairName(sourceType: string, destinationType: string): string {
  return `${sourceType} to ${destinationType}`;
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
