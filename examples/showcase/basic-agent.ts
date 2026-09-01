import { Agent } from '@agentforge-oss/core';
import { ScriptedModel } from './demo-model.js';

export const agent = new Agent({
  name: 'concierge',
  model: new ScriptedModel([{ content: 'AgentForge is ready.' }]),
  instructions: 'Answer concisely and report uncertainty.',
});

export const run = (input = 'What can you do?') => agent.run(input);

if (import.meta.url === `file://${process.argv[1]}`) console.log((await run()).output);
