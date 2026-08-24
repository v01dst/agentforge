import type { ComponentType } from 'react';
import type { ShellProps } from './ui/shell/App.js';

/**
 * Launch the interactive shell when the terminal supports it.
 * Falls back to plain CLI help on non-TTY terminals so scripting and CI
 * keep working unchanged.
 *
 * Returns true when the shell was launched (caller should not continue).
 */
export async function launchInteractiveShell(): Promise<boolean> {
  if (!process.stdout.isTTY || process.env.AGENTFORGE_HEADLESS === '1' || process.env.TERM === 'dumb') {
    return false;
  }
  const [{ render }, React, shell, screens] = await Promise.all([
    import('ink'),
    import('react'),
    import('./ui/shell/App.js'),
    import('./ui/screens/index.js'),
  ]);

  const screenComponents: Partial<Record<string, ComponentType>> = {
    'new-project': screens.NewProjectScreen as ComponentType,
    run: screens.RunScreen as ComponentType,
    models: screens.ModelsScreen as ComponentType,
    settings: screens.SettingsScreen as ComponentType,
  };
  const props: ShellProps = { screens: screenComponents };

  const instance = render(React.createElement(shell.Shell as ComponentType<ShellProps>, props));
  await instance.waitUntilExit();
  return true;
}
