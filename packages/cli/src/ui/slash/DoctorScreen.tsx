import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { existsSync } from 'node:fs';
import { VERSION } from '../../commands.js';
import {
  globalConfigDir,
  pathReadable,
  readGlobalConfig,
  resolveActiveProvider,
} from '../../global-config.js';
import { detectProject } from '../../runtime-session.js';

/**
 * Interactive environment checklist (/doctor). Pure Ink list; every failing row
 * carries an actionable fix line. Secrets are never shown — only whether
 * credential environment variables are set.
 */

interface CheckRow {
  label: string;
  ok: boolean;
  detail?: string;
  fix?: string;
}

interface CheckSection {
  title: string;
  rows: CheckRow[];
}

const CREDENTIAL_PROVIDERS: ReadonlyArray<{ id: string; envs: readonly string[] }> = [
  { id: 'openai', envs: ['OPENAI_API_KEY'] },
  { id: 'anthropic', envs: ['ANTHROPIC_API_KEY'] },
  { id: 'google', envs: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'] },
];

function badge(ok: boolean): string {
  return ok ? '✓' : '!';
}

function buildSections(input: {
  configDir: string;
  dirReadable: boolean;
  configuredProviders: number;
  project: { found: boolean; name?: string };
  active: { provider: string; model?: string; source: string };
}): CheckSection[] {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  const isTTY = Boolean(process.stdout.isTTY);
  const term = process.env.TERM;
  const hasColors = typeof process.stdout.hasColors === 'function' ? process.stdout.hasColors() : isTTY;

  return [
    {
      title: 'Installation',
      rows: [
        nodeMajor >= 20
          ? { label: `node ${process.versions.node}`, ok: true }
          : { label: `node ${process.versions.node}`, ok: false, fix: 'upgrade to Node.js >= 20 (https://nodejs.org)' },
        { label: `agentforge ${VERSION}`, ok: true },
      ],
    },
    {
      title: 'Terminal',
      rows: [
        isTTY
          ? { label: 'TTY attached', ok: true }
          : { label: 'TTY attached', ok: false, detail: '(not a TTY — interactive UI degraded)', fix: 'run inside an interactive terminal' },
        hasColors
          ? { label: 'color support', ok: true }
          : { label: 'color support', ok: false, fix: 'use a terminal with color support or set TERM=xterm-256color' },
        term
          ? { label: `TERM=${term}`, ok: true }
          : { label: 'TERM unset', ok: false, fix: 'export TERM=xterm-256color' },
      ],
    },
    {
      title: 'Configuration',
      rows: [
        input.dirReadable
          ? { label: `global config dir ${input.configDir}`, ok: true }
          : {
              label: `global config dir ${input.configDir}`,
              ok: false,
              fix: existsSync(input.configDir) ? 'check directory permissions' : 'run /connect once to create it (or mkdir ~/.agentforge)',
            },
        input.configuredProviders > 0
          ? { label: `providers configured: ${input.configuredProviders}`, ok: true }
          : { label: 'no providers configured yet', ok: false, fix: 'run /connect to add one' },
        ...CREDENTIAL_PROVIDERS.map((provider) => {
          const set = provider.envs.some((env) => Boolean(process.env[env]));
          return set
            ? { label: `${provider.id}: credential env var set`, ok: true }
            : {
                label: `${provider.id}: none of ${provider.envs.join(' / ')} set`,
                ok: false as const,
                fix: `export ${provider.envs[0]}=<key> or run /connect`,
              };
        }),
      ],
    },
    {
      title: 'Project & session',
      rows: [
        input.project.found
          ? { label: `detected project: ${input.project.name ?? '(unnamed)'}`, ok: true }
          : {
              label: 'detected project: none — global/session mode',
              ok: true,
              detail: 'some commands (/agents, /workflows, /runs) need a project',
              fix: 'run /new to scaffold one here, or /cd <path> to switch',
            },
        { label: `active provider: ${input.active.provider} (via ${input.active.source})${input.active.model ? ` · model: ${input.active.model}` : ''}`, ok: true },
      ],
    },
  ];
}

export function DoctorScreen({ onBack }: { onBack?: () => void } = {}): React.ReactElement {
  const [sections, setSections] = useState<CheckSection[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const configDir = await globalConfigDir();
        const dirExists = existsSync(configDir);
        const dirReadable = dirExists && pathReadable(configDir);
        const config = await readGlobalConfig(configDir);
        const active = await resolveActiveProvider(configDir);
        const project = await detectProject(process.cwd());
        if (!alive) return;
        setSections(buildSections({
          configDir,
          dirReadable,
          configuredProviders: Array.isArray(config.providers) ? config.providers.length : 0,
          project: { found: project.found, name: project.path },
          active: { provider: active.provider ?? '(none — ez-start configures one)', model: active.model, source: active.source },
        }));
      } catch (error) {
        if (alive) {
          setSections([{
            title: 'Error',
            rows: [{ label: `diagnostics failed: ${error instanceof Error ? error.message : String(error)}`, ok: false, fix: 'run agentforge doctor in a terminal for details' }],
          }]);
        }
      }
    })();
    return () => { alive = false; };
  }, []);

  useInput((_value, key) => {
    if (key.escape || key.return) onBack?.();
  });

  if (!sections) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>Running diagnostics…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>AgentForge Doctor</Text>
      <Text dimColor>Esc or Enter returns to chat</Text>
      {sections.map((section) => (
        <Box key={section.title} flexDirection="column" marginTop={1}>
          <Text bold underline>{section.title}</Text>
          {section.rows.map((row) => (
            <Box key={row.label} flexDirection="column">
              <Text color={row.ok ? 'green' : 'yellow'}>{badge(row.ok)} {row.label}{row.detail ? ` ${row.detail}` : ''}</Text>
              {!row.ok && row.fix ? <Text dimColor>{'    '}fix: {row.fix}</Text> : null}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

export default DoctorScreen;
