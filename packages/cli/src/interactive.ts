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
export async function launchInteractiveShell(options: { initialMessages?: import('./ui/useTurn.js').ChatMessage[] } = {}): Promise<boolean> {
  if (!process.stdout.isTTY || process.env.AGENTFORGE_HEADLESS === '1' || process.env.TERM === 'dumb') {
    return false;
  }

  // Project detection is best-effort and never fatal: no project simply means
  // global/session mode. It only affects the status-line badge.
  const { detectProject } = await import('./runtime-session.js');
  const detection = await detectProject();

  // REAL coding-agent runner: a core Agent over the detected provider with
  // the seven policy-wrapped repository tools attached (permission modes via
  // /mode; approvals surface as an in-TUI card in ask mode). A project
  // entrypoint can still override the runner, but is never required.
  const { buildAgentRunner } = await import('./coding-session.js');
  const { detectDefaultProvider } = await import('./model-runner.js');
  const { pluginContributions } = await import('./plugins/plugins.js');
  const { readGlobalConfig } = await import('./global-config.js');
  const [contributions, globalCfg] = await Promise.all([pluginContributions(), readGlobalConfig()]);
  const pluginHooks = contributions.hooks as never;
  const detectedProviderModel = detectDefaultProvider();
  const reflection = {
    enabled: globalCfg.reflection?.enabled === true,
    provider: globalCfg.reflection?.provider,
    model: globalCfg.reflection?.model,
  };
  let resolved = {
    provider: detectedProviderModel.provider,
    model: detectedProviderModel.model,
    runner: buildAgentRunner({ root: process.cwd(), pluginHooks, reflection }),
  };
  let projectName: string | undefined;

  if (detection.found && detection.configPath) {
    try {
      const { importEntry } = await import('./commands.js');
      const { loadConfig } = await import('./config.js');
      const { buildTurnRunner } = await import('./ui/turn.js');
      const { gitDiffSummary } = await import('./git-diff-summary.js');
      const { config } = await loadConfig({ required: false });
      const inner = config.entry
        ? buildTurnRunner(await importEntry(config.entry, { configPath: detection.configPath }))
        : undefined;
      if (inner) {
        projectName = config.name;
        resolved = {
          ...resolved,
          runner: async function* withDiff(input, signal, context) {
            for await (const delta of inner(input, signal, context)) yield delta;
            const summary = await gitDiffSummary();
            if (summary) yield { text: `\n\ngit · ${summary}` };
          },
        };
      }
    } catch {
      /* project entrypoint failed — keep the coding-agent runner */
    }
  }
  const runner = resolved.runner;

  const [{ render }, React, slash, { TuiRoot }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./ui/slash/registry.js'),
    import('./ui/shell/TuiRoot.js'),
  ]);
  const [{ ConnectWizard }, { DoctorScreen }, { ToolsScreen }, { SkillsScreen }, { WorkflowsScreen }, { RunsScreen }, { AgentsScreen }, { HelpScreen }, { ModelsScreen }, { SettingsScreen }, { NewProjectScreen }, { RunScreen }] = await Promise.all([
    import('./ui/slash/ConnectWizard.js'),
    import('./ui/slash/DoctorScreen.js'),
    import('./ui/slash/ToolsScreen.js'),
    import('./ui/slash/SkillsScreen.js'),
    import('./ui/slash/WorkflowsScreen.js'),
    import('./ui/slash/RunsScreen.js'),
    import('./ui/slash/AgentsScreen.js'),
    import('./ui/slash/HelpScreen.js'),
    import('./ui/screens/ModelsScreen.js'),
    import('./ui/screens/SettingsScreen.js'),
    import('./ui/screens/NewProjectScreen.js'),
    import('./ui/screens/RunScreen.js'),
  ]);
  const { resolveActiveProvider } = await import('./global-config.js');
  const resolution = await resolveActiveProvider();
  // Prefer the model-runner detection (env keys) over stale global defaults,
  // so a fresh env var beats an old config entry.
  if (!process.env.AGENTFORGE_PROVIDER) {
    resolved = { ...resolved };
  }
  resolution.provider = resolved.provider;
  resolution.model = resolved.model;

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
    help: HelpScreen as ComponentType,
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
      initialMessages: options.initialMessages,
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
