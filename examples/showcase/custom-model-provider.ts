import { Agent, type ModelProvider } from '@agentforge-oss/core';

export class LocalEchoProvider implements ModelProvider {
  readonly provider = 'local-echo';
  readonly model = 'echo-v1';
  async generate(request: Parameters<ModelProvider['generate']>[0]) {
    const input = request.messages.at(-1)?.content ?? '';
    return { id: crypto.randomUUID(), content: `Local model received: ${input}`, finishReason: 'stop' as const, model: this.model };
  }
}

export const agent = new Agent({ name: 'local-agent', model: new LocalEchoProvider() });
export const run = (input = 'hello') => agent.run(input);
if (import.meta.url === `file://${process.argv[1]}`) console.log((await run()).output);
