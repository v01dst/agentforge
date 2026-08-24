import { Agent } from '@agentforge-oss/core';
import { MockModel } from '@agentforge-oss/models';

export const agent = new Agent({
  name: 'concierge',
  model: new MockModel({ responses: ['AgentForge is ready.'] }),
  instructions: 'Answer concisely and report uncertainty.',
});

export const run = (input = 'What can you do?') => agent.run(input);

if (import.meta.url === `file://${process.argv[1]}`) console.log((await run()).output);
