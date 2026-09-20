# Context Budgeting

Long-running agents need to treat context as a finite runtime resource rather than an unlimited prompt.

## Goals

- Keep tool schemas and historical output out of the active window when they are not needed.
- Prefer summaries and references over repeatedly copying large payloads.
- Make context growth observable so regressions can be measured.
- Preserve enough information to reproduce or audit an important run.

## Suggested budget model

A session can be viewed as four competing buckets:

| Bucket | Examples |
| --- | --- |
| Instructions | system rules, skills, workspace policy |
| Conversation | user requests and model responses |
| Tool surface | tool names, descriptions, schemas |
| Evidence | files, command output, retrieved documents |

A practical runtime should reserve headroom instead of filling the model context completely. When the evidence bucket grows, the runtime can progressively compact older conversation turns or load tool details on demand.

## Progressive disclosure

Tool discovery and tool execution do not always need the same amount of schema detail. A useful pattern is:

1. Discover a compact list of available tools.
2. Load the full schema only for tools selected for the current task.
3. Cache schemas for the lifetime of a session when safe.
4. Remove stale tool descriptions from the active prompt when they are no longer relevant.

This reduces prompt pressure without changing the underlying tool API.

## Measuring regressions

Context optimizations should be evaluated with deterministic fixtures. At minimum, record:

- input tokens before and after compaction;
- tool-schema tokens before and after discovery;
- number of tool calls;
- latency added by compaction/discovery;
- task success and test results.

The goal is not simply the smallest prompt. The useful metric is **less context overhead for the same task outcome**.
