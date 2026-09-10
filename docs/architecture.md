# Architecture

```
             ┌───────────────────────────┐
             │    ChatGPT Web / Sol      │
             │ Reason / Plan / Dispatch  │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
          Data + Control│          │ Handoff Plane
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │
             │ MCP Server (read + control) │
             │  OAuth AS + PRM     │
             │  Pairing Manager    │
             │  Tunnel Manager     │
             │  Admin API (local)  │
             └──────────┬──────────┘
                        │  scoped worker control (agent_run)
                        ▼
             ┌─────────────────────┐
             │   Local Workspace   │
             └──────────▲──────────┘
                        │ edit / shell / git / test
        ┌───────────────┼───────────────┐
        │               │               │
   ┌────┴────┐    ┌─────┴─────┐   ┌─────┴────┐
   │  Codex  │    │  Cursor   │   │   Grok   │
   │ Harness │    │  Agent    │   │  Build   │
   └─────────┘    └───────────┘   └──────────┘
```

## Principles

- **ChatGPT coordinates. Local agents work.** The bridge dispatches to an
  installed coding-agent CLI (Codex, Cursor Agent, or Grok); it never
  re-implements a coding harness.
- **MCP = data + coordinator plane**: ChatGPT reads the workspace, discovers
  workers via `agents_list`, and calls `agent_run` for one bounded iteration.
  `codex_run` remains a backward-compatible alias for `agent_run` with
  `agent=codex`.
- **Computer Use = handoff plane**: tiny `[C2C]` state messages remain for
  manual sessions and recovery.
- **Explicit authority**: control tools require `execution.control`; every
  dispatched local worker runs with full host access.
- **Workspace is the security boundary**: one bridge = one workspace = one token audience.

## Components (src/)

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app assembly, loopback-only listener, port fallback, runtime state, admin API |
| `mcp/` | McpServer with 9 read tools plus `agents_list` and the scoped `agent_run` / `codex_run` coordinator tools; stateless Streamable HTTP transport (fresh server per request, JSON responses) |
| `auth/` | OAuth 2.1 authorization server: discovery metadata (RFC 8414 + Protected Resource Metadata), dynamic client registration (RFC 7591), authorization-code + PKCE (S256 only), refresh rotation, revocation (RFC 7009). Opaque tokens stored as SHA-256 hashes |
| `pairing/` | PairingCode lifecycle: CSPRNG generation, TTL, attempt limits, IP rate limit, one-time use |
| `workspace/` | Canonical-path containment (realpath of deepest existing ancestor), sensitive-file policy, `.c2cignore`, paginated read/list, ripgrep search with Node fallback, git status/diff with pagination |
| `tunnel/` | `TunnelProvider` interface + Cloudflare Quick and workspace-configured Named Tunnel implementations; business logic is vendor-agnostic |
| `execution/` | JSONL execution records plus optional sanitized command output (`execution_output`) |
| `control/` | Agent adapters (codex / cursor / grok) plus bounded, non-shell invocation of one local worker; thread/session continuation, timeout and evidence recording |
| `process/` | Daemon spawn/reuse, health probing, graceful shutdown |
| `cli/` | `c2c` commands; `--json` everywhere for the Skill |
| `config/`, `logger/` | OS-convention state dir, secret-redacting logger |

## Request lifecycles

**MCP call**: ChatGPT → tunnel (https) → bridge `/mcp` → bearer middleware
(401/403) → stateless StreamableHTTP transport → tool handler → workspace or
agent control layer → JSON result. Read calls use containment/ignore rules;
`agent_run` uses a fixed workspace cwd, an explicit control scope, a bounded
prompt, a finite timeout and full host access for the selected local worker.

**Coordinator iteration**: `agents_list` → `agent_run` (codex | cursor | grok)
→ local agent CLI → sanitized execution record/output → ChatGPT reads
`git_diff`, `test_status` and `execution_output` → ChatGPT calls `agent_run`
again or returns `DONE`.

**Authorization**: 401 with `WWW-Authenticate: resource_metadata=…` →
`/.well-known/oauth-protected-resource/mcp` → AS metadata → DCR →
`/oauth/authorize` (HTML pairing page) → pairing code verified → 302 with
authorization code → `/oauth/token` (PKCE S256) → access + refresh tokens.

**Ports**: prefer 48765, bind 127.0.0.1 only. On conflict, `/health` identifies
whether the occupant is a c2c bridge for the same workspace (reuse) or not
(fall back to an ephemeral port). Configuration follows automatically via the
runtime state file; users never see ports.

**Tunnel**: default is a Cloudflare Quick Tunnel (`cloudflared tunnel --url …`).
The URL changes per start, so `c2c doctor` can restart it and tell the Skill to
Delete + recreate that workspace's ChatGPT connector. A workspace may instead
choose a named hostname once (`c2c tunnel choose --mode named`). The Skill asks
before the first public URL exists; `cloudflared tunnel login` is the only extra
user step. Tunnel name, hostname and preference live under the OS state dir
(`tunnels/<workspaceId>.json`), never in the project. Named starts use
`cloudflared tunnel --url … run <name>` so the public URL stays stable. If named
provisioning fails, C2C falls back to Quick Tunnel. If a named tunnel later
drops, doctor asks for a Cloudflare re-login (`namedRepair`) instead of
rotating the ChatGPT connector.
