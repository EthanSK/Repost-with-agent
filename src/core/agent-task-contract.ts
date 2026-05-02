/**
 * Agent task contract — the v3.0.0 boundary between the CLI orchestrator
 * and the agent's browser MCP.
 *
 * The CLI does NOT drive a browser. It emits a typed task description
 * either to stdout (for in-process invocation) or to a file under
 * `~/.repost-with-agent/agent-tasks/<correlation_id>.task.json` (for
 * decoupled invocation). The agent (Claude Code via chrome-devtools-mcp,
 * OpenClaw via its built-in browser tool, etc.) reads the task, drives its
 * own browser, and writes a result with the matching `correlation_id` back
 * to `~/.repost-with-agent/agent-tasks/<correlation_id>.result.json`.
 *
 * All platforms (LinkedIn, X, Bluesky, Threads, Facebook) share the same
 * task surface. The agent picks the right URL templates, DOM selectors, and
 * UX heuristics from the task `platform` label + the per-platform notes in
 * `docs/destinations/<platform>.md`.
 *
 * Tasks are intentionally narrow:
 *
 *   - `fetch-source`: scrape recent posts from the user's profile on the
 *     source platform.
 *   - `post-to-destination`: publish a single draft to the destination.
 *   - `check-destination`: scrape recent posts on the destination and fuzzy-
 *     match against a candidate draft (used for cross-state dedupe).
 *
 * Each task → result pair carries a `correlation_id` so the orchestrator can
 * route results when many tasks are in flight.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getAgentTasksDir } from "../config.js";

// ---------- Task shapes ----------

export interface FetchSourceTask {
  kind: "fetch-source";
  platform: string;
  source_url: string;
  max_items: number;
  /** Optional pagination hint (1-based). */
  page?: number;
  /** Optional opaque cursor returned by an earlier fetch. */
  cursor?: string;
  correlation_id: string;
  /** Pair id this task belongs to. */
  pair_id: string;
}

export interface PostToDestinationTask {
  kind: "post-to-destination";
  platform: string;
  destination_account: string;
  draft_text: string;
  /** Optional source canonical URL the agent MAY append to the post body. */
  source_url?: string;
  correlation_id: string;
  pair_id: string;
}

export interface CheckDestinationTask {
  kind: "check-destination";
  platform: string;
  destination_account: string;
  candidate_text: string;
  correlation_id: string;
  pair_id: string;
}

export type AgentTask =
  | FetchSourceTask
  | PostToDestinationTask
  | CheckDestinationTask;

// ---------- Result shapes ----------

export interface FetchSourceItem {
  sourceItemId?: string;
  canonicalUrl?: string | null;
  text: string;
  publishedAt?: string;
}

export interface FetchSourceResult {
  kind: "fetch-source-result";
  correlation_id: string;
  items: FetchSourceItem[];
  /** Whether the agent thinks more items exist beyond what was returned. */
  hasMore?: boolean;
  nextCursor?: string;
  /** Free-form auth/health note. */
  auth_message?: string;
}

export interface PostToDestinationResult {
  kind: "post-to-destination-result";
  correlation_id: string;
  posted_url: string;
  posted_id?: string;
  posted_at: string;
}

export interface CheckDestinationResult {
  kind: "check-destination-result";
  correlation_id: string;
  exists: boolean;
  url?: string;
  posted_id?: string;
  postedAt?: string;
  /** Free-form reason describing how the match (or non-match) was made. */
  reason?: string;
}

export interface ErrorResult {
  kind: "error-result";
  correlation_id: string;
  error: string;
  /**
   * Categorical hint so the orchestrator knows whether to retry / mark
   * auth-failed / surface a config error.
   */
  category?:
    | "needs-login"
    | "needs-config"
    | "rate-limit"
    | "platform-error"
    | "unknown";
}

export type AgentResult =
  | FetchSourceResult
  | PostToDestinationResult
  | CheckDestinationResult
  | ErrorResult;

// ---------- Helpers ----------

export function newCorrelationId(prefix?: string): string {
  const id = crypto.randomBytes(8).toString("hex");
  return prefix ? `${prefix}-${id}` : id;
}

export function ensureAgentTasksDir(): string {
  const dir = getAgentTasksDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function taskFilePath(correlationId: string): string {
  return path.join(ensureAgentTasksDir(), `${correlationId}.task.json`);
}

export function resultFilePath(correlationId: string): string {
  return path.join(ensureAgentTasksDir(), `${correlationId}.result.json`);
}

/**
 * Write a task to disk. Returns the absolute path. Idempotent — overwrites if
 * a file with the same correlation id already exists.
 */
export function writeAgentTask(task: AgentTask): string {
  const filePath = taskFilePath(task.correlation_id);
  fs.writeFileSync(filePath, JSON.stringify(task, null, 2) + "\n", "utf-8");
  return filePath;
}

/**
 * Read a task from disk. Returns null if the file is missing or invalid.
 */
export function readAgentTask(correlationId: string): AgentTask | null {
  const filePath = taskFilePath(correlationId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as AgentTask;
  } catch {
    return null;
  }
}

/**
 * Write a result to disk. Used by an agent skill that finished a task.
 */
export function writeAgentResult(result: AgentResult): string {
  const filePath = resultFilePath(result.correlation_id);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2) + "\n", "utf-8");
  return filePath;
}

/**
 * Read a result from disk. Returns null if the file is missing.
 */
export function readAgentResult(correlationId: string): AgentResult | null {
  const filePath = resultFilePath(correlationId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as AgentResult;
  } catch {
    return null;
  }
}

/**
 * Remove a task + result pair from the inbox. Best-effort.
 */
export function clearAgentTask(correlationId: string): void {
  for (const p of [taskFilePath(correlationId), resultFilePath(correlationId)]) {
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Type guard: result is an error result.
 */
export function isErrorResult(result: AgentResult): result is ErrorResult {
  return result.kind === "error-result";
}

/**
 * Format a task as a one-line stdout banner, used when the CLI is being
 * driven inline by an agent (e.g. `pair preview` running inside a Claude
 * session) so the agent can see the task without parsing the JSON.
 */
export function summarizeTask(task: AgentTask): string {
  switch (task.kind) {
    case "fetch-source":
      return `[agent-task fetch-source] platform=${task.platform} source_url=${task.source_url} max_items=${task.max_items} correlation_id=${task.correlation_id}`;
    case "post-to-destination":
      return `[agent-task post-to-destination] platform=${task.platform} destination_account=${task.destination_account} draft_chars=${task.draft_text.length} correlation_id=${task.correlation_id}`;
    case "check-destination":
      return `[agent-task check-destination] platform=${task.platform} destination_account=${task.destination_account} candidate_chars=${task.candidate_text.length} correlation_id=${task.correlation_id}`;
  }
}
