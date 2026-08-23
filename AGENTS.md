# AgentForge — Contributor Notes

## Commands

```bash
pnpm install          # install workspace deps (pnpm 9.x, Node >= 20.11)
pnpm build            # turbo run build (all packages)
pnpm typecheck        # turbo run typecheck
pnpm lint             # turbo run lint
pnpm test             # turbo run test
```

Package-scoped iteration is much faster than full-turbo runs:

```bash
pnpm --filter @agentforge/cli run build && pnpm --filter @agentforge/cli test
```

CLI tests use `node:test` via tsx: `cd packages/cli && npx tsx --test test/*.test.ts`.

## Constrained environments (PRoot / low-resource containers)

- The turbo daemon can hang piped output in PRoot-style environments. If a turbo
  command produces no output, run it detached and poll a log file, or add the
  global flag **after** the subcommand: `turbo run build --no-daemon`.
- Disable telemetry: `TURBO_TELEMETRY_DISABLED=1`.
- Long-running commands (Next.js builds, forced test runs) may exceed default
  shell timeouts; redirect to a log file and poll instead of piping.
- Next.js playground builds need generous time (`apps/playground`).

## Conventions

- Strict TypeScript; validate runtime boundaries with Zod; typed errors.
- Provider-specific code stays in `packages/models`; core stays provider-neutral.
- CLI output goes through `src/output.ts` helpers; respect `NO_COLOR`.
- Tests must be deterministic (mock models, no network).
- Update `PROJECT_STATUS_AND_ROADMAP.md` status sections honestly as work lands.
