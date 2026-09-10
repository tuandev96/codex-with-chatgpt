import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexControlError, CodexExecutor } from "../src/control/codex.js";
import { readExecutionRecords } from "../src/execution/records.js";
import { listExecutionOutputs, readExecutionOutput } from "../src/execution/output.js";
import { nullLogger } from "../src/logger/index.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanup(dir);
  delete process.env.C2C_STATE_DIR;
});

function fakeCodex(root: string, body: string): string {
  const file = write(root, "fake-codex.mjs", body);
  fs.chmodSync(file, 0o755);
  git(root, "add", "fake-codex.mjs");
  git(root, "commit", "-m", "add fake codex worker");
  return file;
}

function input(prompt = "write the requested change"): Parameters<CodexExecutor["run"]>[0] {
  return {
    taskId: "c2c_control",
    iteration: 1,
    prompt,
    sandbox: "workspace-write",
    timeoutMs: 30_000,
  };
}

describe("Codex coordinator control", () => {
  it("returns running, reconciles retries and restart state without duplicating the worker", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("control-poll");
    dirs.push(state, root);
    makeGitRepo(root);
    const fake = fakeCodex(root, [
      "import fs from 'node:fs';",
      "fs.appendFileSync('starts.txt', 'started\\n');",
      "setTimeout(() => console.log(JSON.stringify({type:'thread.started',thread_id:'thread-poll'})), 250);",
    ].join("\n"));
    const workspace = new Workspace(root);
    const options = { command: process.execPath, commandPrefix: [fake], responseWaitMs: 1 };
    const executor = new CodexExecutor(workspace, nullLogger, options);
    const first = await executor.run(input());
    expect(first).toMatchObject({ status: "running", outputId: null, exitCode: null });
    expect(first.nextAction).toContain("execution_summary");
    expect(await executor.run(input())).toMatchObject({ status: "running" });
    await expect(executor.run(input("different payload"))).rejects.toMatchObject({ code: "INVALID_CONTROL_REQUEST" });
    const restarted = new CodexExecutor(workspace, nullLogger, options);
    expect(await restarted.run(input())).toMatchObject({ status: "interrupted" });
    await expect(restarted.run({ ...input(), iteration: 2 })).rejects.toMatchObject({ code: "EXECUTION_BUSY" });
    let result = first;
    for (let poll = 0; poll < 2000 && result.status === "running"; poll++) {
      [result] = await executor.recent(1);
    }
    expect(result).toMatchObject({ status: "completed", exitCode: 0, threadId: "thread-poll" });
    expect(await restarted.run(input())).toEqual(result);
    expect(fs.readFileSync(path.join(root, "starts.txt"), "utf8")).toBe("started\n");
    expect(readExecutionRecords(workspace.id)).toHaveLength(1);
    expect(listExecutionOutputs(workspace.id)).toHaveLength(1);
  });

  it("runs Codex without a shell, resumes by thread id, and records sanitized evidence", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("control-run");
    dirs.push(state, root);
    makeGitRepo(root);
    const fake = fakeCodex(
      root,
      [
        "import fs from 'node:fs';",
        "const prompt = fs.readFileSync(0, 'utf8');",
        "const phase = prompt.includes('resume') ? 'resumed' : 'first';",
        "fs.writeFileSync(`worker-output-${phase}.txt`, `${phase}\\n`);",
        "fs.writeFileSync(`worker-args-${phase}.txt`, process.argv.slice(2).join('\\n'));",
        "console.log(JSON.stringify({type:'thread.started',thread_id:'thread-control-1'}));",
        "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'worker completed safely'}}));",
        "console.log(JSON.stringify({type:'turn.completed'}));",
      ].join("\n")
    );
    const executor = new CodexExecutor(new Workspace(root), nullLogger, {
      command: process.execPath,
      commandPrefix: [fake],
    });

    const first = await executor.run(input());
    expect(first).toMatchObject({
      status: "completed",
      exitCode: 0,
      threadId: "thread-control-1",
      outputAvailable: true,
    });
    expect(fs.readFileSync(path.join(root, "worker-output-first.txt"), "utf8")).toBe("first\n");
    const firstArgs = fs.readFileSync(path.join(root, "worker-args-first.txt"), "utf8").split("\n");
    expect(firstArgs).toEqual([
      "exec", "--json", "--cd", root, "--sandbox", "danger-full-access", "-c", 'approval_policy="never"', "-",
    ]);

    const second = await executor.run({ ...input("resume this iteration"), iteration: 2, resumeThreadId: first.threadId! });
    expect(second.threadId).toBe("thread-control-1");
    expect(fs.readFileSync(path.join(root, "worker-output-resumed.txt"), "utf8")).toBe("resumed\n");
    const resumedArgs = fs.readFileSync(path.join(root, "worker-args-resumed.txt"), "utf8").split("\n");
    expect(resumedArgs).toEqual([
      "exec", "--json", "--cd", root, "--sandbox", "danger-full-access", "-c", 'approval_policy="never"',
      "resume", "thread-control-1", "-",
    ]);

    const records = readExecutionRecords(new Workspace(root).id);
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.outputAvailable)).toBe(true);
    const outputs = listExecutionOutputs(new Workspace(root).id);
    expect(outputs).toHaveLength(2);
    const body = readExecutionOutput(new Workspace(root).id, outputs[0].id);
    expect(body.ok).toBe(true);
    if (body.ok) expect(body.text).toContain("thread-control-1");
  });

  it("rejects option-like values before spawning Codex", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("control-cli-value");
    dirs.push(state, root);
    makeGitRepo(root);
    const fake = fakeCodex(root, "process.exit(0);\n");
    const executor = new CodexExecutor(new Workspace(root), nullLogger, {
      command: process.execPath,
      commandPrefix: [fake],
    });

    await expect(executor.run({ ...input(), resumeThreadId: "--dangerously-bypass-approvals-and-sandbox" }))
      .rejects.toMatchObject<CodexControlError>({ code: "INVALID_CONTROL_REQUEST" });
    await expect(executor.run({ ...input(), model: "--dangerously-bypass-approvals-and-sandbox" }))
      .rejects.toMatchObject<CodexControlError>({ code: "INVALID_CONTROL_REQUEST" });
  });

  it("rejects a second run while the worker is active", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("control-busy");
    dirs.push(state, root);
    makeGitRepo(root);
    const fake = fakeCodex(
      root,
      [
        "setTimeout(() => {",
        "console.log(JSON.stringify({type:'thread.started',thread_id:'thread-busy'}));",
        "}, 200);",
      ].join("\n")
    );
    const executor = new CodexExecutor(new Workspace(root), nullLogger, {
      command: process.execPath,
      commandPrefix: [fake],
    });

    const running = executor.run(input());
    await expect(executor.run({ ...input(), iteration: 2 })).rejects.toMatchObject<CodexControlError>({
      code: "EXECUTION_BUSY",
    });
    await running;
  });

  it("reports a worker failure instead of treating it as completion", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("control-failure");
    dirs.push(state, root);
    makeGitRepo(root);
    const fake = fakeCodex(root, "process.exit(7);\n");
    const executor = new CodexExecutor(new Workspace(root), nullLogger, {
      command: process.execPath,
      commandPrefix: [fake],
    });

    const result = await executor.run(input());
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(7);
  });

  it("keeps a worker timeout terminal and replayable after the bounded response", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("control-timeout");
    dirs.push(state, root);
    makeGitRepo(root);
    const fake = fakeCodex(root, "setInterval(() => {}, 1000);\n");
    const executor = new CodexExecutor(new Workspace(root), nullLogger, {
      command: process.execPath, commandPrefix: [fake], responseWaitMs: 100,
    });
    const request = { ...input(), timeoutMs: 5000 };
    let result = await executor.run(request);
    expect(result.status).toBe("running");
    for (let poll = 0; poll < 100 && result.status === "running"; poll++) [result] = await executor.recent(1);
    expect(result.status).toBe("timeout");
    expect(await executor.run(request)).toEqual(result);
    expect(readExecutionRecords(new Workspace(root).id)).toHaveLength(1);
  }, 15_000);

  it("launches from the connected workspace container and skips the Git-root check when needed", async () => {
    const state = isolateStateDir();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-control-nested-"));
    const repository = path.join(workspaceRoot, "nested-repository");
    dirs.push(state, workspaceRoot);
    fs.mkdirSync(repository, { recursive: true });
    makeGitRepo(repository);
    const fake = write(
      workspaceRoot,
      "fake-codex.mjs",
      [
        "import fs from 'node:fs';",
        "fs.writeFileSync('worker-cwd.txt', process.cwd());",
        "fs.writeFileSync('worker-args.txt', process.argv.slice(2).join('\\n'));",
        "console.log(JSON.stringify({type:'thread.started',thread_id:'thread-nested'}));",
        "console.log(JSON.stringify({type:'turn.completed'}));",
      ].join("\n")
    );
    fs.chmodSync(fake, 0o755);

    const executor = new CodexExecutor(new Workspace(workspaceRoot), nullLogger, {
      command: process.execPath,
      commandPrefix: [fake],
    });
    const result = await executor.run(input());

    expect(result.status).toBe("completed");
    expect(fs.readFileSync(path.join(workspaceRoot, "worker-cwd.txt"), "utf8")).toBe(
      fs.realpathSync.native(workspaceRoot)
    );
    expect(fs.readFileSync(path.join(workspaceRoot, "worker-args.txt"), "utf8")).toContain(
      "--skip-git-repo-check"
    );
  });

  it("dispatches to cursor agent with agent id and isolated job key", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("control-cursor");
    dirs.push(state, root);
    makeGitRepo(root);
    const fake = fakeCodex(
      root,
      [
        "import fs from 'node:fs';",
        "fs.writeFileSync('cursor-args.txt', process.argv.slice(2).join('\\n'));",
        "fs.writeFileSync('cursor-prompt.txt', process.argv.slice(-1)[0] ?? '');",
        "console.log(JSON.stringify({type:'result',session_id:'cursor-t1',result:'cursor ok'}));",
      ].join("\n")
    );
    const executor = new CodexExecutor(new Workspace(root), nullLogger, {
      command: process.execPath,
      agentCommands: { cursor: process.execPath },
      commandPrefix: [fake],
    });
    const result = await executor.run({ ...input("use cursor"), agent: "cursor" });
    expect(result).toMatchObject({ status: "completed", agent: "cursor", threadId: "cursor-t1" });
    const args = fs.readFileSync(path.join(root, "cursor-args.txt"), "utf8");
    expect(args).toContain("--force");
    expect(args).toContain("--workspace");
    const prompt = fs.readFileSync(path.join(root, "cursor-prompt.txt"), "utf8");
    expect(prompt).toContain("[C2C WORKER MODE]");
    expect(prompt).toContain("Cursor Agent");

    // Same taskId/iteration with a different agent is a separate job.
    const codexResult = await executor.run({ ...input("use codex"), agent: "codex" });
    expect(codexResult.agent).toBe("codex");
    expect(codexResult.status).not.toBe("running");
  });

  it("dispatches to grok with bypass permissions and single-turn prompt", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("control-grok");
    dirs.push(state, root);
    makeGitRepo(root);
    const fake = fakeCodex(
      root,
      [
        "import fs from 'node:fs';",
        "fs.writeFileSync('grok-args.txt', process.argv.slice(2).join('\\n'));",
        "console.log(JSON.stringify({session_id:'grok-t1',result:'grok ok'}));",
      ].join("\n")
    );
    const executor = new CodexExecutor(new Workspace(root), nullLogger, {
      command: process.execPath,
      agentCommands: { grok: process.execPath },
      commandPrefix: [fake],
    });
    const result = await executor.run({ ...input("use grok"), agent: "grok" });
    expect(result).toMatchObject({ status: "completed", agent: "grok", threadId: "grok-t1", summary: "grok ok" });
    const args = fs.readFileSync(path.join(root, "grok-args.txt"), "utf8");
    expect(args).toContain("bypassPermissions");
    expect(args).toContain("--single");
  });

  it("rejects an unknown agent id", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("control-unknown-agent");
    dirs.push(state, root);
    makeGitRepo(root);
    const executor = new CodexExecutor(new Workspace(root), nullLogger, {
      command: process.execPath,
      commandPrefix: [fakeCodex(root, "console.log('x')")],
    });
    await expect(executor.run({ ...input(), agent: "claude" as never })).rejects.toMatchObject({
      code: "INVALID_CONTROL_REQUEST",
    });
  });
});
