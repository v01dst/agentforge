import { Agent, type AgentConfig } from '@agentforge/core';
export * from '@agentforge/core';

/** Small factory kept in a separate package for applications that only need agents. */
export function createAgent(config: AgentConfig): Agent { return new Agent(config); }

export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();
  register(agent: Agent): this { if (this.agents.has(agent.name)) throw new Error(`Agent already registered: ${agent.name}`); this.agents.set(agent.name, agent); return this; }
  get(name: string): Agent { const agent = this.agents.get(name); if (!agent) throw new Error(`Agent not found: ${name}`); return agent; }
  has(name: string): boolean { return this.agents.has(name); }
  list(): Agent[] { return [...this.agents.values()]; }
}
