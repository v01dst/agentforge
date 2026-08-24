import { useCallback, useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { access, constants, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { scaffold } from '../../project.js';

export interface ScreenProps {
  onDone?: () => void;
  onBack?: () => void;
}

type Step = 'name' | 'mode' | 'confirm' | 'working' | 'done' | 'error';

const STEP_LABELS = ['Creating directories', 'Writing config', 'Writing entrypoint', 'Linking packages', 'Done'] as const;

/** Walk up from `start` looking for the local AgentForge monorepo root (mirrors commands.ts findLocalRepoRoot). */
async function detectLocalRepoRoot(start = process.cwd()): Promise<string | undefined> {
  let current = resolve(start);
  for (;;) {
    try {
      const packageJson = JSON.parse(await readFile(join(current, 'package.json'), 'utf8')) as { name?: string };
      await access(join(current, 'packages', 'core', 'package.json'), constants.R_OK);
      if (packageJson.name === 'agentforge') return current;
    } catch {
      /* keep walking */
    }
    const parent = resolve(current, '..');
    if (parent === current) return undefined;
    current = parent;
  }
}

function StepTimeline({ doneCount }: { doneCount: number }) {
  return (
    <Box flexDirection="column" marginY={1}>
      {STEP_LABELS.map((label, index) => {
        const state = index < doneCount ? 'done' : index === doneCount ? 'active' : 'pending';
        const mark = state === 'done' ? '[✓]' : state === 'active' ? '[▸]' : '[ ]';
        return (
          <Text key={label} color={state === 'done' ? 'green' : state === 'active' ? 'cyan' : undefined} dimColor={state === 'pending'}>
            {mark} {label}
          </Text>
        );
      })}
    </Box>
  );
}

function isValidName(value: string): boolean {
  return /^[^\s]+$/.test(value.trim());
}

export function NewProjectScreen({ onDone, onBack }: ScreenProps) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [modeIndex, setModeIndex] = useState(0);
  const [localRoot, setLocalRoot] = useState<string>();
  const [rootChecked, setRootChecked] = useState(false);
  const [stepsDone, setStepsDone] = useState(0);
  const [targetDir, setTargetDir] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void detectLocalRepoRoot().then((root) => {
      if (!cancelled) {
        setLocalRoot(root);
        setRootChecked(true);
        setModeIndex(root ? 0 : 1);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (step !== 'working') return;
    let cancelled = false;
    void (async () => {
      setStepsDone(0);
      try {
        const target = await scaffold(name.trim(), process.cwd(), false, localRoot);
        for (const count of [1, 2, 3, 4, 5]) {
          if (cancelled) return;
          setStepsDone(count);
        }
        if (cancelled) return;
        setTargetDir(target);
        setStep('done');
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStep('error');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const finish = useCallback(() => {
    if (onDone) onDone();
    else exit();
  }, [onDone, exit]);

  useInput((value, key) => {
    if (key.ctrl && value === 'c') {
      exit();
      return;
    }
    if (key.escape) {
      if (step === 'name') onBack?.();
      else if (step !== 'working') setStep(step === 'mode' || step === 'confirm' ? 'name' : step);
      return;
    }
    if (step === 'name') {
      if (key.return) {
        if (isValidName(name)) setStep('mode');
        else setError('Name must be non-empty and contain no spaces.');
        return;
      }
      if (key.backspace || key.delete) {
        setName((current) => current.slice(0, -1));
        return;
      }
      if (value) setName((current) => current + value);
      return;
    }
    if (step === 'mode') {
      if (key.upArrow) setModeIndex((current) => Math.max(0, current - 1));
      else if (key.downArrow) setModeIndex((current) => Math.min(1, current + 1));
      else if (key.return) {
        if (modeIndex === 0 && !localRoot) {
          setError('No local AgentForge repo found above this directory; choose published mode or run inside a checkout.');
          return;
        }
        setStep('confirm');
      }
      return;
    }
    if (step === 'confirm') {
      if (key.upArrow) setModeIndex((current) => Math.max(0, current - 1));
      else if (key.downArrow) setModeIndex((current) => Math.min(1, current + 1));
      else if (key.return) {
        if (modeIndex === 0) setStep('working');
        else setStep('mode');
      }
      return;
    }
    if (step === 'done' || step === 'error') {
      if (key.return || value === 'r') finish();
    }
  });

  const modeLabel = modeIndex === 0 ? 'local-link' : 'published';

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="magenta">AgentForge · new project</Text>
      </Box>

      {step === 'name' ? (
        <Box flexDirection="column">
          <Text>Project name:</Text>
          <Box borderStyle="round" paddingX={1}>
            <Text color="cyan">❯ </Text>
            <Text>{name}</Text>
            <Text dimColor>▏</Text>
          </Box>
          {!name ? <Text dimColor>suggestion: my-agent</Text> : null}
          {!isValidName(name) && name.length > 0 ? <Text color="red">name must be non-empty with no spaces</Text> : null}
          <Text dimColor>Enter to continue · Esc back · Ctrl+C exit</Text>
        </Box>
      ) : null}

      {step === 'mode' ? (
        <Box flexDirection="column">
          <Text bold>Select mode:</Text>
          {(['local-link', 'published'] as const).map((option, index) => (
            <Box key={option} flexDirection="column">
              <Text color={index === modeIndex ? 'cyan' : undefined}>
                {index === modeIndex ? '❯ ' : '  '}{index === modeIndex ? '‹' : ''}{option}{index === modeIndex ? '›' : ''}
              </Text>
              <Text dimColor>{index === modeIndex ? '› ' : '  '}
                {option === 'local-link'
                  ? `link packages from the local repo checkout${localRoot ? ` (${localRoot})` : ''}`
                  : 'install @agentforge-oss packages from the npm registry'}
              </Text>
            </Box>
          ))}
          {!rootChecked ? <Text dimColor>detecting local repo root…</Text> : null}
          <Text dimColor>↑/↓ select · Enter continue · Esc back</Text>
        </Box>
      ) : null}

      {step === 'confirm' ? (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold>Confirm project</Text>
          <Text>  name:   <Text color="cyan">{name.trim()}</Text></Text>
          <Text>  mode:   <Text color="cyan">{modeLabel}</Text>{localRoot && modeLabel === 'local-link' ? <Text dimColor> ({localRoot})</Text> : null}</Text>
          <Text>  target: <Text color="cyan">{resolve(process.cwd(), name.trim())}</Text></Text>
          <Box marginTop={1} gap={2}>
            <Text color={modeIndex === 0 ? 'cyan' : undefined}>{modeIndex === 0 ? '❯ Execute' : '  Execute'}</Text>
            <Text color={modeIndex === 1 ? 'cyan' : undefined}>{modeIndex === 1 ? '❯ Back' : '  Back'}</Text>
          </Box>
          <Text dimColor>↑/↓ choose · Enter confirm</Text>
        </Box>
      ) : null}

      {step === 'working' ? (
        <Box flexDirection="column">
          <StepTimeline doneCount={stepsDone} />
        </Box>
      ) : null}

      {step === 'done' ? (
        <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
          <Text bold color="green">✔ Project created at {targetDir}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Next steps:</Text>
            <Text>  cd {resolve(targetDir).split('/').pop() ?? targetDir}</Text>
            <Text>  pnpm install</Text>
            <Text>  pnpm exec agentforge chat</Text>
          </Box>
        </Box>
      ) : null}

      {step === 'error' ? (
        <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red">✖ Scaffold failed: {error}</Text>
          <Text dimColor>Enter / R to close.</Text>
        </Box>
      ) : null}

      {error && step !== 'error' ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}
