/**
 * Minimal config layer for v3.0.0.
 *
 * The v3 architecture has **no** API SDKs and **no** Playwright. The agent
 * (Claude Code / OpenClaw) drives the user's logged-in browser via its own
 * browser MCP (chrome-devtools-mcp, claude-in-chrome, OpenClaw's built-in
 * browser tool, etc.). This module therefore only exposes:
 *
 *   - APP_NAME / data-dir resolution
 *   - The agent-task inbox path (where the CLI hands tasks to the agent and
 *     reads results back)
 *
 * Anything platform-specific (LinkedIn URL, X auth, etc.) is now stored in
 * the per-pair config inside `pairs.json`. The agent reads it from there at
 * task-execution time.
 */

import * as path from "path";
import * as os from "os";

export const APP_NAME = "repost-with-agent";
export const LEGACY_APP_NAME = "linkedin-to-x";
export const DEFAULT_DATA_DIR = path.join(os.homedir(), `.${APP_NAME}`);
/** Kept for v2 → v3 migration only. New code MUST NOT depend on this. */
export const LEGACY_DATA_DIR = path.join(os.homedir(), `.${LEGACY_APP_NAME}`);

/**
 * Resolve the runtime data dir. Override priority:
 *   1. REPOST_DATA_DIR
 *   2. REPOST_WITH_AGENT_DATA_DIR (legacy long form)
 *   3. ~/.repost-with-agent
 */
export function getRuntimeDataDir(): string {
  return (
    process.env.REPOST_DATA_DIR ||
    process.env.REPOST_WITH_AGENT_DATA_DIR ||
    DEFAULT_DATA_DIR
  );
}

export function getLegacyDataDir(): string {
  return LEGACY_DATA_DIR;
}

/**
 * Where the CLI writes agent tasks (and where the agent's result-writer
 * deposits outcomes). One file per correlation id.
 *
 *   inbox/<correlation_id>.task.json   → CLI -> agent
 *   inbox/<correlation_id>.result.json → agent -> CLI
 *
 * Subdirectories under the data dir keep tasks scoped per pair so an agent
 * driving multiple pairs in parallel doesn't see cross-pair tasks.
 */
export function getAgentTasksDir(): string {
  return path.join(getRuntimeDataDir(), "agent-tasks");
}
