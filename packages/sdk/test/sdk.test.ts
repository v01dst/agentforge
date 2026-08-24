import { describe, expect, it } from 'vitest';
import { Agent, MockModel, WorkflowBuilder, calculatorTool } from '../src/index.js';

describe('@agentforge-oss/sdk', () => {
  it('exposes the primary runtime facade', () => {
    expect(Agent).toBeTypeOf('function');
    expect(MockModel).toBeTypeOf('function');
    expect(WorkflowBuilder).toBeTypeOf('function');
    expect(calculatorTool.name).toBe('calculator');
  });
});
