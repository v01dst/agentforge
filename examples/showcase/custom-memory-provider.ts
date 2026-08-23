import { InMemoryMemoryProvider, type MemoryProvider, type RecallQuery, type RememberInput } from '@agentforge/memory';

export class AuditedMemoryProvider implements MemoryProvider {
  private readonly inner = new InMemoryMemoryProvider();
  readonly writes: string[] = [];
  async remember(input: RememberInput) { this.writes.push(input.namespace); return this.inner.remember(input); }
  recall(query: RecallQuery) { return this.inner.recall(query); }
  forget(id: string, namespace?: string) { return this.inner.forget(id, namespace); }
  clear(namespace: string) { return this.inner.clear(namespace); }
}

export async function run() {
  const memory = new AuditedMemoryProvider();
  await memory.remember({ namespace: 'demo', content: 'AgentForge supports custom memory providers.' });
  return memory.recall({ namespace: 'demo', query: 'custom memory' });
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(await run());
