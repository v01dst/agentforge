# Security Policy

## Supported versions

Security fixes target the latest `0.1.x` release. Because AgentForge is pre-1.0, upgrade promptly when a patched release is published.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's private security advisory flow or contact the maintainers privately with reproduction steps, affected package/version, and impact. Allow reasonable time for triage and a coordinated fix.

## Secure defaults

- Never commit provider API keys or put them in workflow definitions.
- Redact secrets before logging model requests, tool inputs, and errors.
- Shell and filesystem tools are disabled unless explicitly registered.
- Restrict HTTP tools to approved hosts and reject private/link-local destinations.
- Set timeouts, iteration limits, and cancellation handlers for every untrusted run.
- Treat model output as untrusted data; validate structured output before use.

See the tool package documentation for capability-specific configuration.
