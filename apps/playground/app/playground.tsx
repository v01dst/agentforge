"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleStop,
  Command,
  FileCode2,
  KeyRound,
  Loader2,
  Menu,
  PanelRight,
  Play,
  RotateCcw,
  Settings2,
  Sparkles,
  Terminal,
  X,
  Zap,
} from "lucide-react";

type Run = {
  runId: string;
  status: "completed" | "failed";
  output?: unknown;
  durationMs?: number;
  usage?: { totalTokens?: number; estimatedCostUsd?: number };
  steps?: Array<{ node: string; status: string; output?: unknown }>;
  events?: Array<{ type: string; timestamp: string; data?: Record<string, unknown> }>;
};

type Message = { role: "user" | "assistant" | "system"; content: string; runId?: string };

const starterMessages: Message[] = [
  { role: "system", content: "AgentForge console ready. Give the agent a task, or open a workflow run." },
];

function formatOutput(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "";
}

type StoredRun = {
  id: string;
  status: string;
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
};

function storedToRun(record: StoredRun): Run {
  const metadata = record.metadata ?? {};
  return {
    runId: record.id,
    status: record.status === "failed" ? "failed" : "completed",
    output: record.error ? `Error: ${record.error}` : record.output,
    durationMs: typeof metadata.durationMs === "number" ? metadata.durationMs : undefined,
  };
}

export function Playground() {
  const [messages, setMessages] = useState<Message[]>(starterMessages);
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("agentforge-local");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  const [running, setRunning] = useState(false);
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [showInspector, setShowInspector] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/runs");
        if (!response.ok) return;
        const data = await response.json() as { runs?: StoredRun[] };
        if (!cancelled && Array.isArray(data.runs)) {
          const mapped = data.runs.slice(0, 20).map(storedToRun);
          setRuns(mapped);
          if (mapped[0]) setActiveRun(mapped[0]);
        }
      } catch {
        // History is optional; a fresh session works without it.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const completedRuns = useMemo(() => runs.filter((run) => run.status === "completed").length, [runs]);

  async function runAgent(event?: React.FormEvent) {
    event?.preventDefault();
    const input = prompt.trim();
    if (!input || running) return;
    setPrompt(""); setError(""); setRunning(true);
    setMessages((current) => [...current, { role: "user", content: input }]);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: "Agent console", input: { topic: input }, provider, model, baseUrl: baseUrl || undefined, apiKeyEnv: apiKeyEnv || undefined }),
      });
      const data = await response.json() as Run & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Run failed");
      setActiveRun(data); setRuns((current) => [data, ...current]);
      setMessages((current) => [...current, { role: "assistant", content: formatOutput(data.output), runId: data.runId }]);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Run failed";
      setError(message); setMessages((current) => [...current, { role: "system", content: message }]);
    } finally { setRunning(false); }
  }

  function reset() {
    setMessages(starterMessages); setRuns([]); setActiveRun(null); setError("");
  }

  return (
    <div className="console-shell">
      <aside className="console-sidebar">
        <div className="console-brand"><span className="brand-glyph"><Sparkles size={15} /></span><span>agentforge</span><span className="brand-tag">playground</span></div>
        <button className="workspace-button"><span className="workspace-mark">A</span><span><strong>Local workspace</strong><small>development</small></span><ChevronDown size={14} /></button>
        <div className="sidebar-section-label">Workspace</div>
        <button className="side-link active"><Terminal size={16} /><span>Agent console</span><kbd>⌘ ↵</kbd></button>
        <button className="side-link" onClick={() => setShowInspector(true)}><Activity size={16} /><span>Run history</span><span className="side-count">{completedRuns}</span></button>
        <button className="side-link" disabled title="Workflow authoring is not implemented yet"><FileCode2 size={16} /><span>Workflows (coming soon)</span></button>
        <div className="sidebar-section-label spaced">Configure</div>
        <button className="side-link" onClick={() => setShowSettings(true)}><Settings2 size={16} /><span>Providers</span></button>
        <button className="side-link" disabled title="Environment inspection is not implemented yet"><KeyRound size={16} /><span>Environment (coming soon)</span></button>
        <div className="sidebar-bottom"><div className="runtime-health"><span className="health-dot" /><span><strong>Runtime online</strong><small>Mock provider ready</small></span></div><div className="sidebar-foot"><span>AgentForge</span><span>v0.1.0</span></div></div>
      </aside>

      <main className="console-main">
        <header className="console-header"><div className="mobile-brand"><Menu size={17} /><span>agentforge</span></div><div className="header-context"><span className="context-dot" />Agent console<span className="header-slash">/</span><span className="muted">Local workspace</span></div><div className="header-actions"><button className="header-icon" title="Reset session" onClick={reset}><RotateCcw size={16} /></button><button className="header-icon" title="Toggle run inspector" onClick={() => setShowInspector((value) => !value)}><PanelRight size={16} /></button><button className="header-connect" onClick={() => setShowSettings(true)}><span className="connected-dot" />{provider}<ChevronDown size={13} /></button></div></header>

        <section className="console-content">
          <div className="console-intro"><div className="intro-mark"><Bot size={20} /></div><div><p className="eyebrow">Interactive runtime</p><h1>What should the agent do?</h1><p className="intro-copy">Describe a task in plain language. AgentForge will run the configured agent, tools, and workflow and show every step.</p></div></div>
          <div className="conversation" aria-live="polite">
            {messages.map((message, index) => <div className={`message message-${message.role}`} key={`${message.role}-${index}`}><div className="message-avatar">{message.role === "assistant" ? <Sparkles size={14} /> : message.role === "system" ? <Zap size={14} /> : <span>you</span>}</div><div className="message-body"><div className="message-label">{message.role === "assistant" ? "AgentForge" : message.role === "system" ? "Runtime" : "You"}</div><div className="message-content">{message.content}</div>{message.runId ? <button className="run-reference" onClick={() => setShowInspector(true)}><Activity size={12} />{message.runId}<span>Inspect run</span></button> : null}</div></div>)}
            {running ? <div className="message message-assistant"><div className="message-avatar"><Loader2 size={14} className="spin" /></div><div className="message-body"><div className="message-label">AgentForge</div><div className="running-state"><span className="running-bar" /><span>Executing workflow</span><span className="running-detail">model.requested</span></div></div></div> : null}
          </div>
          <form className="composer" onSubmit={runAgent}><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void runAgent(); } }} placeholder="Ask the agent to inspect, build, research, or automate something..." rows={3} disabled={running} /><div className="composer-footer"><div className="composer-meta"><span className="composer-provider"><span className="connected-dot" />{provider}</span><span className="composer-model">{model}</span><span className="composer-hint"><Command size={11} /> Enter to run</span></div><button className="run-button" type="submit" disabled={!prompt.trim() || running}>{running ? <CircleStop size={15} /> : <ArrowUp size={15} />}<span>{running ? "Running" : "Run agent"}</span></button></div></form>
          {error ? <div className="error-banner"><span>{error}</span><button onClick={() => setError("")}><X size={14} /></button></div> : null}
          <div className="quick-actions"><span>Try a task</span><button onClick={() => setPrompt("Inspect this project and summarize its architecture")}>Inspect project</button><button onClick={() => setPrompt("Run a research workflow about the latest AI agent patterns")}>Research topic</button><button onClick={() => setPrompt("Check the current runtime and explain any issues")}>Check runtime</button></div>
        </section>
      </main>

      {showInspector ? <aside className="run-inspector"><div className="inspector-top"><div><p className="eyebrow">Execution trace</p><h2>{activeRun ? "Latest run" : "No run selected"}</h2></div><button className="header-icon" onClick={() => setShowInspector(false)}><X size={16} /></button></div>{activeRun ? <><div className="trace-id"><span className="health-dot" />{activeRun.runId}<span className="trace-status">{activeRun.status}</span></div><div className="trace-metrics"><div><span>Duration</span><strong>{activeRun.durationMs ? `${(activeRun.durationMs / 1000).toFixed(1)}s` : "-"}</strong></div><div><span>Tokens</span><strong>{activeRun.usage?.totalTokens ?? "-"}</strong></div><div><span>Cost</span><strong>{activeRun.usage?.estimatedCostUsd ? `$${activeRun.usage.estimatedCostUsd.toFixed(4)}` : "$0"}</strong></div></div><div className="trace-section"><div className="trace-heading"><span>Timeline</span><span>{activeRun.events?.length ?? activeRun.steps?.length ?? 0} events</span></div><div className="timeline">{(activeRun.events ?? activeRun.steps ?? []).map((event, index) => <div className="timeline-row" key={`${"type" in event ? event.type : event.node}-${index}`}><span className="timeline-line"><span className="timeline-dot" /></span><div><strong>{"type" in event ? event.type : event.node}</strong><small>{"timestamp" in event ? new Date(event.timestamp).toLocaleTimeString() : "completed"}</small></div></div>)}</div></div><div className="trace-section"><div className="trace-heading"><span>Workflow output</span><span className="output-state"><Check size={12} /> complete</span></div><pre className="output-preview">{formatOutput(activeRun.output)}</pre></div></> : <div className="empty-inspector"><div><Play size={17} /></div><strong>Your next run appears here</strong><p>Run a task to inspect model calls, tools, timing, and output.</p></div>}<div className="inspector-footer"><span><span className="health-dot" />Events are local</span><span>Safe by default</span></div></aside> : null}

      {showSettings ? <div className="modal-backdrop" onClick={() => setShowSettings(false)}><section className="settings-modal" onClick={(event) => event.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">Runtime settings</p><h2>Connect a model</h2></div><button className="header-icon" onClick={() => setShowSettings(false)}><X size={16} /></button></div><label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="">Select a provider…</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="google">Google Gemini</option><option value="openai-compatible">Custom endpoint (OpenAI-compatible)</option></select></label><label>Model ID<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-5.6-sol" /></label>{provider === "openai-compatible" ? (<><label>Base URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://openrouter.ai/api/v1" /></label><label>API key environment variable<input value={apiKeyEnv} onChange={(event) => setApiKeyEnv(event.target.value)} placeholder="OPENROUTER_API_KEY" /></label><p className="settings-hint">The server reads the key from its own environment using this variable name. Raw keys are never sent from the browser.</p></>) : null}<div className="settings-note"><KeyRound size={14} /><span>Credentials stay in your environment. The playground never stores API keys.</span></div><button className="save-settings" onClick={() => setShowSettings(false)}><Check size={15} />Save session settings</button></section></div> : null}
    </div>
  );
}
