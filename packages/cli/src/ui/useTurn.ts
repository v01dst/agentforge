import { useCallback, useRef, useState } from 'react';
import type { SkillSelection, ToolEvent, TurnRunner } from './turn.js';

/** Maximum number of retained tool events (oldest dropped). */
export const MAX_TOOL_EVENTS = 8;

/**
 * Pure reducer for tool-call events.
 * - A running event keyed by name replaces any existing running event with the same name.
 * - A done event removes the running entry for that name and appends the done event at the end.
 * - The list is capped at MAX_TOOL_EVENTS entries, dropping oldest first.
 */
export function reduceToolEvents(existing: ToolEvent[], event: ToolEvent): ToolEvent[] {
  const withoutName = existing.filter((e) => e.name !== event.name);
  const next = event.state === 'running'
    ? [...withoutName.filter((e) => e.state === 'running'), event]
    : [...withoutName, event];
  return next.length > MAX_TOOL_EVENTS ? next.slice(next.length - MAX_TOOL_EVENTS) : next;
}

export interface ToolMeta {
  tool: string;
  ms?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  meta?: ToolMeta;
}

export interface TurnStatus {
  totalTokens?: number;
  elapsedMs?: number;
  runId?: string;
}

export function useTurn(runner: TurnRunner) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<TurnStatus>({});
  const [lastError, setLastError] = useState<string | undefined>(undefined);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const controllerRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => { controllerRef.current?.abort(); }, []);

  const send = useCallback(async (rawInput: string, skills: SkillSelection = []) => {
    const input = rawInput.trim();
    if (!input || controllerRef.current) return;
    setLastError(undefined);
    setMessages((previous) => [...previous, { role: 'user', text: input }]);
    setStreamingText('');
    setRunning(true);
    const startedAt = Date.now();
    const controller = new AbortController();
    controllerRef.current = controller;
    let text = '';
    let latestUsage: number | undefined;
    let runId: string | undefined;
    try {
      for await (const delta of runner(input, controller.signal, { skills })) {
        if (delta.text) {
          text += delta.text;
          setStreamingText(text);
        }
        if (delta.tool) {
          // Runners may emit a terminal tool event without an explicit state;
          // `ms` present implies completion.
          const tool = delta.tool.state === undefined && delta.tool.ms !== undefined
            ? { ...delta.tool, state: 'done' as const }
            : delta.tool;
          setToolEvents((previous) => reduceToolEvents(previous, tool));
          if (tool.state === 'done') {
            setMessages((previous) => [...previous, {
              role: 'tool',
              text: tool.name,
              meta: { tool: tool.name, ms: tool.ms },
            }]);
          }
        }
        if (delta.usage) latestUsage = delta.usage?.totalTokens;
        if (delta.runId) runId = delta.runId;
      }
      // Apply status once after the loop: setState interleaved with a
      // fast-settling generator stalls ink-testing-library's frame writer
      // (lastFrame freezes even though React state advances).
      if (latestUsage !== undefined || runId !== undefined) {
        setStatus((previous) => ({ ...previous, totalTokens: latestUsage ?? previous.totalTokens, runId: runId ?? previous.runId }));
      }
      setStatus((previous) => ({ ...previous, elapsedMs: Date.now() - startedAt }));
      setMessages((previous) => [...previous, { role: 'assistant', text: text || '[empty response]' }]);
    } catch (error) {
      const message = controller.signal.aborted
        ? '[cancelled]'
        : error instanceof Error ? error.message : String(error);
      if (!controller.signal.aborted) setLastError(message);
      setMessages((previous) => [...previous, { role: 'assistant', text: `Error: ${message}` }]);
    } finally {
      setStreamingText('');
      setRunning(false);
      controllerRef.current = null;
    }
  }, [runner]);

  const clear = useCallback(() => {
    setMessages([]);
    setStatus({});
    setLastError(undefined);
    setToolEvents([]);
  }, []);

  const pushSystem = useCallback((text: string) => {
    setMessages((previous) => [...previous, { role: 'system', text }]);
  }, []);

  /** Replace the whole transcript (session resume). */
  const hydrate = useCallback((restored: ChatMessage[]) => {
    setMessages(restored);
    setStatus({});
    setLastError(undefined);
  }, []);

  return { messages, streamingText, running, status, lastError, toolEvents, send, cancel, clear, pushSystem, hydrate };
}
