# Contributing to AgentForge

Thanks for helping improve AgentForge. The repository is a pnpm/Turborepo monorepo; keep changes focused on the package that owns the behavior.

## Development setup

1. Install Node.js 20+ and pnpm 9+.
2. Run `pnpm install`.
3. Copy `.env.example` to `.env` only when testing a real provider. Mock providers cover CI and local examples.
4. Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` before opening a pull request.

## Design expectations

- Keep provider-specific code in its adapter package.
- Use strict TypeScript and Zod at runtime boundaries.
- Propagate cancellation and typed errors; do not swallow failures.
- Add deterministic tests for new runtime behavior.
- Treat shell, filesystem, and network access as security-sensitive capabilities.
- Avoid expanding the public API without documentation and a migration note.

## Pull requests

Describe the problem, the behavioral change, and how it was tested. Include screenshots for playground changes and call out experimental APIs. Keep generated lockfile changes limited to dependency updates.

By contributing, you agree that your work is provided under the repository's Apache License 2.0.
