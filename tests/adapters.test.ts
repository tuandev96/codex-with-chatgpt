import { describe, expect, it } from "vitest";
import {
  AGENT_IDS,
  cursorAdapter,
  getAdapter,
  grokAdapter,
  codexAdapter,
} from "../src/control/adapters.js";

describe("agent adapters", () => {
  it("exposes the three supported agents", () => {
    expect([...AGENT_IDS]).toEqual(["codex", "cursor", "grok"]);
    expect(getAdapter("codex")?.id).toBe("codex");
    expect(getAdapter("cursor")?.id).toBe("cursor");
    expect(getAdapter("grok")?.id).toBe("grok");
    expect(getAdapter("claude")).toBeNull();
  });

  it("builds a full-access Codex spawn plan with stdin prompt", () => {
    const plan = codexAdapter.build({
      root: "/tmp/ws",
      prompt: "[C2C WORKER MODE]\n\nCoordinator task:\nDo the thing",
      skipGitRepoCheck: false,
      model: "o4-mini",
    });
    expect(plan.command).toBe("codex");
    expect(plan.promptViaStdin).toBe(true);
    expect(plan.args).toContain("exec");
    expect(plan.args).toContain("--json");
    expect(plan.args).toContain("danger-full-access");
    expect(plan.args).toContain("--model");
    expect(plan.args[plan.args.length - 1]).toBe("-");
  });

  it("builds a Cursor Agent spawn plan with forced workspace and stream-json", () => {
    const plan = cursorAdapter.build({
      root: "/tmp/ws",
      prompt: "do work",
      skipGitRepoCheck: true,
      resumeThreadId: "chat-1",
    });
    expect(plan.command).toBe("cursor-agent");
    expect(plan.promptViaStdin).toBe(false);
    expect(plan.args).toContain("-p");
    expect(plan.args).toContain("--force");
    expect(plan.args).toContain("--workspace");
    expect(plan.args).toContain("--resume");
    expect(plan.args[plan.args.length - 1]).toBe("do work");
    // Cursor has no --skip-git-repo-check; workspace path is enough.
    expect(plan.args).not.toContain("--skip-git-repo-check");
  });

  it("builds a Grok single-turn plan with bypass permissions", () => {
    const plan = grokAdapter.build({
      root: "/tmp/ws",
      prompt: "do work",
      skipGitRepoCheck: false,
      resumeThreadId: "session-uuid",
    });
    expect(plan.command).toBe("grok");
    expect(plan.promptViaStdin).toBe(false);
    expect(plan.args).toContain("--cwd");
    expect(plan.args).toContain("bypassPermissions");
    expect(plan.args).toContain("--always-approve");
    expect(plan.args).toContain("--single");
    expect(plan.args).toContain("session-uuid");
  });

  it("parses Codex JSONL worker output", () => {
    const parsed = codexAdapter.parseOutput(
      [
        JSON.stringify({ type: "thread.started", thread_id: "t-9" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done well" } }),
        JSON.stringify({ type: "turn.completed" }),
      ].join("\n")
    );
    expect(parsed.threadId).toBe("t-9");
    expect(parsed.summary).toBe("done well");
  });

  it("parses Cursor stream-json session and result", () => {
    const parsed = cursorAdapter.parseOutput(
      [
        JSON.stringify({ type: "system", session_id: "cursor-session-1" }),
        JSON.stringify({ type: "result", result: "cursor finished" }),
      ].join("\n")
    );
    expect(parsed.threadId).toBe("cursor-session-1");
    expect(parsed.summary).toBe("cursor finished");
  });

  it("parses Grok JSON output with session id", () => {
    const parsed = grokAdapter.parseOutput(
      JSON.stringify({ session_id: "grok-session-1", result: "grok finished" })
    );
    expect(parsed.threadId).toBe("grok-session-1");
    expect(parsed.summary).toBe("grok finished");
  });

  it("falls back to the resume thread when parse finds no session", () => {
    expect(cursorAdapter.parseOutput("plain text", "fallback-chat").threadId).toBe("fallback-chat");
    expect(grokAdapter.parseOutput("not-json", "fallback-session").threadId).toBe("fallback-session");
  });
});
