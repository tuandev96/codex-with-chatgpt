# C2C Agent Protocol

Coordinator plane: MCP (`agent_run` dispatches one bounded local worker
iteration — codex, cursor, or grok — after the explicit `execution.control`
scope is granted. `codex_run` is a backward-compatible alias for codex).
Data plane: MCP (ChatGPT pulls files, diffs, search results itself).
Handoff plane: Computer Use (tiny structured messages typed into the ChatGPT UI).

Legacy `[C2C]` messages carry state, never file content or logs. `agent_run`
carries only the bounded task instructions needed for one worker iteration.

## Coordinator job status

`agent_run` waits at most 10 seconds per response, not for the whole worker.
If it returns `running`, keep polling `execution_summary.jobs` until terminal;
do not treat an empty `records` list as proof that no worker started. A running
job has `outputId: null`; output becomes available after execution finishes.
Repeating the same agent, task ID, iteration and arguments reads the existing
result without launching again. Reusing that key with different arguments is
rejected. Only use a new iteration after reconciling the previous result and
reviewing the current candidate. `completed` means process exit 0, not
requirement acceptance. Call `agents_list` first when unsure which local
agent binaries are installed.

Minimal job metadata and results persist in the local state directory without
the coordinator prompt. If a bridge restart loses a live worker, its job is
reported `interrupted` and the workspace lock remains closed until a local
operator reconciles the worker and files. Do not remove that lock blindly.
This protocol does not wake a ChatGPT conversation after its turn has ended.

## States

```
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

| State | Sender | Meaning |
| --- | --- | --- |
| INIT | Codex | New task; asks ChatGPT to inspect + plan |
| PLAN | ChatGPT | Executable plan for the next iteration |
| EXECUTING | Codex | (optional) execution in progress |
| EXECUTED | Codex | Iteration finished; metadata only |
| REVIEW | ChatGPT | (implicit) ChatGPT is inspecting via MCP |
| DONE | ChatGPT | Success criteria met |
| BLOCKED | ChatGPT | Cannot proceed; contains reason |
| ERROR | either | Protocol/infrastructure failure |
| HANDOFF | Codex | Continuation brief sent to a replacement conversation |

There is no `STATE: RESUME`. If Codex restarts mid-task, it reads a **local
checkpoint** on the session file (`protocolState`, `waitingFor`, goal, issues,
next step). Those values are not ChatGPT protocol states. ChatGPT still sees
only the table above. If the original chat is gone, Codex sends HANDOFF
built from the checkpoint (never from logs).

Local checkpoint values (session only):

| Checkpoint | Meaning |
| --- | --- |
| `INIT` | INIT sent; waiting for PLAN |
| `PLAN_RECEIVED` | PLAN in hand; not finished executing |
| `EXECUTING` | Codex is applying the current PLAN |
| `EXECUTED_LOCAL` | Recorded locally; EXECUTED not yet typed |
| `EXECUTED_SENT` | EXECUTED typed; waiting for review |
| `DONE` / `BLOCKED` | Terminal; DONE should `--clear-checkpoint` |

Legacy sessions without a checkpoint keep the old loop. The first normal
iteration after this version writes a checkpoint automatically.

Do not re-pair, recreate the connector, or rewrite Project instructions
just to resume.

## Message format

Every control message starts with `[C2C]` and key-value headers, then sections.
Keep messages < 1 KB. No diffs, no logs, no file bodies.

### INIT (Codex → ChatGPT)

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
Implement dark mode.

INSTRUCTION:
Inspect the connected workspace through Codex with ChatGPT MCP.
Create an implementation plan for Codex.
```

### PLAN (ChatGPT → Codex)

```
[C2C]
STATE: PLAN
TASK_ID: c2c_f81a
ITERATION: 1

GOAL:
...

RATIONALE:
...

ACTIONS:
1. ...
2. ...
3. ...

FILES_LIKELY_INVOLVED:
...

TESTS:
...

SUCCESS_CRITERIA:
...
```

Plans must be finite, concrete, executable. Not 40-step epics.

#### PLAN completion contract

A PLAN is executable only when it contains all of the following. The fields may
be rendered as text or YAML, but do not omit them:

- `SCOPE`: the exact workspace/repository and the files or surfaces in scope;
  separate every repository when a request names more than one.
- `ACCEPTANCE_CRITERIA`: stable `AC-01`, `AC-02`, ... entries covering every
  user requirement, including required tests, review, deployment or platform
  checks. Mark each as `PENDING` at plan time.
- `ACTIONS`: each step names its `ac_ids`, target file/surface, intended change,
  `done_when`, and the concrete command or observation that will verify it.
- `EVIDENCE_PLAN`: the actual current-code, test, artifact, runtime or UI
  evidence needed for each criterion. A source edit, generated report, log
  string, or worker claim alone is not evidence of completion.
- `NEXT_EXPECTED_STEP`: exactly the first incomplete or blocked step; never a
  generic “continue” or a step that was already verified.
- `COMPLETION_GATE`: the conditions for `DONE`, including current evidence for
  every applicable criterion, no unresolved current failure, no stale/unknown/
  cancelled check, and required review of the exact candidate.

Use `STATUS: READY` only when the plan is executable. Use
`STATUS: NEEDS_CHANGES` when the current candidate or prior iteration has a
failure; list the failing `AC-*` IDs and corrective actions. Do not silently
drop an unmet criterion to make the plan look complete.

### EXECUTED (Codex → ChatGPT)

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a
ITERATION: 1

RESULT:
Execution finished.

CHANGED_FILES:
4

TESTS:
27 passed

Please independently inspect the workspace and current git diff through MCP.
If execution_output lists a readable item for this iteration, list then read it.
If status is restricted, ignore it and review from git_diff.
```

Before sending EXECUTED, Codex records the iteration:
`c2c record --task c2c_f81a --iteration 1 --changed-files ... --tests ... --exit-status ok`
and, when a test/build/lint/typecheck was run, `--command` plus `--output-file`.
ChatGPT reads metadata via `execution_summary` / `test_status`. Command output
is a separate opt-in: `execution_output` (`list` then `read`). Codex nominates
the log; a **local sanitizer** decides whether ChatGPT may see the body
(tokens/paths redacted; private keys withheld entirely; size/line caps).
Restricted items appear in `list` with no body. Old records without output
stay valid. Never paste logs into the control message.

### DONE / BLOCKED (ChatGPT → Codex)

```
[C2C]
STATE: DONE
TASK_ID: c2c_f81a
ITERATION: 3

SUMMARY:
...
```

```
[C2C]
STATE: BLOCKED
TASK_ID: c2c_f81a
ITERATION: 3

REASON:
...

NEEDS:
...
```

`DONE` is a gated conclusion, not a progress update. Emit `DONE` only when
every applicable `AC-*` has current, criterion-specific evidence tied to the
current code/configuration and the latest candidate has been reviewed. A single
green command, file existence, prior PASS, or Codex's own report is never
enough. If any criterion is incomplete, stale, failing, unknown, cancelled,
or missing required review, emit `STATE: PLAN` with `STATUS: NEEDS_CHANGES`
and make `NEXT_EXPECTED_STEP` the smallest actionable correction.

Use `BLOCKED` only for a real external blocker (for example missing authority,
login, hardware, or a required decision). Include the blocked `AC-*` IDs, the
exact blocker, why Codex cannot resolve it safely, the owner, and the single
unblock action. A timeout or ambiguous side effect must be reconciled before a
retry; it is not permission to declare success.

### HANDOFF (Codex → new ChatGPT conversation)

`c2c session --json` → `conversation.mode` chooses how chats are grouped.

- **long-chat:** one long-lived C2C conversation per workspace. Codex opens a
  replacement chat only when the user asks, the old chat lags, or the chat was
  lost.
- **project:** one ChatGPT Project (collection) per workspace. A new Codex
  conversation starts a new chat **inside that Project**. The same Codex
  conversation keeps using its saved chat URL.

Right after the boot prompt, Codex sends a HANDOFF so the new chat can
continue — a brief, never a data dump (the new chat re-reads code via MCP).
Project instructions and project-only memory hold durable workspace identity.
HANDOFF still wins for the current task:

Trust order: connector (current code) > HANDOFF (this task) > Project
instructions > Project memory.

```
[C2C]
STATE: HANDOFF
TASK_ID: c2c_f81a
ITERATION: 4

ORIGINAL_GOAL:
Implement dark mode with a persisted user preference.

PROGRESS:
- Iter 1-2: theme context + toggle implemented, reviewed OK.
- Iter 3: persistence added; review found the toggle flashes on load.

CURRENT_STATE:
EXECUTED (iteration 4 fix applied, not yet reviewed).

KNOWN_ISSUES:
Flash-on-load fix needs verification in src/theme/ThemeProvider.tsx.

AC_STATUS:
- AC-01 VERIFIED: theme context and toggle.
- AC-02 PENDING: persistence and no flash on load.

NEXT_EXPECTED_STEP:
Independently review iteration 4 via git_diff and reply PLAN or DONE.
```

## Loop limits

`maxIterations` (default 12, configurable in `.c2c.json`). When reached, Codex
pauses and asks the user whether to continue.

## Boot Prompt

Send once at the start of every new C2C conversation:

```
You are the coordinator, planning and review layer of a Codex coding session.

The local Codex worker owns execution.
You own high-level reasoning, dispatch, planning and review.

You have access to the current local workspace through the
"Codex with ChatGPT" MCP connector.

Rules:

1. Do not ask Codex to paste files that are available through MCP.
2. Inspect only the files needed for the task.
3. Use MCP to inspect current code, git status and diff.
4. Produce concise executable plans.
5. When `execution.control` is available, call `agents_list` to discover
   installed workers, then call `agent_run` with the complete PLAN to dispatch
   the selected local agent (default codex). The connected workspace root remains
   the connector/read boundary and worker cwd even when it contains multiple Git repositories. Do
   not return BLOCKED merely because execution records are initially empty.
   not return BLOCKED merely because execution records are initially empty.
6. After `agent_run` returns, independently inspect the diff and evidence.
   If execution_output lists a readable item for this iteration, list
   then read it. If status is restricted, ignore the body and review
   from git.
7. Do not assume an implementation succeeded just because Codex says so.
8. Continue until the implementation satisfies the success criteria.
9. Avoid unnecessary rewrites.
10. Return C2C structured control messages.
11. Be substantive. PLAN and review replies must carry enough signal for
    Codex to act on: rationale, per-file natural-language suggestions
    (which file, what to change and why), risks worth checking, and test
    advice. Never reply with a bare one-liner. Substance over length —
    but do not generate 40-step epics either.
12. If you receive a HANDOFF message, this conversation continues an
    existing task. Trust the handoff brief for history, re-read any code
    you need through MCP, and resume from NEXT_EXPECTED_STEP.
13. If this chat sits in a ChatGPT Project, use only the connector named
    in that Project's instructions. Do not use another workspace's connector.
14. Before writing PLAN, normalize the user's request into a complete,
    stable-ID acceptance-criteria inventory. Include explicit scope,
    out-of-scope items, required permissions, and every requested deliverable;
    never infer that one implementation step represents the whole request.
15. Every PLAN action must map to one or more criterion IDs and include a
    concrete done-when condition, verification command/observation, and
    evidence expected from the current candidate. Keep a criterion ledger
    across iterations and carry incomplete IDs forward through HANDOFF.
16. After EXECUTED, independently compare the current code, git diff and
    released execution output with every criterion. Re-check freshness after
    any source/config/test/dependency change. A passing command does not prove
    unrelated criteria, and old evidence does not survive changed inputs.
17. Continue the PLAN → EXECUTED → REVIEW loop until the completion gate is
    true. Never end with DONE because the plan was written, one step passed,
    the worker sounded confident, or the iteration limit was reached.
18. If work remains, return PLAN with `STATUS: NEEDS_CHANGES`, failing or
    unverified criterion IDs, corrective per-file actions, and the exact
    `NEXT_EXPECTED_STEP`. Use BLOCKED only for an external blocker that Codex
    cannot safely resolve. Preserve the distinction between implementation,
    current evidence, independent review, merge readiness, and release.
```

## Project instructions

New workspaces store durable identity in the ChatGPT Project settings
(指令), not in every boot prompt. The Skill fills this template once.
Never put a public or temporary URL in the instructions — only the
connector **name**.

```
You are the coordinator, planning and review layer for one local workspace.
The local Codex worker executes.

This Project is bound only to:
- Workspace name: {{workspace_name}}
- Kind: {{project_type}} ({{languages}} / {{frameworks}})
- Connector (use this one only): {{connector_name}}

When you call tools, use ONLY that connector. Do not use any other
Codex with ChatGPT connector. If workspace_info names a different
workspace, stop. Do not plan. Do not use this Project's memory.

Read code, git, diffs, and any released command output through that
connector. Never ask anyone to paste file bodies, diffs, or logs. After
`codex_run` returns, call execution_output (list, then read) when a readable
item exists; if status is restricted, review from git instead. Never upload
the repo into this Project's files or sources.

When the connector has `execution.control`, ChatGPT is the coordinator: call
`codex_run` with a complete plan, wait for the worker, inspect the current
candidate, and call it again for the next incomplete criterion. The connected
workspace root remains the connector/read boundary even when it contains
multiple repositories. Every local worker has full host access, including
resumed threads. A missing execution record before the first run is not a blocker.

When facts conflict, trust this order:
1. Current code from the connector
2. A HANDOFF in this chat (this task's goal, progress, next step)
3. These instructions
4. This Project's memory (durable architecture only; stale memory loses)

This Project's memory is only for this workspace. On HANDOFF, trust the
brief, re-read code through the connector, and resume at NEXT_EXPECTED_STEP.

Be substantive: why, which file, what to test. No empty one-liners and
no 40-step epics. Use C2C control messages.

For every task, maintain a criterion ledger with stable `AC-*` IDs. A PLAN
must cover all applicable user requirements and map each action to an ID,
target, done-when condition, verification command/observation, and expected
evidence. `NEXT_EXPECTED_STEP` must name the first incomplete step.

After EXECUTED, review current code, git diff, and released execution output
for every ID. Evidence must be current and tied to the candidate; do not count
file existence, a generated report, a log string, a prior PASS, or Codex's
claim as proof. Changes to code, configuration, tests, dependencies or other
inputs make dependent evidence stale.

Return `DONE` only when all applicable IDs have current evidence, no current
failure/unknown/cancelled check remains, and required review of the exact
candidate is complete. Otherwise return a substantive `PLAN` with
`STATUS: NEEDS_CHANGES`, the unmet IDs, and one actionable next step. Use
`BLOCKED` only for a real external blocker and state the owner and unblock
action. Never call incomplete work DONE merely because one test passed or the
iteration limit was reached.
```
