import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type AgentId = "codex" | "cursor" | "grok";

export const AGENT_IDS: readonly AgentId[] = ["codex", "cursor", "grok"] as const;

export interface AgentSpawnPlan {
  command: string;
  args: string[];
  /** When true, write the worker prompt to stdin and close it. */
  promptViaStdin: boolean;
  /** Prepended to the coordinator prompt before spawn. */
  workerPrefix: string;
}

export interface AgentParseResult {
  threadId: string | null;
  summary?: string;
}

export interface AgentBuildInput {
  root: string;
  prompt: string;
  resumeThreadId?: string;
  model?: string;
  skipGitRepoCheck: boolean;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly workerPrefix: string;
  /** Preferred executable names, first match wins (env override applied by registry). */
  readonly binaries: readonly string[];
  readonly envOverride?: string;
  build(input: AgentBuildInput): AgentSpawnPlan;
  parseOutput(stdout: string, fallbackThreadId?: string): AgentParseResult;
}

function workerPrefixFor(displayName: string): string {
  return [
    "[C2C WORKER MODE]",
    `You are the local ${displayName} execution worker for a ChatGPT coordinator.`,
    "Execute the coordinator's task directly in the connected workspace.",
    "Do not wait for another plan, call c2c setup, or return BLOCKED because ChatGPT is not present.",
    "Inspect the current state, make the required changes, run the relevant checks, and repair failures.",
    "Stop only when the task is complete or a genuine external blocker cannot be resolved safely.",
    "Return a concise execution summary; do not paste large files or logs.",
  ].join(" ");
}

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object") events.push(parsed as Record<string, unknown>);
    } catch {
      // Non-JSON diagnostic lines are ignored; sanitized output is the evidence source.
    }
  }
  return events;
}

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function deepPickString(source: unknown, keys: string[], depth = 4): string | undefined {
  if (!source || depth < 0 || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;
  const direct = pickString(record, keys);
  if (direct) return direct;
  for (const value of Object.values(record)) {
    const nested = deepPickString(value, keys, depth - 1);
    if (nested) return nested;
  }
  return undefined;
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  displayName: "Codex",
  workerPrefix: workerPrefixFor("Codex"),
  binaries: ["codex"],
  envOverride: "C2C_CODEX_BIN",
  build(input) {
    const args = [
      "exec",
      "--json",
      "--cd", input.root,
      "--sandbox", "danger-full-access",
      "-c", 'approval_policy="never"',
    ];
    if (input.skipGitRepoCheck) args.push("--skip-git-repo-check");
    if (input.resumeThreadId) args.push("resume", input.resumeThreadId);
    if (input.model) args.push("--model", input.model);
    args.push("-");
    return {
      command: "codex",
      args,
      promptViaStdin: true,
      workerPrefix: workerPrefixFor("Codex"),
    };
  },
  parseOutput(stdout, fallbackThreadId) {
    let threadId = fallbackThreadId ?? null;
    let summary: string | undefined;
    for (const event of parseJsonLines(stdout)) {
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
    }
    return { threadId, summary };
  },
};

export const cursorAdapter: AgentAdapter = {
  id: "cursor",
  displayName: "Cursor Agent",
  workerPrefix: workerPrefixFor("Cursor Agent"),
  binaries: ["cursor-agent", "cursor"],
  envOverride: "C2C_CURSOR_BIN",
  build(input) {
    const args = ["-p", "--output-format", "stream-json", "--force", "--workspace", input.root];
    if (input.resumeThreadId) args.push("--resume", input.resumeThreadId);
    if (input.model) args.push("--model", input.model);
    args.push(input.prompt);
    return {
      command: "cursor-agent",
      args,
      promptViaStdin: false,
      workerPrefix: workerPrefixFor("Cursor Agent"),
    };
  },
  parseOutput(stdout, fallbackThreadId) {
    const events = parseJsonLines(stdout);
    let threadId = fallbackThreadId ?? null;
    let summary: string | undefined;
    for (const event of events) {
      const session =
        pickString(event, ["session_id", "sessionId", "chatId", "chat_id", "id"]) ??
        deepPickString(event, ["session_id", "sessionId", "chatId", "chat_id"]);
      if (session && !threadId) threadId = session;
      const text =
        pickString(event, ["result", "text", "message", "output"]) ??
        deepPickString(event, ["result", "text", "message"]);
      if (text) summary = text;
    }
    // Fallback: last non-empty line if stream-json was unavailable.
    if (!summary) {
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.length) {
        const last = lines[lines.length - 1]!;
        try {
          const parsed = JSON.parse(last) as Record<string, unknown>;
          summary = pickString(parsed, ["result", "text", "message"]);
        } catch {
          summary = last.slice(0, 2_000);
        }
      }
    }
    return { threadId, summary };
  },
};

export const grokAdapter: AgentAdapter = {
  id: "grok",
  displayName: "Grok",
  workerPrefix: workerPrefixFor("Grok"),
  binaries: ["grok"],
  envOverride: "C2C_GROK_BIN",
  build(input) {
    const args = [
      "--cwd", input.root,
      "--output-format", "json",
      "--permission-mode", "bypassPermissions",
      "--always-approve",
      "--verbatim",
    ];
    if (input.resumeThreadId) args.push("--resume", input.resumeThreadId);
    if (input.model) args.push("--model", input.model);
    args.push("--single", input.prompt);
    return {
      command: "grok",
      args,
      promptViaStdin: false,
      workerPrefix: workerPrefixFor("Grok"),
    };
  },
  parseOutput(stdout, fallbackThreadId) {
    const events = parseJsonLines(stdout);
    let threadId = fallbackThreadId ?? null;
    let summary: string | undefined;
    for (const event of events) {
      const session =
        pickString(event, ["session_id", "sessionId", "session"]) ??
        deepPickString(event, ["session_id", "sessionId"]);
      if (session && !threadId) threadId = session;
      const text =
        pickString(event, ["result", "text", "message", "content", "output"]) ??
        deepPickString(event, ["result", "text", "message", "content"]);
      if (text) summary = text;
    }
    if (!summary) {
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          summary = pickString(parsed, ["result", "text", "message", "content"]);
        } catch {
          const lines = trimmed.split(/\r?\n/).filter(Boolean);
          summary = lines[lines.length - 1]?.slice(0, 2_000);
        }
      }
    }
    return { threadId, summary };
  },
};

const ADAPTERS: Record<AgentId, AgentAdapter> = {
  codex: codexAdapter,
  cursor: cursorAdapter,
  grok: grokAdapter,
};

export function getAdapter(agentId: string): AgentAdapter | null {
  if ((AGENT_IDS as readonly string[]).includes(agentId)) {
    return ADAPTERS[agentId as AgentId];
  }
  return null;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function whichSync(binary: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export interface DetectedAgent {
  id: AgentId;
  displayName: string;
  installed: boolean;
  command: string | null;
}

export function detectAgents(): DetectedAgent[] {
  return AGENT_IDS.map((id) => {
    const adapter = ADAPTERS[id];
    const override = adapter.envOverride ? process.env[adapter.envOverride] : undefined;
    let command: string | null = null;
    if (override && override.trim()) {
      command = isExecutable(override) || whichSync(path.basename(override)) ? override : override;
    } else {
      for (const binary of adapter.binaries) {
        command = whichSync(binary);
        if (command) break;
      }
    }
    return {
      id,
      displayName: adapter.displayName,
      installed: Boolean(command),
      command,
    };
  });
}

export function resolveAgentCommand(agentId: AgentId): string {
  const adapter = ADAPTERS[agentId];
  const override = adapter.envOverride ? process.env[adapter.envOverride] : undefined;
  if (override && override.trim()) return override.trim();
  for (const binary of adapter.binaries) {
    const found = whichSync(binary);
    if (found) return found;
  }
  return adapter.build({ root: process.cwd(), prompt: "", skipGitRepoCheck: false }).command;
}

/** Resolve PATH for tests / spawn when binary names are used without absolute path. */
export function binaryExists(binary: string): boolean {
  if (path.isAbsolute(binary)) return isExecutable(binary);
  return whichSync(binary) !== null;
}

export function tryExecVersion(command: string): string | null {
  try {
    return execFileSync(command, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}
