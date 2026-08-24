import type { Agent, AgentEvent, EventBus, Message, ModelProvider, ToolLike } from '@agentforge-oss/core';

export type WorkflowNodeType = 'input' | 'agent' | 'model' | 'tool' | 'condition' | 'parallel' | 'transform' | 'approval' | 'output' | 'custom';
export interface WorkflowState<T = unknown> { input: unknown; value: T; data: Record<string, unknown>; history: WorkflowStep[]; runId: string; signal: AbortSignal; }
export interface WorkflowContext { runId: string; signal: AbortSignal; events: EventBus; }
export interface WorkflowStep { nodeId: string; type: WorkflowNodeType; input: unknown; output?: unknown; startedAt: string; completedAt?: string; error?: string; attempts: number; }
export interface WorkflowNode<T = unknown> { id: string; type: WorkflowNodeType; label?: string; retries?: number; run(state: WorkflowState, context: WorkflowContext): T | Promise<T>; }
export interface WorkflowEdge { from: string; to: string; label?: string; condition?: (value: unknown, state: WorkflowState) => boolean; }
export interface WorkflowDefinition { name: string; nodes: WorkflowNode[]; edges: WorkflowEdge[]; start?: string; maxSteps?: number; metadata?: Record<string, unknown>; }
export interface WorkflowRunOptions { signal?: AbortSignal; timeoutMs?: number; maxSteps?: number; metadata?: Record<string, unknown>; }
export interface WorkflowResult { runId: string; output: unknown; state: WorkflowState; steps: WorkflowStep[]; durationMs: number; }

export type AgentNodeOptions = { id: string; agent: Agent; input?: (state: WorkflowState) => string; retries?: number };
export type ModelNodeOptions = { id: string; model: ModelProvider; input?: (state: WorkflowState) => Message[]; retries?: number };
export type ToolNodeOptions = { id: string; tool: ToolLike; input?: (state: WorkflowState) => unknown; retries?: number };
