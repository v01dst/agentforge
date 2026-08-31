/**
 * Session modes (Phase T): a mode layer above permission postures. Where a
 * posture (read-only | ask | workspace-write | trusted) governs what tool
 * calls need approval, a session mode governs how the session behaves:
 *
 * - `chat` — conversational; coding tools still available but the system
 *   prompt steers toward explanation over action.
 * - `build` — the default coding mode (workspace-write posture by default).
 * - `indie` — fast-shipping focus: workspace-write default, fewer prompts,
 *   bias toward small diffs and running tests.
 * - `automode` — heuristic autonomy: the same tools, plus an optional
 *   cheap-model router (off by default) that pre-screens steps.
 *
 * Modes are advisory state: they set the posture when entered (mode default)
 * and carry an instruction fragment; they never bypass the policy layer.
 */

import { setPermissionMode, type PermissionMode } from '../permissions.js';

export type SessionMode = 'chat' | 'build' | 'indie' | 'automode';

export const SESSION_MODES: readonly SessionMode[] = ['chat', 'build', 'indie', 'automode'];

export interface SessionModeDefinition {
  name: SessionMode;
  description: string;
  /** Posture applied on entry (mode default). */
  defaultPosture: PermissionMode;
  /** Instruction fragment injected into the session when the mode is active. */
  instructions: string;
}

export const SESSION_MODE_DEFINITIONS: Readonly<Record<SessionMode, SessionModeDefinition>> = {
  chat: {
    name: 'chat',
    description: 'Conversational mode — explain and discuss; tools stay available',
    defaultPosture: 'ask',
    instructions: [
      'You are in chat mode: prefer explanation and discussion over taking action.',
      'Tools remain available — use them to look things up — but do not start edits',
      'or long command runs unless the user explicitly asks.',
    ].join(' '),
  },
  build: {
    name: 'build',
    description: 'Default coding mode — implement with the standard approval flow',
    defaultPosture: 'workspace-write',
    instructions: 'You are in build mode: implement the requested changes with focused edits and verify them.',
  },
  indie: {
    name: 'indie',
    description: 'Fast-shipping mode — workspace-write default, minimal prompts, small diffs',
    defaultPosture: 'workspace-write',
    instructions: [
      'You are in indie mode: ship fast.',
      'Keep diffs small and reversible, run the relevant tests, and report what changed.',
      'Do not gold-plate; stop when the requested thing works.',
    ].join(' '),
  },
  automode: {
    name: 'automode',
    description: 'Heuristic autonomy — chain steps with an optional cheap-model router (off by default)',
    defaultPosture: 'workspace-write',
    instructions: [
      'You are in automode: work through the task step by step without waiting for',
      'approval between steps. Still respect every permission rule and boundary;',
      'summarize what you did when the task completes.',
    ].join(' '),
  },
};

export function isSessionMode(value: string): value is SessionMode {
  return (SESSION_MODES as readonly string[]).includes(value);
}

/** Session-scoped active mode (defaults to build). */
let currentMode: SessionMode = 'build';

export function currentSessionMode(): SessionMode {
  return currentMode;
}

export interface EnterModeResult {
  mode: SessionMode;
  postureApplied: PermissionMode;
  instructions: string;
}

/**
 * Enter a session mode: records it and applies the mode's default posture.
 * Returns the instruction fragment so callers can surface it.
 */
export function enterSessionMode(mode: SessionMode): EnterModeResult {
  const definition = SESSION_MODE_DEFINITIONS[mode];
  currentMode = mode;
  setPermissionMode(definition.defaultPosture);
  return { mode, postureApplied: definition.defaultPosture, instructions: definition.instructions };
}

/** Automode's cheap-model router is opt-in via config; nothing runs by default. */
export interface AutomodeRouterConfig {
  enabled: boolean;
  provider?: string;
  model?: string;
}

export const DEFAULT_AUTOMODE_ROUTER: AutomodeRouterConfig = { enabled: false };
