import { useCallback, useRef, useState } from 'react';
import type { SkillSelection, TurnRunner } from './turn.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
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
  const controllerRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => { controllerRef.current?.abort(); }, []);

  const send = useCallback(async (rawInput: string, skills: SkillSelection = []) => {
    const input = rawInput.trim();
    if (!input || controllerRef.current) return;
    setMessages((previous) => [...previous, { role: 'user', text: input }]);
    setStreamingText('');
    setRunning(true);
    const startedAt = Date.now();
    const controller = new AbortController();
    controllerRef.current = controller;
    let text = '';
    try {
      for await (const delta of runner(input, controller.signal, { skills })) {
        if (delta.text) {
          text += delta.text;
          setStreamingText(text);
        }
        if (delta.usage) setStatus((previous) => ({ ...previous, totalTokens: delta.usage?.totalTokens }));
        if (delta.runId) setStatus((previous) => ({ ...previous, runId: delta.runId }));
      }
      setStatus((previous) => ({ ...previous, elapsedMs: Date.now() - startedAt }));
      setMessages((previous) => [...previous, { role: 'assistant', text: text || '[empty response]' }]);
    } catch (error) {
      const message = controller.signal.aborted
        ? '[cancelled]'
        : `Error: ${error instanceof Error ? error.message : String(error)}`;
      setMessages((previous) => [...previous, { role: 'assistant', text: message }]);
    } finally {
      setStreamingText('');
      setRunning(false);
      controllerRef.current = null;
    }
  }, [runner]);

  const clear = useCallback(() => {
    setMessages([]);
    setStatus({});
  }, []);

  const pushSystem = useCallback((text: string) => {
    setMessages((previous) => [...previous, { role: 'system', text }]);
  }, []);

  return { messages, streamingText, running, status, send, cancel, clear, pushSystem };
}
