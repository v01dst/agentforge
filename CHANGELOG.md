# Changelog

All notable changes to AgentForge are documented here.

## [0.0.2] — 2026-08-31

### Workflow documents: schema, validation, import/export (Phase 7)

- Versioned JSON workflow documents (`version: 1`): nodes carry type + optional handler name/branches/config; edges carry labels and condition-handler names. Behavior is attached at compile time through a handlers registry plus live agent/model/tool instances — no `eval`, no code in documents.
- `validateWorkflowDocument` reports every structural problem with precise messages (version, duplicate ids, unknown types, dangling/duplicate edges, missing start, unreachable-node warnings) and verifies handler availability when a registry is provided.
- `compileWorkflowDocument` builds an executable `Workflow`; `parseWorkflowDocument`/`serializeWorkflowDocument` provide validated import/export. `WorkflowBuilder.build()` accepts an optional EventBus.
- Deterministic replay tests: repeated compilations of the same document produce identical step histories (JSON-serializable), branching, parallel fan-out, and retry semantics covered (`packages/workflows/test/document.test.ts`).
- New `agentforge workflows validate <file.json>` CLI command (`--json` supported).

### Session depth (v0.1 phase D)

- New session operations: `agentforge sessions rename <id> <title>`, `export <id> [--format md|json] [--out <path>]`, `prune --older-than-days <n> | --keep <n> [--dry-run]`, and chat slash commands `/rename <title>` (current session) and `/show [id]` (recent transcript).
- Schema versioning: stored sessions carry `version: 1`; older files are treated as version 1 transparently.
- Context compaction: transcripts past 40 entries are compacted on disk to the most recent 20 plus a bounded `[earlier conversation]` summary; the live TUI view stays intact and summaries carry across resumes. `transcriptSession` replay prompts compact the same way so one-shot entrypoints stay bounded in long sessions.
- Autosave integrity fixes: custom titles (`/rename`) survive subsequent autosaves, `createdAt` is no longer rewritten on every save.
- `agentforge inspect <id>` now recognizes stored session ids (or `--session`) and renders transcript + metadata; corrupt session files are skipped by list/load instead of crashing.

### Provider streaming and conformance (v0.1 phase E)

- Streaming implemented for all HTTP providers: OpenAI (`stream_options.include_usage`), Anthropic (SSE events incl. `input_json_delta` assembly), Gemini (`streamGenerateContent?alt=sse`) — openai-compatible endpoints stream through the OpenAI adapter. Streamed tool-call argument fragments are accumulated per index and emitted as assembled calls.
- New `ModelHttpError` with `status`, `retryable` (429/5xx), and `retryAfterMs` (from `Retry-After`, seconds or HTTP-date); all adapters throw it instead of generic errors.
- Recorded-fixture conformance tests: streaming text/tool-calls/usage per protocol, stream-vs-generate content equality, and error classification (`packages/models/test/streaming-conformance.test.ts`).
- New `agentforge models test <provider> [--model] [--prompt] [--json]`: one-shot connectivity probe for builtin providers and managed endpoints with precise failures (names the missing env var, HTTP status + retryability).

### CLI verification backlog

- New CLI tests: `doctor --json` pass/fail with resolved entrypoint paths, `--cwd` project targeting from a foreign working directory, config-relative run discovery, `init .` name derivation (extends existing scaffold coverage).

### Permission and safety hardening (Phase 5)

- Per-tool allow/deny rules persisted at project level (`.agentforge/permissions.json`) with `agentforge permissions list|allow|deny|remove <tool>` (`--json` on list). Evaluation precedence: most specific rule wins, deny beats allow, rules beat mode defaults — deny blocks a tool in every mode, allow skips its approval prompt. Workspace path checks are never bypassed by rules.
- Live coding sessions load project rules at runner build time; malformed rule files fail closed (rules ignored with a stderr warning, never a silent bypass).
- `run_command` now rejects path-like arguments resolving outside the workspace root (absolute paths, `..` escapes, `~`, `--flag=/etc/...` values; `/dev/null` exempt; opt out with `restrictPathArgs: false`). Default blocklist extended: `rm` against `~`/`*`/`.`/`..`/`$HOME`, `su`, `chown` on root paths, `dd of=/dev/*`, `shutdown`/`reboot`/`halt`/`poweroff`, `wipefs`, `curl|sh` / `wget|sh`.
- `read_file` refuses credential/secret files by default (`.env*` except `.env.example`, `*.pem|key|p12|pfx|keystore`, `id_rsa/dsa/ecdsa/ed25519`, `.ssh/`, `.netrc`, `.git-credentials`, `.htpasswd`); `search_text` skips them entirely. Opt in with `allowSecretFiles: true`.
- `http_request` follows redirects manually and re-validates every hop against private-network blocks and host allowlists — closing the redirect-bypass SSRF hole. Numeric IPv4 literals that `isIP` misses (decimal `2130706433`, hex `0x7f000001`, octal `0177.0.0.1`, shorthand `127.1`) are canonicalized and privacy-checked.
- New adversarial suites: `packages/tools/test/security.test.ts` (SSRF bypass attempts, redirect chains, secret-file reads, path-arg escapes, blocklist coverage) and `packages/cli/test/permissions-rules.test.ts` (rule store, precedence, policy wiring).

### Durable sessions (v0.1 phase C)

- Conversations persist automatically to `.agentforge/sessions/` (project) and `~/.agentforge/sessions/` (global); the newest transcript restores on next launch with an inline note.
- New commands: `agentforge sessions list|resume <id>|delete <id>` and chat slash commands `/sessions`, `/resume [id]`, `/new`.
- Session ids are validated; stores merge project-over-global with deterministic ordering.

### Coding agent loop (v0.1 phase B)

- `agentforge` interactive sessions now run a real core Agent with the seven repository tools attached (`list_files`, `read_file`, `search_text`, `apply_patch`, `inspect_git_diff`, `run_command` when allowlisted, `run_tests`) — the terminal experience is a working coding agent, not just a model chat.
- Permission modes enforced live via `/mode [read-only|ask|workspace-write|trusted]`; `ask` mode surfaces an in-TUI approval card (y / a=always this session / n / Esc) with tool summary and queued count; headless contexts fail closed.
- Tool activity renders live during turns (`⠿ running` → `✓ done · duration`) by bridging core agent events into the streaming delta channel; project-mode turns append a one-line git diff summary.

### Release automation

- GitHub Actions: CI gate on every push/PR (Node 20 & 22); `v*` tags build, test, and publish all `@agentforge-oss/*` packages via `NPM_AUTH_TOKEN`.

### TUI skin engine (v0.1 "Forge", phase A)

- New semantic skin system (`packages/cli/src/ui/skin.ts`): three built-in skins — **forge** (gold/amber, default), **midnight** (cyan/indigo), **paper** (light) — with truecolor hex palettes that degrade to ANSI-256/plain automatically. Project `.agentforge/skin.json` and global `~/.agentforge/skin.json` override presets (palette-level merges supported); `AGENTFORGE_SKIN` env selects a preset.
- `/skin [name]` slash command lists and switches skins, persisting the choice globally.
- Startup splash redesigned: block-letter AGENT / FORGE wordmark in the skin's gold gradient ramp, tagline, mode/version/provider line, live pulse; compact ASCII fallback preserved.
- Frame chrome, composer prompt, tool-event lines, and message roles now all read from the active skin at render time via live theme tokens.

### Versioning

- The project is now branded **AgentForge v0.01** (`0.0.1`): a deliberate restart of the public version line. All workspace packages, scaffold templates, and the CLI banner report `0.0.1`. This release (`0.0.2`) is the first increment on that line; scaffolds and the banner now reference `0.0.2`.

### Roadmap truth pass and baseline re-verification

- `PROJECT_STATUS_AND_ROADMAP.md` updated to reflect landed work (Phases 0–5 statuses, Milestone C completion, §6.8/§7.5/§11.5/§11.3).
- Full quality gate re-verified twice on-device, serially: typecheck 23/23, lint 23/23, test 23/23, build 14/14 (playground production build included).

### Extensions: plugins, skills, MCP (new)

- **Plugins** — local modules registered in `.agentforge/extensions.json` that contribute tools and/or system instructions to project agents. Fault-tolerant loader reports per-path failures; `agentforge plugins list|add|remove` manages registrations (add probes the module before writing); `/plugins` slash command lists contributions; doctor surfaces every plugin with its tools. Scaffolds ship a working example plugin plus registration.
- **MCP** — new `@agentforge-oss/mcp` package: stdio client over `@modelcontextprotocol/sdk`, JSON-Schema→Zod input adaptation, tools namespaced as `<server>.<tool>` with restrictive `mcp:<server>` permissions and 60s timeouts. `agentforge mcp list|add|remove|tools` manages servers in `.agentforge/extensions.json`; `add` prints exactly which executable will be launched (security surfacing). Scaffolded agents merge plugin + MCP tool contributions automatically.
- **Skills** (from earlier unreleased work) continue to load from `.agentforge/skills/*.md`.

### Chat UI

- Live tool-call activity during turns (running spinners replaced by done-markers with durations, capped at 8 events).
- Ranked fuzzy matching in the command palette (prefix > word-boundary > substring > subsequence).

## [0.3.1] and earlier

See git history for the 0.2.x–0.3.x line (chat-first TUI architecture, global/session mode, real model runner, provider endpoints, playground persistence).

### Custom and proxy model endpoints

- `@agentforge/models` gains first-class proxy support: a new `openai-compatible` provider kind (OpenRouter, Together, LM Studio, Ollama, vLLM, any OpenAI-shaped endpoint), plus `createConfiguredModel(definition)` / `isProviderReady()` / `resolveApiKey()` helpers built on a typed `ProviderDefinition { protocol, model, baseUrl, apiKeyEnv }`. All four protocols (`openai`, `anthropic`, `google`, `openai-compatible`) accept custom `baseUrl`, so Anthropic/Gemini-style relays work too. Credentials are resolved from environment variables only.
- New CLI-managed endpoint registry in `.agentforge/providers.json`: `agentforge providers add <name> --protocol <p> --base-url <url> --model <id> --api-key-env <VAR>` (plus `remove` and `list`). Entries merge into project config at load time without rewriting user-owned `agentforge.config.ts`; secrets never touch disk.
- `agentforge models list` reports managed endpoints with readiness derived from their credential variables; `/models` inside chat shows the same report.
- Scaffolded projects resolve models in a documented order: `AGENTFORGE_PROVIDER_MODULE` → named managed endpoint → builtin provider → deterministic mock, with a clear error naming the fix when an unknown provider is selected.

### Playground

- The runs API now honors provider selection: POST bodies may specify `provider`/`model`/`baseUrl`/`apiKeyEnv`. Requests are resolved against **server-side** environment credentials; raw API keys are never accepted over HTTP. Missing configuration returns a clear 400 that names the required variable instead of silently falling back to mock.
- Run history is persisted through `JsonlRunStore` (`.agentforge/playground-runs.jsonl`, gitignored; override with `AGENTFORGE_PLAYGROUND_RUNS_PATH`) and served back via a new `GET /api/runs`; the UI loads real persisted history on mount instead of starting empty every session.
- Settings modal supports custom endpoints (Base URL, Model ID, key variable name); unimplemented sidebar controls are disabled and labeled; mock-provider cost figures remain placeholder-rate estimates and are labeled as such in the changelog.
- New test suites: model-selection unit tests (6) and route integration tests (6) including a live stub-server round trip asserting URL path, authorization header, and model id forwarding.

### Verification notes

- Verified end-to-end on-device: scaffold → offline install → generated tests → `providers add` → chat through a local OpenAI-compatible stub (stub received correct path, bearer token, and model id). Repo-wide `typecheck`, `lint`, and `test` pass across all 21 turbo tasks (run serially with `--concurrency=1`). A production `next build` of the playground was not re-run on this RAM-constrained device after the final edits; development compile, tsc, and vitest cover the changes. Rerun the full parallel gate on a desktop before release.

### CLI

- `agentforge chat` now prefers a stateful multi-turn session: projects may export `createSession()` returning `{ send(input, { signal }), reset?(), close?() }`; turns keep real conversation history instead of replaying a flattened transcript. A transcript fallback still supports one-shot `run()` entrypoints.
- Plain-mode chat (non-TTY or `--plain`): streaming deltas, per-turn `[run · provider/model · duration · tokens]` footer, multiline input with trailing `\`, per-turn Ctrl-C cancellation, double Ctrl-C to exit, and piped-input scripting (`echo "hi" | agentforge chat`).
- New chat slash commands in plain mode: `/models`, `/tools`, `/workflows`, plus existing `/help /status /providers /model /connect /clear /exit`.
- New `agentforge models list` command reporting built-in adapters (openai, anthropic, google, mock), required credentials and readiness, default models, and project-config providers; `--json` supported.
- Entrypoint-not-found errors now show the resolved absolute path, the discovered config path, and suggest `--cwd` or `doctor`.
- `agentforge init` prints honest next steps: pnpm instructions in local-link mode, and an explicit warning that packages are not yet published when scaffolding in registry mode.
- Generated projects: `.gitignore`, `.env.example`, working `test`/`typecheck` scripts, `@types/node`, a streaming mock model, and a session test covering multi-turn context.

### Scaffold installation

- Local-link scaffolds now emit `pnpm.overrides` pointing at the monorepo packages. This fixes generated-project installs, because intra-monorepo `workspace:*` dependencies inside linked packages cannot be resolved by bare `file:` dependencies. Verified offline end-to-end: scaffold → install → typecheck → tests → two-turn chat.

## [0.1.0] - 2026-08-19

Initial open-source release with typed agent and tool abstractions, model-provider adapters, workflow execution, memory, observability, CLI scaffolding, examples, and the playground foundation.
