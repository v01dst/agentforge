# Observability

AgentForge treats observability as a first-class runtime concern without making telemetry a requirement.

## Event model

Runtime components should emit structured events for lifecycle transitions, tool calls, model requests, failures, cancellations, and session boundaries.

Events should carry stable identifiers and timestamps so a session can be reconstructed without relying on terminal formatting.

## Local-first behavior

The core runtime must remain useful without a hosted telemetry service. Observability adapters may export events, but the runtime should not require an external collector.

## Sensitive data

Logs must avoid accidentally persisting credentials. Providers and tools should expose metadata separately from raw payloads where possible, allowing downstream reporters to redact or omit sensitive fields.

## Deterministic tests

Observability tests should use deterministic clocks, mock providers, and fixed event sequences. Tests should verify ordering and cancellation behavior as well as individual event shapes.
