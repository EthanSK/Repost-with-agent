/**
 * Agent task runner — the bridge between the CLI orchestrator and the
 * agent's browser MCP.
 *
 * In v3.0.0 the CLI does NOT drive a browser. It emits a typed task
 * description, waits for a typed result, and routes the result back into
 * the orchestrator. There are two delivery modes:
 *
 *   1. **Inline / programmatic** — used by tests and by the CLI's own
 *      preview / dry-run commands. The caller supplies a `taskHandler`
 *      function that maps tasks to results synchronously. No filesystem
 *      I/O.
 *
 *   2. **Inbox-style** — used when the CLI is being driven by an external
 *      agent harness. The CLI writes the task to
 *      `~/.repost-with-agent/agent-tasks/<correlation_id>.task.json`, prints
 *      a stdout banner so the agent sees it, and polls for the matching
 *      `<correlation_id>.result.json`. The agent's `repost-run` skill is
 *      responsible for picking up the task and writing the result.
 *
 * The runner is the **only** place the CLI knows about agents. Everywhere
 * else (orchestrator, backfill, scheduling) just calls `runAgentTask()` and
 * gets a result back.
 */

import * as fs from "fs";
import {
  AgentResult,
  AgentTask,
  clearAgentTask,
  isErrorResult,
  readAgentResult,
  resultFilePath,
  summarizeTask,
  writeAgentTask,
} from "./agent-task-contract.js";

export type AgentTaskHandler = (task: AgentTask) => Promise<AgentResult>;

export interface RunAgentTaskOptions {
  /**
   * In-process handler. When provided, this is called synchronously and the
   * filesystem inbox is NOT touched. Used by tests + inline CLI flows.
   */
  handler?: AgentTaskHandler;
  /**
   * Inbox-mode timeout in ms. Default 5 minutes. The CLI errors out after
   * this with a structured "agent-timeout" error result.
   */
  inboxTimeoutMs?: number;
  /**
   * Polling interval for the inbox file. Default 500ms.
   */
  inboxPollMs?: number;
  /**
   * Override stdout writer (testing only).
   */
  writeLine?: (line: string) => void;
  /**
   * If true, leave the inbox files in place after the result is read so the
   * agent's audit trail is preserved. Default true (deliberate — Ethan
   * wanted the JSON history visible). Set false in tests.
   */
  preserveInbox?: boolean;
}

const DEFAULT_INBOX_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_INBOX_POLL_MS = 500;

/**
 * Run a single agent task. Returns the matching result (which may be an
 * error result — the caller is responsible for checking).
 */
export async function runAgentTask(
  task: AgentTask,
  options: RunAgentTaskOptions = {}
): Promise<AgentResult> {
  if (options.handler) {
    return options.handler(task);
  }

  // Inbox-mode: write task, banner stdout, poll for result.
  const writeLine = options.writeLine || ((line: string) => process.stdout.write(line + "\n"));
  const taskPath = writeAgentTask(task);
  const resultPath = resultFilePath(task.correlation_id);
  writeLine(summarizeTask(task));
  writeLine(`[agent-task] task_file=${taskPath} result_file=${resultPath}`);
  writeLine(
    `[agent-task] waiting up to ${options.inboxTimeoutMs ?? DEFAULT_INBOX_TIMEOUT_MS}ms for result...`
  );

  const startedAt = Date.now();
  const timeoutMs = Math.max(1000, options.inboxTimeoutMs ?? DEFAULT_INBOX_TIMEOUT_MS);
  const pollMs = Math.max(50, options.inboxPollMs ?? DEFAULT_INBOX_POLL_MS);

  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(resultPath)) {
      const result = readAgentResult(task.correlation_id);
      if (result) {
        if (options.preserveInbox === false) {
          clearAgentTask(task.correlation_id);
        }
        return result;
      }
    }
    await sleep(pollMs);
  }

  // Timeout — return a structured error result (NOT throw).
  return {
    kind: "error-result",
    correlation_id: task.correlation_id,
    error: `Agent did not return a result within ${timeoutMs}ms.`,
    category: "platform-error",
  };
}

/**
 * Convenience: run a task and assert it returned a non-error result of a
 * specific kind. Throws on type mismatch / error result.
 */
export async function runAgentTaskExpect<R extends AgentResult>(
  task: AgentTask,
  expectedKind: R["kind"],
  options: RunAgentTaskOptions = {}
): Promise<R> {
  const result = await runAgentTask(task, options);
  if (isErrorResult(result)) {
    throw new Error(
      `Agent task ${task.kind} (correlation_id=${task.correlation_id}) failed: ${result.error}`
    );
  }
  if (result.kind !== expectedKind) {
    throw new Error(
      `Agent returned wrong result kind for ${task.kind}: expected ${expectedKind}, got ${result.kind}`
    );
  }
  return result as R;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
