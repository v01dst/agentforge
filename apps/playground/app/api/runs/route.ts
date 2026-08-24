import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { Agent, EventBus } from '@agentforge-oss/core';
import { MemoryEventStore, EventStoreSink, estimateCost } from '@agentforge-oss/observability';
import { InMemoryRunStore, JsonlRunStore, RunRecord, RunStore, RunStoreEventSink } from '@agentforge-oss/storage';
import { createMockWebSearchTool } from '@agentforge-oss/tools';
import { WorkflowBuilder, agentNode, inputNode, outputNode, toolNode, transformNode } from '@agentforge-oss/workflows';
import { resolveRequestedModel, type ModelSelectionRequest } from '../../../lib/providers';

type RunRequest = ModelSelectionRequest & {
  workflow?: string;
  input?: Record<string, unknown>;
};

/** File-backed run history shared by every playground session. */
let store: RunStore | undefined;
function getStore(): RunStore {
  if (!store) {
    if (process.env.AGENTFORGE_IN_MEMORY_RUNS === '1') {
      store = new InMemoryRunStore();
    } else {
      store = new JsonlRunStore(process.env.AGENTFORGE_PLAYGROUND_RUNS_PATH ?? join(process.cwd(), '.agentforge', 'playground-runs.jsonl'));
    }
  }
  return store;
}

async function persist(run: RunRecord): Promise<void> {
  try {
    await getStore().createRun(run);
  } catch (caught) {
    console.error('playground: failed to persist run', caught);
  }
}

export async function POST(request: Request) {
  let body: RunRequest = {};
  try {
    body = (await request.json()) as RunRequest;
  } catch {
    // An empty body is valid and uses the mock provider.
  }

  const requested = resolveRequestedModel(body);
  if ('error' in requested) {
    return NextResponse.json({ error: requested.error }, { status: 400 });
  }

  const topic = typeof body.input?.topic === 'string' ? body.input.topic : 'AI agent orchestration';
  const events = new EventBus();
  const eventStore = new MemoryEventStore();
  events.addSink(new EventStoreSink(eventStore));
  events.addSink(new RunStoreEventSink(getStore()));
  const search = createMockWebSearchTool({
    [topic]: [
      { title: 'Typed agent loops', url: 'https://agentforge.dev/typed-loops', snippet: 'Validation and limits make tool loops predictable.' },
      { title: 'Observable execution', url: 'https://agentforge.dev/telemetry', snippet: 'Events connect models, tools, and workflow nodes.' },
    ],
  });
  const summarizer = new Agent({
    name: 'summarizer',
    events,
    model: requested.model,
    instructions: 'Write one concise, factual research brief.',
  });
  const workflowName = body.workflow ?? 'Content research';
  const workflow = new WorkflowBuilder(workflowName)
    .add(inputNode('input', () => ({ query: topic, limit: 5 })))
    .add(toolNode({ id: 'search', tool: search }))
    .add(transformNode('research-notes', (value: { results: Array<{ title: string; snippet: string }> }) => value.results.map((item) => `${item.title}: ${item.snippet}`).join('\n')))
    .add(agentNode({ id: 'summarizer', agent: summarizer }))
    .add(outputNode('output'))
    .connect('input', 'search')
    .connect('search', 'research-notes')
    .connect('research-notes', 'summarizer')
    .connect('summarizer', 'output')
    .build();
  const startedAt = new Date().toISOString();
  try {
    const result = await workflow.run(topic);
    const completedAt = new Date().toISOString();
    const modelCompleted = eventStore.list().filter((event) => event.type === 'model.completed');
    const usage = modelCompleted.reduce((total, event) => {
      const item = event.data.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
      return { inputTokens: total.inputTokens + (item?.inputTokens ?? 0), outputTokens: total.outputTokens + (item?.outputTokens ?? 0), totalTokens: total.totalTokens + (item?.totalTokens ?? 0) };
    }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    await persist({
      id: result.runId,
      workflowId: workflowName,
      status: 'completed',
      input: topic,
      output: result.output,
      startedAt,
      completedAt,
      metadata: { provider: body.provider ?? 'mock', model: body.model ?? 'default', durationMs: result.durationMs },
    });
    return NextResponse.json({
      runId: result.runId,
      workflow: workflowName,
      status: 'completed',
      startedAt,
      completedAt,
      durationMs: result.durationMs,
      usage: { ...usage, estimatedCostUsd: estimateCost(usage, { inputPerMillion: 0.15, outputPerMillion: 0.6 }) },
      output: result.output,
      steps: result.steps.map((step) => ({ node: step.nodeId, label: step.nodeId, status: 'completed', durationMs: 0, output: step.output })),
      events: eventStore.list(),
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await persist({
      id: `run_failed_${Date.now().toString(36)}`,
      workflowId: workflowName,
      status: 'failed',
      input: topic,
      error: message,
      startedAt,
      completedAt: new Date().toISOString(),
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function GET() {
  try {
    const runs = await getStore().listRuns({ limit: 50 });
    return NextResponse.json({ runs });
  } catch (caught) {
    return NextResponse.json({ error: caught instanceof Error ? caught.message : String(caught) }, { status: 500 });
  }
}
