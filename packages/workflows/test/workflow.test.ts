import { describe, expect, it } from 'vitest';
import { CancellationError } from '@agentforge/core';
import { WorkflowBuilder, conditionNode, customNode, inputNode, outputNode, parallelNode, transformNode } from '../src/index.js';

describe('Workflow', () => {
  it('executes transforms and branches', async () => {
    const workflow = new WorkflowBuilder('branch')
      .add(inputNode('input'))
      .add(transformNode('normalize', (value: unknown) => String(value).trim()))
      .add(conditionNode('check', (value) => value === 'yes'))
      .add(transformNode('approved', () => 'approved'))
      .add(transformNode('rejected', () => 'rejected'))
      .add(outputNode('output'))
      .connect('input', 'normalize')
      .connect('normalize', 'check')
      .connect('check', 'approved', { label: 'true' })
      .connect('check', 'rejected', { label: 'false' })
      .connect('approved', 'output')
      .connect('rejected', 'output')
      .build();
    expect((await workflow.run('yes')).output).toBe('approved');
    expect((await workflow.run('no')).output).toBe('rejected');
  });

  it('runs parallel branches and records each step', async () => {
    const workflow = new WorkflowBuilder('parallel')
      .add(inputNode('input'))
      .add(parallelNode('fanout', [async (state) => `${state.value}-a`, async (state) => `${state.value}-b`]))
      .add(outputNode('output'))
      .connect('input', 'fanout').connect('fanout', 'output').build();
    const result = await workflow.run('x');
    expect(result.output).toEqual(['x-a', 'x-b']);
    expect(result.steps).toHaveLength(3);
  });

  it('retries failed nodes and honors cancellation', async () => {
    let attempts = 0;
    const workflow = new WorkflowBuilder('retry')
      .add(customNode('unstable', () => { attempts += 1; if (attempts === 1) throw new Error('temporary'); return 'ok'; }, 1))
      .build();
    expect((await workflow.run(null)).output).toBe('ok');
    expect(attempts).toBe(2);

    const controller = new AbortController(); controller.abort();
    await expect(workflow.run(null, { signal: controller.signal })).rejects.toBeInstanceOf(CancellationError);
  });
});
