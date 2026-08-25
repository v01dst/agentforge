import React from 'react';
import { Box, Text, useInput } from 'ink';
import { existsSync } from 'node:fs';
import { VERSION } from '../../commands.js';
import {
  detectProject,
  globalConfigDir,
  pathReadable,
  readGlobalConfig,
  validateProviderConnection,
} from './local-global-config.js';

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

function buildSections(): CheckSection[] {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  const isTTY = Boolean(process.stdout.isTTY);
  const term = process.env.TERM;
  const hasColors = typeof process.stdout.hasColors === 'function' ? process.stdout.hasColors() : isTTY;

  const configDir = globalConfigDir();
  const dirExists = existsSync(configDir);
  const dirReadable = dirExists && pathReadable(configDir);
  const config = readGlobalConfig();
  const configuredProviders = Array.isArray(config.providers) ? config.providers.length : 0;

  const credentialProviders: ReadonlyArray<{ id: string; envs: readonly string[] }> = [
    { id: 'openai', envs: ['OPENAI_API_KEY'] },
    { id: 'anthropic', envs: ['ANTHROPIC_API_KEY'] },
    { id: 'google', envs: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'] },
  ];

  const project = detectProject();

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
        dirReadable
          ? { label: `global config dir ${configDir}`, ok: true }
          : {
              label: `global config dir ${configDir}`,
              ok: false,
              fix: dirExists ? 'check directory permissions' : 'run /connect once to create it (or mkdir ~/.agentforge)',
            },
        configuredProviders > 0
          ? { label: `providers configured: ${configuredProviders}`, ok: true }
          : { label: 'no providers configured yet', ok: false, fix: 'run /connect to add one' },
        ...credentialProviders.map((provider) => {
          const check = validateProviderConnection({ provider: provider.id });
          return check.ready
            ? { label: `${provider.id}: credential env var set`, ok: true }
            : {
                label: `${provider.id}: none of ${provider.envs.join(' / ')} set`,
                ok: false,
                fix: `export ${provider.envs[0]}=<key> or run /connect`,
              };
        }),
      ],
    },
    {
      title: 'Project',
      rows: [
        project.detected
          ? { label: `detected project: ${project.name} (${project.marker})`, ok: true }
          : {
              label: 'detected project: none — session mode',
              ok: false,
              detail: 'some commands (/agents, /workflows, /runs) need a project',
              fix: 'run /new to scaffold one here, or /cd <path> to switch',
            },
      ],
    },
  ];
}

function badge(ok: boolean): string {
  return ok ? '✓' : '!';
}

export function DoctorScreen({ onBack }: { onBack?: () => void }): React.ReactElement {
  const sections = buildSections();
  useInput((_input, key) => {
    if (key.escape || key.return) onBack?.();
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Doctor</Text>
      <Text dimColor>environment checklist · Esc back</Text>
      {sections.map((section) => (
        <Box key={section.title} flexDirection="column" marginTop={1}>
          <Text bold>{section.title}</Text>
          {section.rows.map((row) => (
            <Box key={row.label} flexDirection="column">
              <Text color={row.ok ? 'green' : 'yellow'}>
                {badge(row.ok)} {row.label}
                {row.detail ? <Text dimColor> {row.detail}</Text> : null}
              </Text>
              {!row.ok && row.fix ? <Text dimColor>   fix: {row.fix}</Text> : null}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
