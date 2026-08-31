import type { Agent, EventBus, ModelProvider, ToolLike } from '@agentforge-oss/core';
import { WorkflowBuilder, type Workflow } from './workflow.js';
import {
  approvalNode,
  conditionNode,
  customNode,
  inputNode,
  modelNode,
  outputNode,
  parallelNode,
  toolNode,
  transformNode,
  agentNode,
} from './nodes.js';
import type { WorkflowNode } from './types.js';

/**
 * Versioned, JSON-serializable workflow documents (Phase 7).
 *
 * Graphs are plain data; behavior is attached at compile time through named
 * handlers (pure logic) and live instances (agents/models/tools). Documents
 * validate structurally before execution and round-trip through JSON for
 * import/export without touching source code.
 */

export const WORKFLOW_SCHEMA_VERSION = 1 as const;

export interface WorkflowDocumentNode {
  id: string;
  type: string;
  label?: string;
  retries?: number;
  /** Registered handler name for transform/condition/custom/approval nodes. */
  handler?: string;
  /** Branch handler names for parallel nodes. */
  branches?: string[];
  /** Free-form node configuration; validated as pass-through data. */
  config?: Record<string, unknown>;
}

export interface WorkflowDocumentEdge {
  from: string;
  to: string;
  label?: string;
  /** Registered condition-handler name for dynamic edges. */
  condition?: string;
}

export interface WorkflowDocument {
  version: typeof WORKFLOW_SCHEMA_VERSION;
  name: string;
  start?: string;
  maxSteps?: number;
  metadata?: Record<string, unknown>;
  nodes: WorkflowDocumentNode[];
  edges: WorkflowDocumentEdge[];
}

/** Live instances keyed by node id for agent/model/tool nodes. */
export interface WorkflowInstances {
  agents?: Record<string, Agent>;
  models?: Record<string, ModelProvider>;
  tools?: Record<string, ToolLike>;
}

export type WorkflowHandler = (value: unknown, context: { state: unknown }) => unknown;
export interface WorkflowValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const KNOWN_NODE_TYPES = new Set(['input', 'agent', 'model', 'tool', 'condition', 'parallel', 'transform', 'approval', 'output', 'custom']);
const HANDLER_REQUIRED = new Set(['transform', 'condition', 'custom', 'approval']);
const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural validation with precise messages. `handlers` (when provided)
 * additionally verifies that every referenced handler name exists.
 */
export function validateWorkflowDocument(document: unknown, handlers?: Record<string, WorkflowHandler>): WorkflowValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (message: string) => errors.push(message);

  if (!isRecord(document)) return { ok: false, errors: ['Workflow document must be a JSON object.'], warnings };
  if (document.version !== WORKFLOW_SCHEMA_VERSION) fail(`Unsupported workflow schema version: ${String(document.version)} (expected ${WORKFLOW_SCHEMA_VERSION}).`);
  if (typeof document.name !== 'string' || !document.name.trim()) fail('Workflow document requires a non-empty "name".');

  const nodes = document.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    fail('Workflow document requires a non-empty "nodes" array.');
    return { ok: false, errors, warnings };
  }

  const ids = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    const where = `nodes[${index}]`;
    if (!isRecord(node)) { fail(`${where} must be an object.`); continue; }
    if (typeof node.id !== 'string' || !ID_PATTERN.test(node.id)) fail(`${where}: id '${String(node.id)}' must match ${ID_PATTERN.source}.`);
    else if (ids.has(node.id)) fail(`${where}: duplicate node id '${node.id}'.`);
    else ids.add(node.id);
    if (typeof node.type !== 'string' || !KNOWN_NODE_TYPES.has(node.type)) fail(`${where}: unknown node type '${String(node.type)}'.`);
    if (node.retries !== undefined && (typeof node.retries !== 'number' || node.retries < 0 || !Number.isInteger(node.retries))) fail(`${where}: retries must be a non-negative integer.`);
    if (HANDLER_REQUIRED.has(String(node.type)) && (typeof node.handler !== 'string' || !node.handler)) fail(`${where}: node type '${String(node.type)}' requires a "handler" name.`);
    if (node.type === 'parallel' && (!Array.isArray(node.branches) || node.branches.length === 0 || !node.branches.every((branch) => typeof branch === 'string' && branch))) {
      fail(`${where}: parallel nodes require a non-empty "branches" array of handler names.`);
    }
    if (node.config !== undefined && !isRecord(node.config)) fail(`${where}: config must be an object.`);
  }

  const edges = document.edges;
  if (!Array.isArray(edges)) { fail('Workflow document requires an "edges" array.'); return { ok: false, errors, warnings }; }
  const seenEdges = new Set<string>();
  for (const [index, edge] of edges.entries()) {
    const where = `edges[${index}]`;
    if (!isRecord(edge)) { fail(`${where} must be an object.`); continue; }
    const from = typeof edge.from === 'string' ? edge.from : '';
    const to = typeof edge.to === 'string' ? edge.to : '';
    if (!ids.has(from)) fail(`${where}: unknown source node '${from || String(edge.from)}'.`);
    if (!ids.has(to)) fail(`${where}: unknown target node '${to || String(edge.to)}'.`);
    if (from && to) {
      const key = `${from}->${to}:${typeof edge.label === 'string' ? edge.label : ''}`;
      if (seenEdges.has(key)) fail(`${where}: duplicate edge ${from} -> ${to}${edge.label ? ` (${edge.label})` : ''}.`);
      seenEdges.add(key);
    }
    if (edge.condition !== undefined && typeof edge.condition !== 'string') fail(`${where}: condition must be a handler name.`);
  }

  if (document.start !== undefined && (typeof document.start !== 'string' || !ids.has(document.start))) {
    fail(`Workflow start node not found: ${String(document.start)}.`);
  }

  // Reachability and start determination (structural warnings only).
  const incoming = new Set<string>();
  for (const edge of edges) {
    if (isRecord(edge) && typeof edge.to === 'string') incoming.add(edge.to);
  }
  const roots = [...ids].filter((id) => !incoming.has(id));
  if (document.start === undefined) {
    if (roots.length === 0) fail('Workflow graph has no start node: every node has an incoming edge.');
    else if (roots.length > 1) warnings.push(`Ambiguous start: ${roots.length} nodes have no incoming edge (${roots.join(', ')}). The first is used.`);
  }
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!isRecord(edge) || typeof edge.from !== 'string' || typeof edge.to !== 'string') continue;
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }
  const reachable = new Set<string>();
  const queue = [typeof document.start === 'string' ? document.start : roots[0]].filter((id): id is string => Boolean(id));
  while (queue.length) {
    const id = queue.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of adjacency.get(id) ?? []) queue.push(next);
  }
  for (const id of ids) if (!reachable.has(id)) warnings.push(`Node '${id}' is unreachable from the start.`);

  if (handlers) {
    for (const node of nodes) {
      if (!isRecord(node)) continue;
      if (typeof node.handler === 'string' && !(node.handler in handlers)) fail(`Node '${String(node.id)}' references missing handler '${node.handler}'.`);
      for (const branch of (Array.isArray(node.branches) ? node.branches : []) as string[]) {
        if (!(branch in handlers)) fail(`Node '${String(node.id)}' references missing branch handler '${branch}'.`);
      }
    }
    for (const [index, edge] of edges.entries()) {
      if (isRecord(edge) && typeof edge.condition === 'string' && !(edge.condition in handlers)) {
        fail(`edges[${index}]: edge condition references missing handler '${edge.condition}'.`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export interface CompileOptions {
  handlers?: Record<string, WorkflowHandler>;
  instances?: WorkflowInstances;
  events?: EventBus;
}

function handlerOf(document: WorkflowDocument, node: WorkflowDocumentNode, options: CompileOptions): WorkflowHandler {
  const handler = node.handler !== undefined && options.handlers ? options.handlers[node.handler] : undefined;
  if (!handler) throw new Error(`Workflow '${document.name}': node '${node.id}' references missing handler '${node.handler ?? '(none)'}'.`);
  return handler;
}

/**
 * Compile a validated document into an executable Workflow. Throws on
 * structural problems (call validateWorkflowDocument first for reporting).
 */
export function compileWorkflowDocument(document: WorkflowDocument, options: CompileOptions = {}): Workflow {
  const validation = validateWorkflowDocument(document, options.handlers);
  if (!validation.ok) throw new Error(`Workflow '${document.name}' failed validation: ${validation.errors.join(' ')}`);

  const builder = new WorkflowBuilder(document.name);
  for (const node of document.nodes) {
    builder.add(documentNodeToNode(document, node, options));
  }
  for (const edge of document.edges) {
    const conditionHandler = edge.condition && options.handlers ? options.handlers[edge.condition] : undefined;
    if (edge.condition && !conditionHandler) throw new Error(`Workflow '${document.name}': edge ${edge.from} -> ${edge.to} references missing condition handler '${edge.condition}'.`);
    builder.connect(edge.from, edge.to, {
      label: edge.label,
      condition: conditionHandler ? (value, state) => Boolean(conditionHandler(value, { state })) : undefined,
    });
  }
  if (document.start) builder.setStart(document.start);
  return builder.build(options.events);
}

function documentNodeToNode(document: WorkflowDocument, node: WorkflowDocumentNode, options: CompileOptions): WorkflowNode {
  const wrap = (id: string, run: (value: unknown, context: { state: unknown }) => unknown, retries = 0): WorkflowNode =>
    customNode(id, (state) => run(state.value, { state }), retries);
  switch (node.type) {
    case 'input': return inputNode(node.id);
    case 'output': return outputNode(node.id);
    case 'condition': return conditionNode(node.id, (value, state) => Boolean(handlerOf(document, node, options)(value, { state })));
    case 'transform': {
      const handler = handlerOf(document, node, options);
      return transformNode(node.id, (value, state) => handler(value, { state }), node.retries ?? 0);
    }
    case 'custom': return wrap(node.id, handlerOf(document, node, options), node.retries ?? 0);
    case 'approval': return approvalNode(node.id, (value, state) => Boolean(handlerOf(document, node, options)(value, { state })));
    case 'parallel': {
      const branches = (node.branches ?? []).map((name) => {
        const handler = options.handlers?.[name];
        if (!handler) throw new Error(`Workflow '${document.name}': node '${node.id}' references missing branch handler '${name}'.`);
        return (state: unknown, context: unknown) => handler((state as { value: unknown }).value, { state });
      });
      return parallelNode(node.id, branches as never, node.retries ?? 0);
    }
    case 'agent': {
      const agent = options.instances?.agents?.[node.id];
      if (!agent) throw new Error(`Workflow '${document.name}': agent node '${node.id}' requires an instance (instances.agents['${node.id}']).`);
      return agentNode({ id: node.id, agent, retries: node.retries });
    }
    case 'model': {
      const model = options.instances?.models?.[node.id];
      if (!model) throw new Error(`Workflow '${document.name}': model node '${node.id}' requires an instance (instances.models['${node.id}']).`);
      return modelNode({ id: node.id, model, retries: node.retries });
    }
    case 'tool': {
      const tool = options.instances?.tools?.[node.id];
      if (!tool) throw new Error(`Workflow '${document.name}': tool node '${node.id}' requires an instance (instances.tools['${node.id}']).`);
      return toolNode({ id: node.id, tool, retries: node.retries });
    }
    default: throw new Error(`Workflow '${document.name}': cannot compile node type '${node.type}' (${node.id}).`);
  }
}

/** Import: parse and validate a document from JSON text. Throws with all errors. */
export function parseWorkflowDocument(text: string, handlers?: Record<string, WorkflowHandler>): WorkflowDocument {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) { throw new Error(`Workflow document is not valid JSON: ${(error as Error).message}`); }
  const validation = validateWorkflowDocument(parsed, handlers);
  if (!validation.ok) throw new Error(`Workflow document failed validation: ${validation.errors.join(' ')}`);
  return parsed as WorkflowDocument;
}

/** Export: canonical JSON text for a document. */
export function serializeWorkflowDocument(document: WorkflowDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
