import { createMockWebSearchTool } from '@agentforge/tools';
import { WorkflowBuilder, inputNode, outputNode, toolNode, transformNode } from '@agentforge/workflows';

const search = createMockWebSearchTool({
  'agent runtimes': [
    { title: 'Typed runtimes', url: 'https://example.com/runtimes', snippet: 'Typed boundaries improve reliability.' },
    { title: 'Agent observability', url: 'https://example.com/traces', snippet: 'Trace model and tool events together.' },
  ],
});

export const workflow = new WorkflowBuilder('research')
  .add(inputNode('input', () => ({ query: 'agent runtimes', limit: 5 })))
  .add(toolNode({ id: 'search', tool: search }))
  .add(transformNode('summarize', (value: { results: Array<{ title: string }> }) => value.results.map((item) => item.title).join(', ')))
  .add(outputNode('output'))
  .connect('input', 'search').connect('search', 'summarize').connect('summarize', 'output').build();

export const run = (input = 'agent runtimes') => workflow.run(input);
if (import.meta.url === `file://${process.argv[1]}`) console.log((await run()).output);
