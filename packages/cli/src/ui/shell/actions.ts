import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { chatCommand, doctorCommand, initCommand, listCommand, modelsCommand, runCommand, testCommand } from '../../commands.js';
import type { PaletteAction } from './palette.js';

/** Minimal shape of ink's render() result needed for suspension. */
export interface Suspendable {
  unmount: () => void;
}

/**
 * Unmount Ink, run `fn` (a stdout-printing command), wait for Enter, so the
 * caller can re-render the shell afterwards. Encapsulates the Ink/stdout
 * conflict without modifying the commands.
 */
export async function withSuspension(instance: Suspendable, fn: () => Promise<number> | number): Promise<void> {
  instance.unmount();
  try {
    await fn();
  } finally {
    stdout.write('\nPress Enter to return to AgentForge...');
    const rl = createInterface({ input: stdin, output: stdout });
    try { await rl.question(''); } catch { /* stdin closed — nothing to wait for */ }
    rl.close();
  }
}

/** Options used when building shell actions from real commands. */
export interface ShellActionsOptions {
  /** Live render instance; suspended around any command that prints. */
  instance: Suspendable;
  /** Re-mount the shell after a suspended command returns. */
  rerender: () => void;
  entry?: string;
}

function suspended(options: ShellActionsOptions, fn: () => Promise<number> | number): () => Promise<void> {
  return async () => {
    await withSuspension(options.instance, fn);
    options.rerender();
  };
}

/** Command palette actions backed by the real CLI commands. */
export function buildPaletteActions(options: ShellActionsOptions): PaletteAction[] {
  return [
    { id: 'chat', title: 'Chat with agent', hint: 'interactive session', run: suspended(options, () => chatCommand(options.entry, {})) },
    { id: 'run', title: 'Run agent once', hint: 'headless run', run: suspended(options, () => runCommand(options.entry, {})) },
    { id: 'new-project', title: 'New project', hint: 'scaffold', run: suspended(options, () => initCommand(undefined, {})) },
    { id: 'tools', title: 'Tools', hint: 'list tools', run: suspended(options, () => listCommand('tools', {})) },
    { id: 'workflows', title: 'Workflows', hint: 'list workflows', run: suspended(options, () => listCommand('workflows', {})) },
    { id: 'models', title: 'Models & providers', hint: 'models list', run: suspended(options, () => modelsCommand({})) },
    { id: 'tests', title: 'Run tests', hint: 'project tests', run: suspended(options, () => testCommand([])) },
    { id: 'doctor', title: 'Doctor diagnostics', hint: 'checks', run: suspended(options, () => doctorCommand({})) },
  ];
}
