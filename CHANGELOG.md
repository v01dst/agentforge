# Changelog

All notable changes to AgentForge are documented here.

## [Unreleased]

### 1.0.2 — live models everywhere

- **`/models` detail fetches live**: selecting a provider row on the Models tab queries the provider's endpoint (`/models`) and lists its current model ids — preset catalog first, managed endpoint fallback, honest error when neither lists. No static lists anywhere in the TUI.
- **Esc during model-fetch loading** cancels cleanly instead of being swallowed (regression from 1.0.1's queued-confirm).
- Tests: 285/285 (live-fetch suite with a stubbed endpoint added).

## [1.0.1] — 2026-09-02

### 1.0.1 — polish pass on user feedback

- **Giza skyline in the header**: carved pyramid silhouettes (`▲ ▲▲▲`) above the cartouche.
- **Default palette → `pharaoh-indigo`**: night-sky indigo ground, warmer gold `#E8C547`, cool stone-gray metadata. `pharaoh` (obsidian) remains on `/skin`.
- **EzStart keyboard fixes**: Esc now works on every step (welcome → skip, model step → back to the picker, failed → welcome); while EzStart is open it exclusively owns the keyboard, so no keystrokes leak into the chat composer behind it.
- **Usable after skip**: skipping or finishing setup always lands you in a working composer — browsing `/help`, `/tools`, `/agents` works with no model connected.
- Tests: 285/285 (Esc-behavior and default-palette suites added).

## [1.0.0] — 2026-09-02

The stable release. **First-run now actually enters the new experience** — 0.9.0 shipped the
Pharaoh TUI and the 16-provider catalog but never routed fresh installs into them.

### Fixed: onboarding wiring (the "3 providers" bug)
- `interactive.ts` now detects an unconfigured model (no env key, no credentials entry, no
  managed endpoint) and passes `needsOnboarding` through TuiRoot to ChatHome — first launch
  opens **EzStart**: the full provider catalog with type-to-filter, masked key entry, and
  live model listing from the endpoint. `/connect` is the same EzStart flow (the legacy
  3-provider wizard is gone).
- `/models` rebuilt: Models / Endpoints / **Add provider** tabs — the last opens the
  16-preset catalog (OpenRouter, DeepSeek, Groq, xAI, Mistral, Together, Fireworks,
  Cerebras, Moonshot/Kimi, Z.AI/GLM, Perplexity, Ollama, LM Studio + OpenAI/Anthropic/
  Google), saves keys to `~/.agentforge/credentials.json` (0600), and fetches the live
  model list after saving.

### Fixed: monument layout
- Dropped Ink `Static` — the Cartouche now stays pinned at the top of the frame instead of
  scrolling above the transcript; the Scribe's Tablet anchors the bottom.
- Completed tools render once, in the transcript (`│ ✓ 𓋴 carved read_file 12ms`); only
  in-flight tools appear in the live chisel line (`𓂀 carving: …`).
- Temple rule clamps to terminal width; tool events without an explicit state normalize
  to `done` when `ms` is present.

### Verified
- Rendered-frame layout test (cartouche above transcript above tablet, glyphs present).
- CLI suite 283/283; clean-room `npm install` verified post-publish.

## [Unreleased]

### License: Apache-2.0 — free for commercial use (published as 0.9.0)

- AgentForge is relicensed back to **Apache-2.0**: free to use, modify, and distribute for **any purpose, including commercial**. The PolyForm Noncommercial + paid-commercial-licensing arrangement is withdrawn.
- All 12 `package.json` `license` fields return to `Apache-2.0`; the README badge, License section, banner chip, and CONTRIBUTING terms updated to match.

### The Pharaoh's Monument TUI (1.0-line reset to 0.1.0)

### The Pharaoh's Monument TUI (1.0-line reset to 0.1.0)

- **Ground-up TUI redesign** with a distinct identity — Ancient-Egyptian craftsmanship, monumental and calm:
  - **The Cartouche** (header): `𓂀  AGENTFORGE  𓋴` in Pharaoh's Gold over a `═══` temple-base rule, with `𓋹 ONLINE` (turquoise) or the scribe's `OFFLINE` indicator.
  - **The Hall of Records** (messages): user scrolls lean right under a gold `▸`; agent words stand between turquoise pillars (`│ … │`); system notes are chiselled in stone gray.
  - **The Sculptor's Chisel** (live activity): `𓂀 carving: read_file…` in desert sand turns into `✓ 𓋴 carved read_file 12ms` in turquoise; the spinner is a golden ankh.
  - **The Offering** (input): `𓋴 FORGE > ` in gold with a turquoise cursor.
  - **The Scribe's Tablet** (status bar): `𓁈 provider │ 𓃀 model │ 𓋴 mode │ 𓂋 posture │ 𓆣 tokens`, one dark anchored band.
  - **Monument splash** replaces the block-letter wordmark: the name sealed in a gold cartouche.
- **Design tokens**: `theme.ts` gains a glyph token set (`𓂀 𓋴 𓋹 𓁈 𓃀 𓂋 𓆣` + marks) with `AGENTFORGE_GLYPHS=ascii|unicode` control and automatic ASCII fallback; two new skins — `pharaoh` (obsidian `#0A0A0A`, now the default) and `pharaoh-indigo` (night-sky `#0B1A2A`) — using Pharaoh's Gold `#D4A017/#C99A2A`, Lapis/Turquoise `#1E3A5F/#48C9B0`, Desert Sand `#E67E22`, Papyrus `#FDF5E6`, Stone Gray `#8E8E8E`. All previous skins remain on `/skin`.
- **Current model ids everywhere**: a single `DEFAULT_MODEL_IDS` map in `@agentforge-oss/models` (verified against provider docs 2026-09: `gpt-5.6-sol`, `claude-opus-5`, `gemini-2.0-flash`) backs every adapter default, auto-detection, subagent fallback, and the builtin provider report — all stale `gpt-4o*`/`claude-3-5*`/`gemini-1.5` ids removed. `/model` accepts any id (the live list comes from the endpoint via the EzStart picker and `/models` manager) and notes when an id is not in the provider's current list.
- **Reliability**: `dispatchSlash` now awaits async command handlers (no more fire-and-forget races); session-mode and permission-posture state flows through the Scribe's Tablet live.
- **Version reset**: the 1.0 line starts at `0.1.0` in-repo (all packages, `VERSION`, README, banner). Not published to npm — registry numbers 0.1.0–0.8.0 were consumed by earlier development releases and are immutable.
- Tests: new `pharaoh-theme.test.ts` (palette tokens, glyph fallbacks, tablet); all TUI visual assertions migrated; ambient-env test hygiene (leaked `AGENTFORGE_PROVIDER/MODEL` contained); CLI suite 282 green, twice consecutively.

## [0.8.0] — 2026-09-01

### TUI redesign, ez-start, providers everywhere (0.8.0)

- **TUI redesign** — the chat interface is rebuilt: messages render as blocks with role chips (`YOU` / `AGENT`) and wrapped text, tool activity is a vertical timeline (`├ ✓ read_file 12ms`), a sticky header shows live status chips (`◆ AgentForge [provider/model] [mode] [posture] [12.4k tok]`), errors are inline tinted lines, and a compact footer carries key hints. All colors flow through the existing skin system with ASCII fallback.
- **EZ start** — first-run onboarding inside the TUI: pick a preset provider (type-to-filter), paste your API key (masked, stored in `~/.agentforge/credentials.json` with 0600 permissions — never inside a project), pick a model **fetched live from the provider's endpoint**, or define a custom provider (base URL + key + model id). Connectivity is probed honestly; failures offer retry.
- **Provider catalog** — 16 built-in presets with model defaults verified against provider docs (2026-09): OpenAI (GPT-5.6 Sol/Terra/Luna), Anthropic (Opus 5 · Fable 5 · Sonnet 5), Google Gemini, OpenRouter, DeepSeek (V4 Flash/Pro), Groq, xAI (Grok 4.6), Mistral (Medium 3.5), Together, Fireworks, Cerebras, Moonshot (Kimi K3), Z.AI (GLM-5.3), Perplexity, plus local Ollama and LM Studio.
- **Live model discovery** — `listProviderModels()` in `@agentforge-oss/models` fetches model ids straight from provider endpoints (`GET /models`, protocol-aware for OpenAI-compatible/Anthropic/Google), so the TUI model picker is always current; preset defaults are the fallback when a provider does not implement listing.
- **Credentials doctrine change** — API keys entered in the CLI are stored locally in `~/.agentforge/credentials.json` (0600, home directory only); resolution order is environment → credentials file. Previously keys were env-only.
- **Fuzzy slash search** — the slash menu now matches anywhere in command names and descriptions (ranked by the same matcher as the Ctrl-K palette): `pvdr` finds `/providers`.
- **Everything in the TUI** — new slash passthroughs share the CLI implementations via the existing suspended-run mechanism: `/providers add|remove|test`, `/permissions allow|deny|remove`, `/skills pending|approve|reject|diff`, `/mcp`, `/findings`, `/benchmarks`, `/gateway`, `/daemon`, `/sessions-admin export|prune|delete`, `/profile save`. `/help` is now a categorized cheat-sheet generated from the live registry.
- **Mock model deleted** — `MockModel`, the `'mock'` provider, and every fallback are removed from `@agentforge-oss/models`, the CLI, the scaffold, and onboarding. Without a configured provider the TUI shows ez-start (and headless paths state it plainly) — the agent never fakes intelligence. Tests use injected fakes (`modelInstance`) or thin scripted providers defined in the test itself.

## [0.7.1] — 2026-09-01

### License change: noncommercial + paid commercial option

- AgentForge is relicensed from Apache-2.0 to **PolyForm Noncommercial 1.0.0** across all packages: free use, study, modification, and redistribution for noncommercial purposes (personal, research, education, charitable organizations).
- **Commercial use now requires a paid license** — company products, internal business tooling, consulting, or any revenue-generating activity is outside the free grant. Commercial terms are available from the licensor (see README "License" and the commercial-licensing preamble in `LICENSE`).
- All 12 `package.json` `license` fields updated to `PolyForm-Noncommercial-1.0.0`; CONTRIBUTING.md contribution terms updated to match.

## [0.7.0] — 2026-08-31

Feature wave four (multi-project adoption plan, phases L, M) — completes the six-project adoption plan.

### Device tools (Phase M — multi-project plan)

- Desktop-integration tools (`packages/cli/src/devices/devices.ts`): `device_notify` (OS notification center), `device_open_url` (default browser, http/https only), `device_clipboard_write`/`device_clipboard_read`, and `device_screenshot` (captures into workspace-scoped, name-sanitized `.agentforge/screenshots/` — local-first, images never leave the machine).
- Platform-aware command builders for darwin/linux/win32; unsupported platforms and missing utilities fail with honest errors, never fake success. All five tools carry `process:execute`, so the existing policy layer (ask prompts, trusted auto-allow, deny rules) covers them unchanged — one policy layer.
- Registered in every coding session alongside the other coding tools.
- Tests: 9 suites (per-platform command shapes, platform honesty, URL scheme guard, permission wiring, path sanitization); CLI suite 260 green.

### Channel adapters: webhook + Telegram (Phase L — multi-project plan)

- Generic webhook channel (`agentforge channels webhook [--port 8788] [--secret <s>]`): `POST /hook` with `{ sender, text }` runs the prompt through the session runner and returns `{ reply }`. Shared-secret verification supports a plain header (`X-AgentForge-Secret`) and HMAC-SHA256 body signatures (`X-Signature: sha256=…`, timing-safe compare); missing secret means dev-mode (warned in startup output).
- Telegram channel (`agentforge channels telegram [--token|--env TELEGRAM_BOT_TOKEN] [--allow-chat <ids>]`): Bot API long-polling — no inbound ports. Offset-tracked `getUpdates` loop, `sendMessage` replies, optional chat-id allowlist, and error-resilient polling (failures surface via a callback and retry; the loop exits on abort).
- Both adapters are thin transports over the same runner seam — policy, sessions, and logging stay in the runner.
- Tests: 5 suites (webhook round-trips, both secret paths, telegram dispatch/allowlist/error-resilience against a mocked Bot API).


Feature wave four (multi-project adoption plan, phases L, M) — completes the six-project adoption plan.

## [0.6.0] — 2026-08-31

Feature wave three (multi-project adoption plan, phases J, K, S).

### Benchmarking, deterministic-only (Phase S — multi-project plan)

- Benchmark harness (`packages/cli/src/benchmarks/benchmarks.ts`): cases pair a task prompt with a **deterministic checker** (files on disk, exact content) — doctrine: no model judges output, ever. Each run executes in a fresh sandbox cwd (the session cwd is restored afterwards).
- Built-in cases: `file-creation` (exact-content file), `file-edit` (targeted replace with collateral check), `restraint` (untouched files must survive). Results append to `.agentforge/benchmarks/results.ndjson` (append-only; latest-per-case scoring).
- CLI: `agentforge benchmarks list|run <id> [--all]|results [--json]`.
- Tests: 4 suites (scripted compliant runner passes all cases; do-nothing runner fails actionable cases and passes restraint; append-only persistence + scoring); CLI suite 246 green.

### Daemon + heartbeat (Phase K — multi-project plan)

- Foreground daemon loop (`agentforge daemon run [--interval-ms 30000]`): writes `.agentforge/daemon/heartbeat.json` every interval (pid, startedAt, lastBeat, beats, job counters), drains JSON job files dropped into `.agentforge/daemon/jobs/` (`{ id, type: "prompt", text }`) through the standard agent runner, writes `<id>.result.json` into `daemon/out/`, and exits gracefully when `daemon/stop` appears. Malformed jobs fail loudly into result files without killing the loop.
- Supervised install without surprise auto-starts: `agentforge daemon install` writes a launchd plist (macOS, `KeepAlive`) or a systemd user unit (Linux, `Restart=on-failure`) and prints the load/enable command — supervision is provided by the OS, not by daemonizing ourselves.
- `agentforge daemon status` reports alive/stale from the heartbeat freshness window; `daemon stop` writes the stop file.
- Tests: 6 suites (bounded loops, job drain, failure accounting, freshness, install templates); CLI suite 242 green.

### Gateway: OpenAI-compatible agent-as-model (Phase J — multi-project plan)

- `agentforge gateway serve [--port 8787] [--host 127.0.0.1] [--provider] [--model]`: a local HTTP server exposing `POST /v1/chat/completions` (OpenAI wire format, clean-room on `node:http`) and `GET /healthz`. Any OpenAI-protocol client can now talk to an AgentForge-backed model.
- Non-streaming completions return `chat.completion` payloads with usage; streaming requests return `text/event-stream` deltas ending with a `finish_reason` chunk and `data: [DONE]`. Request validation via zod; oversized bodies rejected; honest 400/404/500 error envelopes.
- The gateway is a seam, not a runtime dependency: `createGatewayServer({ modelInstance })` accepts any injected provider (deterministic in tests — no network). Built instructions are prepended per conversation.
- Tests: 4 suites exercising real HTTP round-trips (healthz, completions, SSE streaming, error shapes).

## [0.5.0] — 2026-08-31

Feature wave two (multi-project adoption plan, phases H, I, P, Q, R, T).

### Session modes (Phase T — multi-project plan)

- New mode layer above permission postures (`packages/cli/src/modes/session-modes.ts`): `chat` (explain-first, ask posture), `build` (default coding mode), `indie` (fast-shipping: workspace-write default, small diffs, run tests, no gold-plating), `automode` (heuristic autonomy; the optional cheap-model router is declared but **off by default**). Modes are advisory state: entering a mode applies its default posture and contributes an instruction fragment to session instructions — they never bypass the policy layer.
- Slash surface: `/mode [chat|build|indie|automode]` is the **session-mode** switch; `/permissions [read-only|ask|workspace-write|trusted]` (alias `/posture`) is the **posture** switch. Plain-chat `mode`/`permissions` commands match. `/plan` and `/build` remain quick posture switches.
- **Live-posture fix (regression):** `applyWorkspacePolicy` now resolves the posture per tool call (`getMode`) instead of capturing it at runner build — `/plan`, `/build`, `/permissions`, and mode switches take effect immediately on already-built tools, in the TUI and mid-run. Regression-tested (ask → read-only → workspace-write on one wrapped tool).
- Tests: 4 new suites; CLI suite 232 green.

### Security findings, observe-only (Phase R — multi-project plan)

- Deterministic findings scanner over tool activity (`packages/cli/src/findings/scanner.ts`), wired as `preTool`/`postTool` interceptors in every coding session. Doctrine-compliant: **findings are recorded, never enforced** — `preTool` always returns void, even for secrets.
- Detectors: secret-shaped tool inputs (AWS keys, private keys, GitHub/Google/Slack tokens — masked in recorded detail), risky shell patterns (`curl|sh`, `rm -rf /`, `chmod 777 /`), credential-file access attempts (`.env` variants, key files, `.ssh/` — `.env.example` exempt, matching the Phase 5 read_file policy), and boundary refusals observed in tool failures.
- Findings persist to `.agentforge/observability/findings.ndjson` (corrupt-line tolerant); CLI: `agentforge findings list [--json|--limit N]` and `findings clear --older-than-days <n>`.
- Tests: 9 suites; CLI suite 228 green.

### Observability core (Phase Q — multi-project plan)

- Local-first structured event log: every coding session writes run events (`agent.started/completed/failed`, `model.requested/completed`, `tool.started/completed/failed`, workflow events) as NDJSON under `.agentforge/observability/runs/<runId>.ndjson`, with a compacted per-run index at `index.ndjson` (status + type counts + timestamps). Doctrine-compliant: pure observation — nothing gates, nothing leaves the machine; disable with `observability: false`.
- CLI: `agentforge runs list [--all|--json]`, `runs show <runId> [--verbose|--json]` (status, counts, duration, last tool failure), `runs prune --older-than-days <n>`.
- Corrupt lines and torn writes are skipped on read; retention prunes stale run logs only. Tests: 6 suites; CLI suite 219 green.

### Profiles (Phase P — multi-project plan)

- Named profile bundles: `~/.agentforge/profiles.json` (global) and `.agentforge/profiles.json` (project, shadows global by name). A profile pins `provider`, `model`, and optionally a `permissionMode` posture — e.g. `fast` (haiku + read-only) vs `deep` (sonnet + workspace-write).
- CLI: `agentforge profile list|save <name> --provider --model --mode [--scope project|global]|use <name>|current|remove <name>` (`--json` on list). `profile use` sets `AGENTFORGE_PROVIDER`/`AGENTFORGE_MODEL` for the session, applies the posture through the permission layer, and records the active flag; explicit environment variables always win over profile values.
- TUI: `/profile [name]` lists and activates profiles inline.
- Validation fails loudly (names, postures); tests cover store merging, shadowing, active flags, and environment precedence. CLI suite 213 green.

### LSP bridge (Phase I — multi-project plan)

- Real JSON-RPC 2.0 LSP client over stdio with Content-Length framing (`packages/cli/src/lsp/lsp.ts`): lazy per-language server lifecycle, request timeouts that fail honestly instead of hanging, notification collection, crash propagation.
- TS-first defaults: `typescript-language-server --stdio` is assumed for JS/TS when no configuration exists; custom servers are declared in `.agentforge/lsp.json` (`{ servers: [{ id, command, args, extensions }] }`, validated at load).
- New tools (observe-only, registered in every coding session): `lsp_diagnostics { path }` — didOpen + bounded settle, merges push (`textDocument/publishDiagnostics`) and pull (`textDocument/diagnostic`) results, deduped and formatted as `file:line:col severity: message`; `lsp_hover { path, line, character }` — zero-based hover for types/signatures. Path escapes are refused; unknown extensions report honestly.
- `LspManager` shares one client per server id across tool calls and disposes servers (shutdown/exit) on process exit; child processes are unref'd so idle servers never block host exit.
- Tests: 6 new suites driven by a real mock language server speaking framed JSON-RPC over stdio (deterministic, no network); CLI suite 207 green.

### Session log-as-truth + forking (Phase H — multi-project plan)

- Durable NDJSON session logs (`.agentforge/sessions/<id>.ndjson`): every conversation turn appends one JSON line (`ts`, `type`, `text`, optional `meta`) forever. The JSON snapshot stays the fast, compacted view for loads and listing; the log is the truth — compaction never rewrites it and forks replay from it. Corrupt trailing lines are skipped on read, never discarded on write.
- Session forking: `forkSession(id, { title, upTo, global })` replays the parent's full uncompacted log into a fresh session (`<newid>-f`), records `forkedFrom` lineage, and writes both snapshot and replayed log. `upTo` cuts at a prefix (negative counts from the end); legacy sessions without a log fork from the snapshot with the compaction summary riding along as a system message. A fork's history is never truncated by the parent's compaction.
- New surfaces: `agentforge sessions fork <id> [--up-to N] [--title t] [--global] [--json]`, `agentforge sessions transcript <id> [--json]` (full uncompacted transcript), TUI `/fork [id]` and `/transcript [id]` slash commands. Chat autosave appends each new turn to the log; resumed history is not double-logged.
- Tests: 8 new log/fork suites; TUI autosave test updated to assert the durable log beside the snapshot; CLI suite 201 green.

## [0.4.0] — 2026-08-31

Feature wave one (multi-project adoption plan, phases A, N, B, C, D, F, G — re-expressed
through AgentForge's own contracts; versions 0.1.0–0.3.1 remain occupied on npm by the
earlier release lineage).

### Permissions v2: structured rules + doom-loop guard (Phase G — multi-project plan)

- Rules become structured matchers (`.agentforge/permissions.json`): plain tool names, the `*` wildcard, globs (`mcp.*`), and dotted hierarchy prefixes (`mcp.server` covers `mcp.server.tool`). Specificity tiers — prefix > exact > hierarchy > glob > `*` — with deny beating allow at equal specificity; a later, more specific rule can carve exceptions out of a broad deny.
- Command-prefix rules: `run_command:prefix=git status` (or `agentforge permissions allow run_command --prefix "git status"`). A prefix allow overrides a general `run_command` deny for matching command lines; a prefix deny beats a broad allow. Prefix-allowed commands skip the approval prompt; everything else keeps the mode flow.
- `external_directory:<path>` grants extend the readable boundary for path-bearing tools without weakening the workspace check elsewhere: relative paths still resolve against the workspace root, `..` escapes are still refused, and ungranted external paths still throw.
- Unknown qualifiers are rejected at load (`read_file:bogus` fails closed with the standard malformed-file warning).
- Doom-loop guard: a `preTool` interceptor wired into every coding session denies the third consecutive identical tool call (same tool + same arguments) with guidance to change approach instead of burning context.
- Tests: +7 rule-evaluation/policy/guard suites; full CLI suite 193 green.

### Agents & subagents (Phase F — multi-project plan)

- Markdown agent definitions: `.agentforge/agents/<name>.md` (flat) or `.agentforge/agents/<name>/AGENT.md` (folder), with a global fallback at `~/.agentforge/agents/`. Project files shadow global ones, which shadow the built-ins, all matched by name. Frontmatter: `mode: primary|subagent` (default `subagent`), `description`, `model`, `temperature`, `steps` (child max iterations), `permission: read-only|workspace-write|trusted`. The markdown body is the agent's prompt.
- Built-in subagents: `explore` (fast read-only codebase explorer) and `general` (general-purpose multi-step worker) — synthesized unless user files redefine them.
- New `task` tool: delegates a self-contained prompt to a named subagent and returns its final report (capped). The child agent runs with a posture-filtered toolset derived from the agent's `permission` — one policy layer: read-only subagents literally receive no write/command tools, and all child tools still pass through the same workspace policy. Subagents never receive `skill_manage` or memory-write duties.
- Subagent index injected into coding-session instructions so the primary model knows which agents exist; `agentforge agents list` data flows through the existing `/agents` screen (markdown agents shown with mode + posture; selecting one no longer hijacks the project entry).
- `@mention` routing hints: typing `@agent-name` in chat surfaces a delegation hint (registry scan only runs when the text contains `@`).
- Plan/build modes: `/plan` switches to the read-only posture for exploration and design; `/build` returns to workspace-write. Enforced by the same permission layer (`setPermissionMode`), so declines are real policy, not prompt-politeness.
- Tests: 9 new agent-registry/tool tests; reflection-test teardown hardened against the background-reviewer write race (retry cleanup).

### Loop upgrades: prompt caching, live compression, interrupt-and-redirect (Phase D — multi-project plan)

- Anthropic prompt caching: the stable system prompt prefix is sent with a `cache_control` ephemeral marker on both `generate` and streaming requests, cutting repeated input cost for long coding sessions.
- Live context compression: a deterministic `preRequest` interceptor (`packages/cli/src/context/compression.ts`) folds oversized message histories in place — keeps the first message and the most recent N (default 20) verbatim, replaces the middle with a bounded `[context folded]` summary of dropped turns. Defaults: 96,000-char trigger, configurable via `compression: { maxChars, keepMessages }` on the coding session. Deterministic only — no model calls, no nondeterministic summaries.
- TUI interrupt-and-redirect: submitting a new message while a turn is running cancels the in-flight turn and queues the text; once the runner settles the queued message is sent automatically — no more rejected submits mid-run.
- Tests: `packages/models/test/loop-upgrades.test.ts` covers the Anthropic caching wire format (generate + stream) and the compression fold behavior; full CLI suite (150) and core suite stay green.

### Reflection engine, observe-only (Phase C — multi-project plan)

- New reflection runtime (`packages/cli/src/reflection/review.ts`): observes each step via `preStep` and end-of-turn via `turnStopping` interceptors — **observe-only by doctrine: findings are recorded, never enforced**.
- Fire-and-forget background reviewer receives a bounded transcript digest (`buildDigest`) and may only call `memory` (add) and `skill_manage` (stage) — it can leave notes and draft skills but cannot touch the session, files, or tools.
- `reviewNow` runs the same review synchronously on demand. Config: `reflection: { enabled, provider, model }` in global config, **off by default**.
- **One-policy-layer fix in core:** `AgentConfig.allowedToolPermissions` is now optional — when undefined, core applies no permission gate of its own; the CLI policy wrapper remains the single enforcement point. Previously the default-empty core gate denied every permissioned tool in live sessions. Regression-tested both ways.

### Skills upgrade: folders, progressive disclosure, agent-authored skills (Phase B — multi-project plan)

- Skills module rewritten (`packages/cli/src/skills/skills.ts`): supports folder layout `skills/<name>/SKILL.md` alongside flat `skills/<name>.md`, with frontmatter (name, description, metadata) via the existing parser.
- Progressive disclosure: sessions inject only a compact skill index; full bodies and additional reference files load on demand through `readSkillReference` (path-escape guarded) and `listSkillReferences`.
- Agent-authored skills: new `skill_view` and `skill_manage` tools. `skill_manage` write mode stages proposals under `.agentforge/pending/skills/` instead of writing directly; a `writeApproval: "staged"` session option controls the flow.
- New `agentforge skills` command group: `list`, `pending`, `diff`, `approve`, `reject` — humans review and land (or reject) agent-drafted skills; staged writes never touch skills without approval.
- Skill index injected into coding-session instructions; 7 new tests; CLI suite green.

### Plugin kernel v2 + interceptor seam (Phase N — multi-project plan)

- New core seam (`packages/core/src/interceptors.ts`): serial pipeline around the agent loop with `preStep`, `preRequest`, `preTool` (returning a string denies the tool call with that message), `postTool`, and `turnStopping` hooks; helpers `foldWaterfall`, `firstDenial`, `foldSerial`. `AgentConfig.interceptors` wires them into the loop — the single landing pad for reflection, plugin hooks, doom-loop guards, findings scanning, and compression.
- Plugin contract v2 (`packages/cli/src/plugins/plugins.ts`, `PLUGIN_CONTRACT_VERSION = 2`): plugins contribute `hooks`, `skills`, `agents`, and `slashCommands`; plugin hooks are adapted into core interceptors and flow through `CodingSessionOptions`.
- Lifecycle: `agentforge plugins enable|disable <name>` persists to the extension store (`PluginEntry.disabled`); disabled plugins are filtered at load (`disabledPluginKeys`).
- Fixed a latent crash when plugin-contributed skills were rendered without `context.skills`.

### Persistent memory + workspace persona (Phase A — multi-project plan)

- New memory module (`packages/cli/src/memory/`): `MEMORY.md` (agent notes, 2,200-char cap) and `USER.md` (user profile, 1,375-char cap) under `.agentforge/memories/` with global fallback `~/.agentforge/memories/`. Entries are `§`-separated; exact duplicates are rejected; capacity overflow returns the current entries plus consolidation guidance instead of failing silently.
- New `memory` tool (`add | replace | remove` with unique-substring matching) — Zod-validated, `filesystem:write`-gated (denied in read-only), reported results always reflect live state. Writes read-modify-write within their own scope so a project write never absorbs global content.
- **Workspace persona:** `.agentforge/SOUL.md` (persona) and root `AGENTS.md` (project conventions) are read at session start and injected into agent instructions — frozen snapshot pattern, no mid-session prompt mutation.
- Memory snapshot injected the same way: the agent carries curated facts into new sessions; the `memory` tool result shows live state.
- New `/memory` slash command (TUI + plain chat) shows both stores with usage; CHAT_HELP updated.
- Scope decision: memory writes are approved at write time through the existing permission posture (denied in read-only); a staged pending/review flow arrives with Phase B skill staging.

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
