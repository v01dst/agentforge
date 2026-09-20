# Agent Observability Checklist

Agent behavior is easier to debug when every run exposes a small, stable set of measurements.

## Run-level signals

Record, where available:

- run and session identifiers;
- selected provider/model;
- elapsed time and cancellation state;
- input/output token counts;
- tool-call count and per-tool latency;
- retry count and terminal status;
- security findings emitted by observe-only scanners.

## Tool-level signals

For each tool invocation, useful fields include:

- tool name;
- start/end timestamps;
- success or failure;
- structured error category;
- redacted argument metadata;
- output size.

Do not persist secrets or raw credentials merely to improve observability. Redaction should happen before events leave the process.

## Debugging workflow

When a run behaves unexpectedly:

1. Identify the session and run.
2. Inspect the ordered event stream.
3. Find the first failed or unexpectedly slow tool call.
4. Compare the model/tool configuration with a known-good run.
5. Reproduce the smallest deterministic fixture possible.

Observability should help explain what happened without becoming another source of sensitive data.
