import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculatorTool, createMockWebSearchTool } from '../src/index.js';

describe('built-in tools', () => {
  it('evaluates arithmetic without using eval', async () => {
    const result = (await calculatorTool.execute({ expression: '(2 + 3) * 4' }, { runId: 'test', signal: new AbortController().signal })) as { value: number };
    assert.equal(result.value, 20);
  });

  it('returns deterministic web search fixtures', async () => {
    const tool = createMockWebSearchTool({ agentforge: [{ title: 'AgentForge', url: 'https://example.com', snippet: 'runtime' }] });
    const result = (await tool.execute({ query: 'agentforge', limit: 5 }, { runId: 'test', signal: new AbortController().signal })) as { results: unknown[] };
    assert.equal(result.results.length, 1);
  });
});
