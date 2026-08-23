import { NextResponse } from 'next/server';
import { Agent, EventBus } from '@agentforge/core';
import { MockModel } from '@agentforge/models';
import { MemoryEventStore, EventStoreSink, estimateCost } from '@agentforge/observability';
import { InMemoryRunStore } from '@agentforge/storage';
import { createMockWebSearchTool } from '@agentforge/tools';
import { WorkflowBuilder, agentNode, inputNode, outputNode, toolNode, transformNode } from '@agentforge/workflows';

type RunRequest = {
  workflow?: string;
  input?: Record<string, unknown>;
};

const store = new InMemoryRunStore();

export async function POST(request: Request) {
  let body: RunRequest = {};
  try {
    body = (await request.json()) as RunRequest;
  } catch {
    // An empty body is valid for the sample workflow.
  }

  const topic = typeof body.input?.topic === 'string' ? body.input.topic : 'AI agent orchestration';
  const events = new EventBus();
  const eventStore = new MemoryEventStore();
  events.addSink(new EventStoreSink(eventStore));
  const search = createMockWebSearchTool({
    [topic]: [
      { title: 'Typed agent loops', url: 'https://agentforge.dev/typed-loops', snippet: 'Validation and limits make tool loops predictable.' },
      { title: 'Observable execution', url: 'https://agentforge.dev/telemetry', snippet: 'Events connect models, tools, and workflow nodes.' },
    ],
  });
  const summarizer = new Agent({
    name: 'summarizer', events,
    model: new MockModel({ responses: [`A concise brief about ${topic}, grounded in the collected sources.`] }),
    instructions: 'Write one concise, factual research brief.',
  });
  const workflow = new WorkflowBuilder(body.workflow ?? 'Content research')
    .add(inputNode('input', () => ({ query: topic, limit: 5 })))
    .add(toolNode({ id: 'search', tool: search }))
    .add(transformNode('research-notes', (value: { results: Array<{ title: string; snippet: string }> }) => value.results.map((item) => `${item.title}: ${item.snippet}`).join('\n')))
    .add(agentNode({ id: 'summarizer', agent: summarizer }))
    .add(outputNode('output'))
    .connect('input', 'search').connect('search', 'research-notes').connect('research-notes', 'summarizer').connect('summarizer', 'output').build();
  const startedAt = new Date().toISOString();
  const result = await workflow.run(topic);
  const completedAt = new Date().toISOString();
  const modelCompleted = eventStore.list().filter((event) => event.type === 'model.completed');
  const usage = modelCompleted.reduce((total, event) => {
    const item = event.data.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    return { inputTokens: total.inputTokens + (item?.inputTokens ?? 0), outputTokens: total.outputTokens + (item?.outputTokens ?? 0), totalTokens: total.totalTokens + (item?.totalTokens ?? 0) };
  }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  await store.createRun({ id: result.runId, workflowId: body.workflow ?? 'Content research', status: 'completed', input: topic, output: result.output, startedAt, completedAt });
  return NextResponse.json({
    runId: result.runId,
    workflow: body.workflow ?? 'Content research',
    status: 'completed', startedAt, completedAt, durationMs: result.durationMs,
    usage: { ...usage, estimatedCostUsd: estimateCost(usage, { inputPerMillion: 0.15, outputPerMillion: 0.6 }) },
    output: result.output,
    steps: result.steps.map((step) => ({ node: step.nodeId, label: step.nodeId, status: 'completed', durationMs: 0, output: step.output })),
    events: eventStore.list(),
  });
}
