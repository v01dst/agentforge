import React from 'react';

/** Shared types + helpers for the management screens (Models / Settings / Help). */

export interface ScreenProps {
  onBack?: () => void;
}

export const BUILTIN_PROVIDERS = ['mock', 'openai', 'anthropic', 'google', 'gemini'] as const;

export function badge(ready: boolean | null | undefined): string {
  if (ready === null || ready === undefined) return '·';
  return ready ? '✓' : '!';
}

export function envState(name: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(name && env[name]);
}
