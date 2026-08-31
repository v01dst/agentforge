import { formatError, error, info } from './output.js';
import { HELP, VERSION, chatCommand, connectCommand, devCommand, doctorCommand, initCommand, inspectCommand, listCommand, mcpCommand, modelsCommand, modelsTestCommand, permissionsCommand, pluginsAddCommand, pluginsCommand, pluginsLifecycleCommand, pluginsRemoveCommand, profileCommand, providersCommand, runsCommand, findingsCommand, gatewayCommand, daemonCommand, sessionsCommand, runCommand, skillsCommand, testCommand, workflowsValidateCommand } from './commands.js';
import type { ParsedCli } from './types.js';

export function parseArgs(argv: string[]): ParsedCli {
  const args: string[] = []; const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (value === '--') { args.push(...argv.slice(index + 1)); break; }
    if (value.startsWith('--')) {
      const [rawKey, inline] = value.slice(2).split('=', 2);
      const key = rawKey ?? '';
      if (!key) continue;
      const next = argv[index + 1];
      if (inline !== undefined) flags[key] = inline;
      else if (next && !next.startsWith('-')) { flags[key] = next; index += 1; }
      else flags[key] = true;
    } else if (value.startsWith('-') && value.length > 1) {
      for (const short of value.slice(1)) flags[short === 'h' ? 'help' : short === 'v' ? 'version' : short] = true;
    } else args.push(value);
  }
  const [command, ...rest] = args;
  return { command, args: rest, flags };
}

export async function execute(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  const cwd = typeof parsed.flags.cwd === 'string' ? parsed.flags.cwd : undefined;
  if (cwd) process.chdir(cwd);
  const { resolveSkin, setActiveSkin } = await import('./ui/skin.js');
  setActiveSkin((await resolveSkin({ cwd })).skin);
  if (parsed.flags.help) { info(HELP); return 0; }
  if (parsed.flags.version) { info(VERSION); return 0; }
  if (!parsed.command) {
    // Bare `agentforge` ALWAYS launches the interactive TUI on TTYs — with or
    // without a configured project. Non-TTY/headless falls back to the classic
    // CLI (help) so scripts and CI are unaffected.
    const { launchInteractiveShell } = await import('./interactive.js');
    if (await launchInteractiveShell()) return 0;
    info(HELP); return 0;
  }
  switch (parsed.command) {
    case 'init': return await initCommand(parsed.args[0], parsed.flags);
    case 'dev': return await devCommand(parsed.flags);
    case 'run': return await runCommand(parsed.args[0], parsed.flags);
    case 'chat': return await chatCommand(parsed.args[0], parsed.flags);
    case 'models': {
      const sub = parsed.args[0];
      if (sub === 'test') return await modelsTestCommand(parsed.args.slice(1), parsed.flags);
      if (sub && !['list', 'ls', 'l'].includes(sub)) throw new Error(`Unknown models subcommand: ${sub}. Usage: agentforge models [list|test].`);
      return await modelsCommand(parsed.flags);
    }
    case 'test': return await testCommand(parsed.args);
    case 'inspect': return await inspectCommand(parsed.args[0], parsed.flags);
    case 'providers': return await providersCommand(parsed.args, parsed.flags);
    case 'tools': return await listCommand('tools', parsed.flags);
    case 'workflows': {
      const sub = parsed.args[0];
      if (sub === 'validate') return await workflowsValidateCommand(parsed.args[1], parsed.flags);
      if (sub && !['list', 'ls', 'l'].includes(sub)) throw new Error(`Unknown workflows subcommand: ${sub}. Usage: agentforge workflows [list|validate].`);
      return await listCommand('workflows', parsed.flags);
    }
    case 'doctor': return await doctorCommand(parsed.flags);
    case 'connect': return await connectCommand(parsed.args[0], parsed.flags);
    case 'plugins': {
      const sub = parsed.args[0];
      if (sub === 'add') return await pluginsAddCommand(parsed.args[1]);
      if (sub === 'remove' || sub === 'rm') return await pluginsRemoveCommand(parsed.args[1]);
      if (sub === 'enable') return await pluginsLifecycleCommand('enable', parsed.args[1]);
      if (sub === 'disable') return await pluginsLifecycleCommand('disable', parsed.args[1]);
      if (sub && !['list', 'ls', 'l'].includes(sub)) throw new Error(`Unknown plugins subcommand: ${sub}. Usage: agentforge plugins [list|add|remove|enable|disable].`);
      return await pluginsCommand(parsed.flags);
    }
    case 'mcp': return await mcpCommand(parsed.args, parsed.flags);
    case 'sessions': return await sessionsCommand(parsed.args, parsed.flags);
    case 'runs': return await runsCommand(parsed.args, parsed.flags);
    case 'findings': return await findingsCommand(parsed.args, parsed.flags);
    case 'gateway': return await gatewayCommand(parsed.args, parsed.flags);
    case 'daemon': return await daemonCommand(parsed.args, parsed.flags);

    case 'permissions': return await permissionsCommand(parsed.args, parsed.flags);

    case 'skills': return await skillsCommand(parsed.args, parsed.flags);

    case 'profile': return await profileCommand(parsed.args, parsed.flags);
    default: throw new Error(`Unknown command: ${parsed.command}. Run agentforge --help.`);
  }
}

export async function main(argv?: string[]): Promise<void> {
  try { process.exitCode = await execute(argv); }
  catch (caught) { error(formatError(caught)); process.exitCode = 1; }
}
