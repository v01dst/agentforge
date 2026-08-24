import type { ComponentType } from 'react';

/**
 * Launch the interactive TUI when the terminal supports it.
 * `agentforge` with zero arguments always lands here on TTYs; non-TTY,
 * AGENTFORGE_HEADLESS=1 and TERM=dumb fall back to the classic CLI so
 * scripts and CI keep working unchanged.
 *
 * The TUI is chat-first: the default screen is a persistent conversation
 * with inline slash commands (/help, /models, /tools, /runs, ...) that open
 * interactive screens. All runtime logic is reused — nothing is duplicated.
 *
 * Returns true when the TUI was launched (caller should not continue).
 */
export async function launchInteractiveShell(): Promise<boolean> {
  if (!process.stdout.isTTY || process.env.AGENTFORGE_HEADLESS === '1' || process.env.TERM === 'dumb') {
    return false;
  }

  // Resolve the project entry (optional — the TUI works without one).
  const { loadConfig } = await import('./config.js');
  const { path: configPath, config } = await loadConfig({ required: false });

  // Build the turn runner from the project entry when available; otherwise a
  // stub runner that explains how to set up, so the TUI still opens anywhere.
  let runner: import('./ui/turn.js').TurnRunner;
  if (config.entry) {
    const { importEntry } = await import('./commands.js');
    const { buildTurnRunner } = await import('./ui/turn.js');
    const module = await importEntry(config.entry, { configPath });
    runner = buildTurnRunner(module);
  } else {
    runner = async function* () {
      yield {
        text: configPath
          ? 'No entrypoint is configured. Set `entry` in agentforge.config.ts or run /new to create a project.'
          : 'No AgentForge project found here. Run /new to create one, or cd into a project directory.',
      };
    };
  }

  const [{ render }, React, { TuiRoot }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./ui/shell/TuiRoot.js'),
  ]);
  const { ToolsScreen } = await import('./ui/slash/ToolsScreen.js');
  const { SkillsScreen } = await import('./ui/slash/SkillsScreen.js');
  const { WorkflowsScreen } = await import('./ui/slash/WorkflowsScreen.js');
  const { RunsScreen } = await import('./ui/slash/RunsScreen.js');
  const { AgentsScreen } = await import('./ui/slash/AgentsScreen.js');

  const provider = process.env.AGENTFORGE_PROVIDER ?? config.provider ?? 'mock';
  const model = process.env.AGENTFORGE_MODEL ?? (typeof config.model === 'string' ? config.model : config.model?.model);

  let instance: ReturnType<typeof render>;
  const runSuspended = async (fn: () => Promise<number>): Promise<void> => {
    instance.unmount();
    try { await fn(); } finally {
      process.stdout.write('\nPress Enter to return to AgentForge...');
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { await rl.question(''); } catch { /* stdin closed */ }
      rl.close();
      rerender();
    }
  };
  const rerender = (): void => instance.rerender(buildElement());

  const screens: Record<string, ComponentType> = {
    tools: ToolsScreen as ComponentType,
    skills: SkillsScreen as ComponentType,
    workflows: WorkflowsScreen as ComponentType,
    runs: RunsScreen as ComponentType,
    agents: AgentsScreen as ComponentType,
  };

  const buildElement = (): React.ReactElement =>
    React.createElement(TuiRoot as unknown as ComponentType<Record<string, unknown>>, {
      runner,
      provider,
      model,
      runSuspended,
      onExit: () => instance.unmount(),
      screens,
    });

  instance = render(buildElement());
  await instance.waitUntilExit();
  return true;
}
