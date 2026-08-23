import { Agent } from '@agentforge/core';
import { MockModel } from '@agentforge/models';
import { WorkflowBuilder, agentNode, inputNode, outputNode } from '@agentforge/workflows';

const researcher = new Agent({ name: 'researcher', model: new MockModel({ responses: ['Typed tools reduce invalid calls.'] }) });
const editor = new Agent({ name: 'editor', model: new MockModel({ responses: ['Summary: typed tools make agent execution more reliable.'] }) });

export const workflow = new WorkflowBuilder('multi-agent')
  .add(inputNode('input'))
  .add(agentNode({ id: 'research', agent: researcher }))
  .add(agentNode({ id: 'edit', agent: editor }))
  .add(outputNode('output'))
  .connect('input', 'research').connect('research', 'edit').connect('edit', 'output').build();

export const run = (input = 'Explain typed tools') => workflow.run(input);
if (import.meta.url === `file://${process.argv[1]}`) console.log((await run()).output);
