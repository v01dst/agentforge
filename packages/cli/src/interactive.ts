import type { ComponentType } from 'react';

/**
 * Launch the interactive TUI when the terminal supports it.
 * `agentforge` with zero arguments ALWAYS lands here on TTYs — from any
 * directory, with or without a project. Non-TTY, AGENTFORGE_HEADLESS=1 and
 * TERM=dumb fall back to the classic CLI so scripts and CI keep working.
 *
 * Startup order: branded splash → global/session runtime → project detection
 * (non-fatal) → chat-first TUI.
 *
 * Returns true when the TUI was launched (caller should not continue).
 */
export async function launchInteractiveShell(): Promise<boolean> {
  if (!process.stdout.isTTY || process.env.AGENTFORGE_HEADLESS === '1' || process.env.TERM === 'dumb') {
    return false;
  }

  // Project detection is best-effort and never fatal: no project simply means
  // global/session mode.
  const { detectProject } = await import('./runtime-session.js');
  const detection = await detectProject();

  let runner: import('./ui/turn.js').TurnRunner;
  let projectName: string | undefined;
  if (detection.found && detection.configPath) {
    try {
      const { importEntry } = await import('./commands.js');
      const { loadConfig } = await import('./config.js');
      const { buildTurnRunner } = await import('./ui/turn.js');
      const { config } = await loadConfig({ required: false });
      if (config.entry) {
        const module = await importEntry(config.entry, { configPath: detection.configPath });
        runner = buildTurnRunner(module);
        projectName = config.name;
      } else {
        runner = await bareGuidanceRunner();
      }
    } catch {
      runner = await bareGuidanceRunner();
    }
  } else {
    runner = await bareGuidanceRunner();
  }

  async function bareGuidanceRunner(): Promise<import('./ui/turn.js').TurnRunner> {
    const { createBareRunner } = await import('./runtime-session.js');
    return createBareRunner();
  }

  const [{ render }, React, slash, { TuiRoot }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./ui/slash/registry.js'),
    import('./ui/shell/TuiRoot.js'),
  ]);
  const [{ ConnectWizard }, { DoctorScreen }, { ToolsScreen }, { SkillsScreen }, { WorkflowsScreen }, { RunsScreen }, { AgentsScreen }, { ModelsScreen }, { SettingsScreen }, { NewProjectScreen }, { RunScreen }] = await Promise.all([
    import('./ui/slash/ConnectWizard.js'),
    import('./ui/slash/DoctorScreen.js'),
    import('./ui/slash/ToolsScreen.js'),
    import('./ui/slash/SkillsScreen.js'),
    import('./ui/slash/WorkflowsScreen.js'),
    import('./ui/slash/RunsScreen.js'),
    import('./ui/slash/AgentsScreen.js'),
    import('./ui/screens/ModelsScreen.js'),
    import('./ui/screens/SettingsScreen.js'),
    import('./ui/screens/NewProjectScreen.js'),
    import('./ui/screens/RunScreen.js'),
  ]);
  const { resolveActiveProvider } = await import('./global-config.js');
  const resolution = await resolveActiveProvider();

  const screens: Record<string, ComponentType> = {
    tools: ToolsScreen as ComponentType,
    skills: SkillsScreen as ComponentType,
    workflows: WorkflowsScreen as ComponentType,
    runs: RunsScreen as ComponentType,
    agents: AgentsScreen as ComponentType,
    models: ModelsScreen as ComponentType,
    settings: SettingsScreen as ComponentType,
    'new-project': NewProjectScreen as ComponentType,
    run: RunScreen as ComponentType,
    connect: ConnectWizard as ComponentType,
    'doctor-result': DoctorScreen as ComponentType,
  };

  let instance: ReturnType<typeof render>;
  const rerender = (): void => instance.rerender(buildElement());
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

  const buildElement = (): React.ReactElement =>
    React.createElement(TuiRoot as unknown as ComponentType<Record<string, unknown>>, {
      runner,
      provider: resolution.provider,
      model: resolution.model ?? undefined,
      runSuspended,
      onExit: () => instance.unmount(),
      screens: screens as never,
      mode: detection.found ? 'project' : 'global',
      projectName,
    });

  // Branded startup splash (~600ms), then the persistent TUI.
  const { VERSION } = await import('./commands.js');
  const { StartupBanner } = await import('./ui/shell/StartupBanner.js');
  await new Promise<void>((resolveSplash) => {
    const splash = render(React.createElement(StartupBanner as unknown as ComponentType<Record<string, unknown>>, {
      ms: 600,
      version: VERSION,
      onDone: () => {
        splash.unmount();
        resolveSplash();
      },
      provider: resolution.provider,
      model: resolution.model ?? undefined,
      modeLine: detection.found ? 'PROJECT MODE' : 'GLOBAL SESSION',
    }));
  });

  instance = render(buildElement());
  await instance.waitUntilExit();
  return true;
}
