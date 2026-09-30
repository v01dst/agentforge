# Provider Adapter Guidelines

Provider adapters translate a normalized model request into provider-specific behavior.

## Responsibilities

An adapter should own model identifier normalization, request serialization, streaming event translation, provider-specific error mapping, and token usage extraction when available.

The core runtime should not depend on provider-specific response shapes.

## Errors

Map transient failures, authentication failures, invalid requests, rate limits, and context-limit errors into stable typed categories. Preserve useful provider diagnostics as metadata without making callers parse arbitrary strings.

## Testing

Every adapter should have deterministic tests for a normal completion, streaming chunks, tool-call responses when supported, malformed provider responses, cancellation, and rate-limit/authentication failures.

Tests should not require live API credentials.
