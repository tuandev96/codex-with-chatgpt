import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import { gitRoot, gitStatus } from "../workspace/git.js";
import type { Workspace } from "../workspace/manager.js";
import { appendExecutionRecord } from "../execution/records.js";
import { saveExecutionOutput } from "../execution/output.js";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";
import type { Logger } from "../logger/index.js";

export const MAX_COORDINATOR_PROMPT = 64 * 1024;
export const DEFAULT_COORDINATOR_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_COORDINATOR_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const WORKER_PREFIX = [
  "[C2C WORKER MODE]",
  "You are the local Codex execution worker for a ChatGPT coordinator.",
  "Execute the coordinator's task directly in the connected workspace.",
  "Do not wait for another plan, call c2c setup, or return BLOCKED because ChatGPT is not present.",
  "Inspect the current state, make the required changes, run the relevant checks, and repair failures.",
  "Stop only when the task is complete or a genuine external blocker cannot be resolved safely.",
  "Return a concise execution summary; do not paste large files or logs.",
].join(" ");

export type CodexSandbox = "workspace-write" | "danger-full-access";

export interface CodexRunInput {
  taskId: string;
  iteration: number;
  prompt: string;
  resumeThreadId?: string;
  model?: string;
  sandbox: CodexSandbox;
  timeoutMs: number;
}

export interface CodexRunResult {
  taskId: string;
  iteration: number;
  status: "running" | "completed" | "failed" | "timeout" | "interrupted";
  exitCode: number | null;
  signal: string | null;
  threadId: string | null;
  changedFiles: number;
  outputId: number | null;
  outputAvailable: boolean;
  summary?: string;
  nextAction?: string;
}

export interface CodexControl {
  run(input: CodexRunInput): Promise<CodexRunResult>;
  recent?(limit: number): Promise<CodexRunResult[]>;
}

export class CodexControlError extends Error {
  constructor(
    public readonly code: "EXECUTION_BUSY" | "EXECUTION_UNAVAILABLE" | "INVALID_CONTROL_REQUEST",
    message: string
  ) {
    super(message);
    this.name = "CodexControlError";
  }
}

export interface CodexExecutorOptions {
  command?: string;
  /** Test-only argv prefix; production always invokes the Codex binary directly. */
  commandPrefix?: string[];
  spawnProcess?: typeof spawn;
  /** Bound a single HTTP response, not the lifetime of the worker. */
  responseWaitMs?: number;
}

interface CapturedProcess {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

function captureChunk(chunks: Buffer[], state: { bytes: number }, value: Buffer | string): void {
  if (state.bytes >= MAX_CAPTURE_BYTES) return;
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const remaining = MAX_CAPTURE_BYTES - state.bytes;
  const selected = chunk.subarray(0, remaining);
  chunks.push(selected);
  state.bytes += selected.byteLength;
}

function parseWorkerOutput(stdout: string, fallbackThreadId?: string): {
  threadId: string | null;
  summary?: string;
} {
  let threadId = fallbackThreadId ?? null;
  let summary: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        threadId = event.thread_id;
      }
      const item = event.item;
      if (
        event.type === "item.completed" &&
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).type === "agent_message" &&
        typeof (item as Record<string, unknown>).text === "string"
      ) {
        summary = (item as Record<string, unknown>).text as string;
      }
    } catch {
      // Codex may emit a non-JSON diagnostic line; the sanitized output is the evidence source.
    }
  }
  return { threadId, summary };
}

function dirtyFileCount(root: string): number {
  const status = gitStatus(root);
  const paths = new Set([
    ...status.staged.map((item) => item.path),
    ...status.unstaged.map((item) => item.path),
    ...status.untracked,
    ...status.conflicted,
  ]);
  return paths.size;
}

function validateRunInput(input: CodexRunInput): void {
  if (!input.taskId || input.taskId.length > 120) {
    throw new CodexControlError("INVALID_CONTROL_REQUEST", "taskId must be 1-120 characters");
  }
  if (!Number.isSafeInteger(input.iteration) || input.iteration < 1) {
    throw new CodexControlError("INVALID_CONTROL_REQUEST", "iteration must be a positive integer");
  }
  if (!input.prompt.trim() || input.prompt.length > MAX_COORDINATOR_PROMPT) {
    throw new CodexControlError(
      "INVALID_CONTROL_REQUEST",
      `prompt must be 1-${MAX_COORDINATOR_PROMPT} characters`
    );
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 5_000 || input.timeoutMs > MAX_COORDINATOR_TIMEOUT_MS) {
    throw new CodexControlError(
      "INVALID_CONTROL_REQUEST",
      `timeoutMs must be between 5000 and ${MAX_COORDINATOR_TIMEOUT_MS}`
    );
  }
}

function workerPrompt(prompt: string): string {
  return `${WORKER_PREFIX}\n\nCoordinator task:\n${prompt.trim()}`;
}

async function waitForProcess(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  logger: Logger
): Promise<CapturedProcess> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutState = { bytes: 0 };
  const stderrState = { bytes: 0 };
  child.stdout.on("data", (value: Buffer | string) => captureChunk(stdoutChunks, stdoutState, value));
  child.stderr.on("data", (value: Buffer | string) => captureChunk(stderrChunks, stderrState, value));

  let timer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const result = await new Promise<CapturedProcess>((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        signal,
        timedOut,
      });
    };
    child.once("error", (error) => {
      logger.error("Codex worker process failed", { message: error.message });
      finish(null, null);
    });
    child.once("close", (exitCode, signal) => finish(exitCode, signal));
    timer = setTimeout(() => {
      timedOut = true;
      logger.warn("Codex worker timed out", { timeoutMs });
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000);
    }, timeoutMs);
  });
  return result;
}

export class CodexExecutor implements CodexControl {
  private active = new Map<string, Promise<CodexRunResult>>();

  constructor(
    private readonly workspace: Workspace,
    private readonly logger: Logger,
    private readonly options: CodexExecutorOptions = {}
  ) {}

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    validateRunInput(input);
    const key = createHash("sha256").update(JSON.stringify([input.taskId, input.iteration])).digest("hex");
    const fingerprint = createHash("sha256").update(JSON.stringify([
      input.prompt, input.resumeThreadId ?? null, input.model ?? null, input.sandbox, input.timeoutMs,
    ])).digest("hex");
    const file = path.join(this.jobsDir(), `${key}.json`);
    if (fs.existsSync(file)) {
      const saved = this.readJob(file);
      if (saved.fingerprint !== fingerprint) {
        throw new CodexControlError("INVALID_CONTROL_REQUEST", "This task_id/iteration already exists with different arguments. Inspect execution_summary; do not duplicate an uncertain run.");
      }
      const pending = this.active.get(key);
      if (pending) await this.waitBriefly(pending);
      return this.jobResult(key, this.readJob(file).result);
    }
    const lock = path.join(this.jobsDir(), "active.lock");
    // ponytail: one worker per workspace; use a queue only if parallel execution is explicitly needed.
    try {
      fs.writeFileSync(lock, JSON.stringify({ taskId: input.taskId, iteration: input.iteration, pid: process.pid }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new CodexControlError("EXECUTION_BUSY", "A current or unresolved previous worker owns this workspace. Read execution_summary and wait; after a bridge restart reconcile the previous worker before clearing its local active.lock. Do not start another iteration.");
    }
    const running: CodexRunResult = {
      taskId: input.taskId, iteration: input.iteration, status: "running", exitCode: null,
      signal: null, threadId: input.resumeThreadId ?? null, changedFiles: 0, outputId: null,
      outputAvailable: false,
      nextAction: "Call execution_summary until this task/iteration is terminal. Then review execution_output and current files before the next iteration. Do not report BLOCKED merely because this worker is running.",
    };
    try {
      this.writeJob(file, { fingerprint, result: running });
    } catch (error) {
      fs.unlinkSync(lock); // No worker has started yet.
      throw error;
    }
    const pending = Promise.resolve().then(() => this.execute(input)).catch((error: unknown): CodexRunResult => ({
      ...running, status: "failed", nextAction: "Inspect execution outputs and workspace state before deciding whether a new iteration is safe.",
      summary: error instanceof CodexControlError ? error.code : "Execution failed; inspect local bridge logs.",
    })).then((result) => {
      this.writeJob(file, { fingerprint, result });
      fs.unlinkSync(lock); // Keep the lock if persisting the terminal result failed.
      return result;
    }).finally(() => this.active.delete(key));
    this.active.set(key, pending);
    await this.waitBriefly(pending);
    return this.jobResult(key, this.readJob(file).result);
  }

  async recent(limit: number): Promise<CodexRunResult[]> {
    const pending = this.active.values().next().value;
    if (pending) await this.waitBriefly(pending);
    return fs.readdirSync(this.jobsDir()).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => ({ name, time: fs.statSync(path.join(this.jobsDir(), name)).mtimeMs }))
      .sort((a, b) => b.time - a.time).slice(0, Math.max(1, Math.min(50, limit)))
      .map(({ name }) => this.jobResult(name.slice(0, -5), this.readJob(path.join(this.jobsDir(), name)).result));
  }

  private jobsDir(): string {
    return ensureDir(path.join(getStateDir(), "codex-jobs", this.workspace.id));
  }

  private readJob(file: string): { fingerprint: string; result: CodexRunResult } {
    // Corrupt state must fail closed, never be interpreted as permission to execute again.
    return JSON.parse(fs.readFileSync(file, "utf8")) as { fingerprint: string; result: CodexRunResult };
  }

  private writeJob(file: string, job: { fingerprint: string; result: CodexRunResult }): void {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(job), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  private jobResult(key: string, result: CodexRunResult): CodexRunResult {
    if (result.status !== "running" || this.active.has(key)) return result;
    return { ...result, status: "interrupted", nextAction: "Bridge lost tracking of this worker. Reconcile its process and workspace before any new execution; no automatic replay is safe." };
  }

  private async waitBriefly(pending: Promise<CodexRunResult>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([pending, new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.options.responseWaitMs ?? 10_000);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async execute(input: CodexRunInput): Promise<CodexRunResult> {
    const executionRoot = this.workspace.root;
    const skipGitRepoCheck = gitRoot(executionRoot) === null;
    const args = ["exec"];
    if (input.resumeThreadId) {
      args.push("resume", input.resumeThreadId);
    }
    args.push("--json");
    if (skipGitRepoCheck) args.push("--skip-git-repo-check");
    if (!input.resumeThreadId) {
      args.push("--cd", executionRoot, "--sandbox", input.sandbox);
    }
    if (input.model) args.push("--model", input.model);
    args.push("-");

    const command = this.options.command ?? process.env.C2C_CODEX_BIN ?? "codex";
    const spawnProcess = this.options.spawnProcess ?? spawn;
    let captured: CapturedProcess;
    try {
      const child = spawnProcess(command, [...(this.options.commandPrefix ?? []), ...args], {
        cwd: executionRoot,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end(workerPrompt(input.prompt));
      captured = await waitForProcess(child, input.timeoutMs, this.logger);
    } catch (error) {
      throw new CodexControlError(
        "EXECUTION_UNAVAILABLE",
        `Unable to start Codex: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      const parsed = parseWorkerOutput(captured.stdout, input.resumeThreadId);
      const rawOutput = [captured.stdout, captured.stderr ? `\n[stderr]\n${captured.stderr}` : ""]
        .join("")
        .slice(0, MAX_CAPTURE_BYTES);
      const output = saveExecutionOutput(this.workspace.id, {
        command: "codex exec (ChatGPT coordinator)",
        raw: rawOutput,
        exitCode: captured.exitCode,
        taskId: input.taskId,
        iteration: input.iteration,
      });
      const status: CodexRunResult["status"] = captured.timedOut
        ? "timeout"
        : captured.exitCode === 0
          ? "completed"
          : "failed";
      const changedFiles = dirtyFileCount(executionRoot);
      appendExecutionRecord(this.workspace.id, {
        taskId: input.taskId,
        iteration: input.iteration,
        changedFiles,
        tests: null,
        exitStatus: status === "completed" ? "ok" : status,
        timestamp: new Date().toISOString(),
        outputId: output.id,
        outputAvailable: output.allowed,
      });

      const safeSummary = parsed.summary ? sanitizeExecutionOutput(parsed.summary) : null;
      return {
        taskId: input.taskId,
        iteration: input.iteration,
        status,
        exitCode: captured.exitCode,
        signal: captured.signal,
        threadId: parsed.threadId,
        changedFiles,
        outputId: output.id,
        outputAvailable: output.allowed,
        ...(safeSummary?.allowed ? { summary: safeSummary.text.slice(0, 2_000) } : {}),
      };
    } catch (error) {
      this.logger.error("Unable to persist Codex execution evidence", { message: String(error) });
      throw error;
    }
  }
}
