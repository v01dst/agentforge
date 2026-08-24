# Changelog

All notable changes to AgentForge are documented here.

## [Unreleased]

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
