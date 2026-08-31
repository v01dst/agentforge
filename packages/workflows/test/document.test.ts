import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_SCHEMA_VERSION,
  compileWorkflowDocument,
  parseWorkflowDocument,
  serializeWorkflowDocument,
  validateWorkflowDocument,
  type WorkflowDocument,
} from '../src/index.js';
import { EventBus } from '@agentforge-oss/core';

function branchingDocument(): WorkflowDocument {
  return {
    version: WORKFLOW_SCHEMA_VERSION,
    name: 'replay-flow',
    start: 'start',
    nodes: [
      { id: 'start', type: 'input' },
      { id: 'shape', type: 'transform', handler: 'asString' },
      { id: 'check', type: 'condition', handler: 'isLong' },
      { id: 'longPath', type: 'transform', handler: 'upper' },
      { id: 'shortPath', type: 'transform', handler: 'repeat' },
      { id: 'out', type: 'output' },
    ],
    edges: [
      { from: 'start', to: 'shape' },
      { from: 'shape', to: 'check' },
      { from: 'check', to: 'longPath', label: 'true' },
      { from: 'check', to: 'shortPath', label: 'false' },
      { from: 'longPath', to: 'out' },
      { from: 'shortPath', to: 'out' },
    ],
  };
}

const handlers = {
  asString: (value: unknown) => String(value ?? ''),
  isLong: (value: unknown) => String(value).length > 4,
  upper: (value: unknown) => String(value).toUpperCase(),
  repeat: (value: unknown) => `${value}${value}`,
};

describe('workflow document validation', () => {
  it('accepts a well-formed document with reachable nodes', () => {
    const result = validateWorkflowDocument(branchingDocument());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('reports every structural problem with a precise message', () => {
    const result = validateWorkflowDocument({
      version: 2,
      name: '',
      nodes: [
        { id: 'a', type: 'transform' },
        { id: 'a', type: 'wat' },
        { id: 'orphan', type: 'output' },
      ],
      edges: [
        { from: 'a', to: 'ghost' },
        { from: 'a', to: 'ghost' },
      ],
    });
    expect(result.ok).toBe(false);
    const joined = result.errors.join('\n');
    expect(joined).toContain('Unsupported workflow schema version: 2');
    expect(joined).toContain('non-empty "name"');
    expect(joined).toContain("duplicate node id 'a'");
    expect(joined).toContain("unknown node type 'wat'");
    expect(joined).toContain("type 'transform' requires a \"handler\" name");
    expect(joined).toContain("unknown target node 'ghost'");
    expect(joined).toContain('duplicate edge a -> ghost');
    // 'a' and 'orphan' both lack incoming edges -> ambiguous start (warning).
    expect(result.warnings.join('\n')).toContain('Ambiguous start');
  });

  it('verifies handler availability when a registry is provided', () => {
    const result = validateWorkflowDocument(branchingDocument(), { asString: handlers.asString });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain("references missing handler 'isLong'");
  });

  it('fails when no node can be a start', () => {
    const result = validateWorkflowDocument({
      version: WORKFLOW_SCHEMA_VERSION,
      name: 'cyclic',
      nodes: [
        { id: 'a', type: 'input' },
        { id: 'b', type: 'output' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('no start node');
  });

  it('warns when the start is ambiguous but still validates', () => {
    const doc = branchingDocument();
    // Remove the explicit start AND the only edge into 'shape' so two nodes
    // ('start' and 'shape') lack incoming edges.
    delete (doc as { start?: string }).start;
    doc.edges = doc.edges.filter((edge) => !(edge.from === 'start' && edge.to === 'shape'));
    const result = validateWorkflowDocument(doc);
    expect(result.ok).toBe(true);
    expect(result.warnings.join('\n')).toContain('Ambiguous start');
  });

  it('rejects non-objects and empty node arrays', () => {
    expect(validateWorkflowDocument('nope').ok).toBe(false);
    expect(validateWorkflowDocument({ version: 1, name: 'x', nodes: [], edges: [] }).ok).toBe(false);
  });
});

describe('workflow document compilation and replay', () => {
  it('compiles to a workflow that branches deterministically', async () => {
    const events = new EventBus();
    const seen: string[] = [];
    events.addSink({ async emit(event) { seen.push(`${event.type}:${(event.data as { nodeId?: string }).nodeId ?? ''}`); } });
    const workflow = compileWorkflowDocument(branchingDocument(), { handlers, events });

    // The branch selects on the condition node's boolean output, so the
    // longPath transform receives `true` and uppercases it.
    const long = await workflow.run('hello!');
    expect(long.output).toBe('TRUE');
    expect(long.steps.map((step) => step.nodeId)).toEqual(['start', 'shape', 'check', 'longPath', 'out']);

    const short = await workflow.run('hi');
    expect(short.output).toBe('falsefalse');
    expect(short.steps.map((step) => step.nodeId)).toEqual(['start', 'shape', 'check', 'shortPath', 'out']);
    expect(seen.some((entry) => entry.startsWith('workflow.started'))).toBe(true);
    expect(seen).toContain('workflow.node.completed:out');
  });

  it('replays identically across repeated compilations (deterministic history)', async () => {
    const doc = branchingDocument();
    const first = await compileWorkflowDocument(doc, { handlers }).run('playbook');
    const second = await compileWorkflowDocument(doc, { handlers }).run('playbook');
    const replayOf = (run: Awaited<ReturnType<ReturnType<typeof compileWorkflowDocument>['run']>>) =>
      run.steps.map((step) => ({ nodeId: step.nodeId, type: step.type, output: step.output, attempts: step.attempts }));
    expect(replayOf(second)).toEqual(replayOf(first));
    expect(second.output).toBe(first.output);
    // The persisted history is JSON-serializable for auditing.
    expect(() => JSON.stringify(second.steps)).not.toThrow();
  });

  it('compiles parallel nodes and collects branch outputs', async () => {
    const doc: WorkflowDocument = {
      version: WORKFLOW_SCHEMA_VERSION,
      name: 'fan',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'fanout', type: 'parallel', branches: ['half1', 'half2'] },
        { id: 'out', type: 'output' },
      ],
      edges: [
        { from: 'start', to: 'fanout' },
        { from: 'fanout', to: 'out' },
      ],
    };
    const handlers2 = { half1: (value: unknown) => `a:${value}`, half2: (value: unknown) => `b:${value}` };
    const result = await compileWorkflowDocument(doc, { handlers: handlers2 }).run('x');
    expect(result.output).toEqual(['a:x', 'b:x']);
  });

  it('honors retries on transform nodes before failing', async () => {
    const doc: WorkflowDocument = {
      version: WORKFLOW_SCHEMA_VERSION,
      name: 'flaky',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'boom', type: 'transform', handler: 'alwaysFails', retries: 2 },
      ],
      edges: [{ from: 'start', to: 'boom' }],
    };
    let attempts = 0;
    const failing = { alwaysFails: () => { attempts += 1; throw new Error(`boom ${attempts}`); } };
    const workflow = compileWorkflowDocument(doc, { handlers: failing });
    await expect(workflow.run('go')).rejects.toThrow(/boom 3/);
    expect(attempts).toBe(3);
  });

  it('requires live instances for agent/model/tool nodes', () => {
    const doc: WorkflowDocument = {
      version: WORKFLOW_SCHEMA_VERSION,
      name: 'needs-instance',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'helper', type: 'tool' },
      ],
      edges: [{ from: 'start', to: 'helper' }],
    };
    expect(() => compileWorkflowDocument(doc, { handlers: {} })).toThrow(/requires an instance/);
  });
});

describe('workflow import/export', () => {
  it('round-trips a document through parse/serialize without behavior change', async () => {
    const original = branchingDocument();
    const text = serializeWorkflowDocument(original);
    const parsed = parseWorkflowDocument(text, handlers);
    expect(parsed).toEqual(original);
    const a = await compileWorkflowDocument(original, { handlers }).run('cycle');
    const b = await compileWorkflowDocument(parsed, { handlers }).run('cycle');
    expect(b.output).toBe(a.output);
  });

  it('rejects malformed JSON and invalid documents with precise messages', () => {
    expect(() => parseWorkflowDocument('{broken')).toThrow(/not valid JSON/);
    expect(() => parseWorkflowDocument('{"version":9,"name":"x","nodes":[{"id":"a","type":"input"}],"edges":[]}')).toThrow(/Unsupported workflow schema version/);
  });
});
