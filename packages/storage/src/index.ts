import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentEvent, EventSink } from '@agentforge/core';

export interface RunRecord { id: string; agentId?: string; workflowId?: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; input?: unknown; output?: unknown; error?: string; startedAt: string; completedAt?: string; metadata?: Record<string, unknown>; }
export interface MessageRecord { runId: string; role: string; content: string; createdAt: string; toolCallId?: string; }
export interface ToolCallRecord { runId: string; id: string; name: string; input: unknown; output?: unknown; error?: string; durationMs?: number; attempts?: number; createdAt: string; }
export interface RunStore { createRun(run: RunRecord): Promise<void>; updateRun(id: string, patch: Partial<RunRecord>): Promise<void>; appendMessage(message: MessageRecord): Promise<void>; appendToolCall(call: ToolCallRecord): Promise<void>; appendEvent(event: AgentEvent): Promise<void>; getRun(id: string): Promise<RunRecord | undefined>; listRuns(options?: { limit?: number; status?: RunRecord['status'] }): Promise<RunRecord[]>; }

export class InMemoryRunStore implements RunStore {
  readonly runs = new Map<string, RunRecord>(); readonly messages: MessageRecord[] = []; readonly toolCalls: ToolCallRecord[] = []; readonly events: AgentEvent[] = [];
  async createRun(run: RunRecord): Promise<void> { if (this.runs.has(run.id)) throw new Error(`Run already exists: ${run.id}`); this.runs.set(run.id, { ...run }); }
  async updateRun(id: string, patch: Partial<RunRecord>): Promise<void> { const run = this.runs.get(id); if (!run) throw new Error(`Run not found: ${id}`); this.runs.set(id, { ...run, ...patch }); }
  async appendMessage(message: MessageRecord): Promise<void> { this.messages.push({ ...message }); }
  async appendToolCall(call: ToolCallRecord): Promise<void> { this.toolCalls.push({ ...call }); }
  async appendEvent(event: AgentEvent): Promise<void> { this.events.push(event); }
  async getRun(id: string): Promise<RunRecord | undefined> { const run = this.runs.get(id); return run ? { ...run } : undefined; }
  async listRuns(options: { limit?: number; status?: RunRecord['status'] } = {}): Promise<RunRecord[]> { return [...this.runs.values()].filter((run) => !options.status || run.status === options.status).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, options.limit ?? 50).map((run) => ({ ...run })); }
}

export class JsonlRunStore implements RunStore {
  private readonly memory = new InMemoryRunStore(); private loaded = false;
  constructor(private readonly filePath: string) {}
  private async load(): Promise<void> { if (this.loaded) return; this.loaded = true; try { const lines = (await readFile(this.filePath, 'utf8')).split('\n').filter(Boolean); for (const line of lines) { const item = JSON.parse(line) as { kind: string; value: unknown }; if (item.kind === 'run') this.memory.runs.set((item.value as RunRecord).id, item.value as RunRecord); else if (item.kind === 'event') this.memory.events.push(item.value as AgentEvent); else if (item.kind === 'message') this.memory.messages.push(item.value as MessageRecord); else if (item.kind === 'tool') this.memory.toolCalls.push(item.value as ToolCallRecord); } } catch (error) { const value = error as NodeJS.ErrnoException; if (value.code !== 'ENOENT') throw error; } }
  private async write(kind: string, value: unknown): Promise<void> { await mkdir(dirname(this.filePath), { recursive: true }); await appendFile(this.filePath, `${JSON.stringify({ kind, value })}\n`, 'utf8'); }
  async createRun(run: RunRecord) { await this.load(); await this.memory.createRun(run); await this.write('run', run); }
  async updateRun(id: string, patch: Partial<RunRecord>) { await this.load(); await this.memory.updateRun(id, patch); const value = await this.memory.getRun(id); if (value) await this.write('run', value); }
  async appendMessage(value: MessageRecord) { await this.load(); await this.memory.appendMessage(value); await this.write('message', value); }
  async appendToolCall(value: ToolCallRecord) { await this.load(); await this.memory.appendToolCall(value); await this.write('tool', value); }
  async appendEvent(value: AgentEvent) { await this.load(); await this.memory.appendEvent(value); await this.write('event', value); }
  async getRun(id: string) { await this.load(); return this.memory.getRun(id); }
  async listRuns(options?: { limit?: number; status?: RunRecord['status'] }) { await this.load(); return this.memory.listRuns(options); }
}

export interface StorageQuery { query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>; }
export class PostgresRunStore implements RunStore {
  constructor(private readonly db: StorageQuery, private readonly table = 'agentforge_runs') { if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error('Invalid run table name'); }
  async migrate(): Promise<void> { await this.db.query(`
    CREATE TABLE IF NOT EXISTS agentforge_agents (
      id text PRIMARY KEY, name text NOT NULL, definition jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ${this.table} (
      id text PRIMARY KEY, agent_id text, workflow_id text, status text NOT NULL,
      input jsonb, output jsonb, error text, started_at timestamptz NOT NULL,
      completed_at timestamptz, metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS ${this.table}_started_idx ON ${this.table}(started_at DESC);
    CREATE TABLE IF NOT EXISTS ${this.table}_messages (
      id bigserial PRIMARY KEY, run_id text NOT NULL REFERENCES ${this.table}(id) ON DELETE CASCADE,
      role text NOT NULL, content text NOT NULL, tool_call_id text, created_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${this.table}_tool_calls (
      id text PRIMARY KEY, run_id text NOT NULL REFERENCES ${this.table}(id) ON DELETE CASCADE,
      name text NOT NULL, input jsonb NOT NULL, output jsonb, error text,
      duration_ms integer, attempts integer, created_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${this.table}_workflow_executions (
      id bigserial PRIMARY KEY, run_id text NOT NULL REFERENCES ${this.table}(id) ON DELETE CASCADE,
      node_id text NOT NULL, node_type text NOT NULL, status text NOT NULL,
      input jsonb, output jsonb, error text, started_at timestamptz NOT NULL, completed_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS ${this.table}_events (
      id bigserial PRIMARY KEY, run_id text NOT NULL REFERENCES ${this.table}(id) ON DELETE CASCADE,
      type text NOT NULL, timestamp timestamptz NOT NULL, data jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${this.table}_usage (
      id bigserial PRIMARY KEY, run_id text NOT NULL REFERENCES ${this.table}(id) ON DELETE CASCADE,
      provider text, model text, input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL DEFAULT 0, estimated_cost numeric(14, 8), created_at timestamptz NOT NULL DEFAULT now()
    );
  `); }
  async createRun(run: RunRecord) { await this.db.query(`INSERT INTO ${this.table} (id,agent_id,workflow_id,status,input,output,error,started_at,completed_at,metadata) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10::jsonb)`, [run.id, run.agentId ?? null, run.workflowId ?? null, run.status, json(run.input), json(run.output), run.error ?? null, run.startedAt, run.completedAt ?? null, json(run.metadata ?? {})]); }
  async updateRun(id: string, patch: Partial<RunRecord>) { const fields: string[] = []; const values: unknown[] = []; const add = (column: string, value: unknown) => { values.push(value); fields.push(`${column}=$${values.length}`); }; if (patch.status) add('status', patch.status); if ('output' in patch) add('output', json(patch.output)); if ('error' in patch) add('error', patch.error ?? null); if (patch.completedAt) add('completed_at', patch.completedAt); if (patch.metadata) add('metadata', json(patch.metadata)); if (!fields.length) return; values.push(id); await this.db.query(`UPDATE ${this.table} SET ${fields.join(',')} WHERE id=$${values.length}`, values); }
  async appendMessage(message: MessageRecord): Promise<void> { await this.db.query(`INSERT INTO ${this.table}_messages (run_id,role,content,tool_call_id,created_at) VALUES ($1,$2,$3,$4,$5)`, [message.runId, message.role, message.content, message.toolCallId ?? null, message.createdAt]); }
  async appendToolCall(call: ToolCallRecord): Promise<void> { await this.db.query(`INSERT INTO ${this.table}_tool_calls (id,run_id,name,input,output,error,duration_ms,attempts,created_at) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)`, [call.id, call.runId, call.name, json(call.input), json(call.output), call.error ?? null, call.durationMs ?? null, call.attempts ?? null, call.createdAt]); }
  async appendEvent(event: AgentEvent) { await this.db.query(`INSERT INTO ${this.table}_events (run_id,type,timestamp,data) VALUES ($1,$2,$3,$4::jsonb)`, [event.runId, event.type, event.timestamp, json(event.data)]); }
  async getRun(id: string) { const result = await this.db.query<RunRow>(`SELECT * FROM ${this.table} WHERE id=$1`, [id]); const row = result.rows[0]; return row ? fromRow(row) : undefined; }
  async listRuns(options: { limit?: number; status?: RunRecord['status'] } = {}) { const values: unknown[] = []; const clauses: string[] = []; if (options.status) { values.push(options.status); clauses.push(`status=$${values.length}`); } values.push(options.limit ?? 50); const result = await this.db.query<RunRow>(`SELECT * FROM ${this.table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT $${values.length}`, values); return result.rows.map(fromRow); }
}
interface RunRow { id: string; agent_id?: string | null; workflow_id?: string | null; status: RunRecord['status']; input?: unknown; output?: unknown; error?: string | null; started_at: string; completed_at?: string | null; metadata?: Record<string, unknown>; }
const json = (value: unknown) => JSON.stringify(value ?? null);
const fromRow = (row: RunRow): RunRecord => ({ id: row.id, agentId: row.agent_id ?? undefined, workflowId: row.workflow_id ?? undefined, status: row.status, input: row.input, output: row.output, error: row.error ?? undefined, startedAt: row.started_at, completedAt: row.completed_at ?? undefined, metadata: row.metadata ?? {} });
export class RunStoreEventSink implements EventSink { constructor(private readonly store: RunStore) {} emit(event: AgentEvent) { return this.store.appendEvent(event); } }
