import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const files: Record<string, string> = {
  'package.json': `{
  "name": "{{name}}",
  "private": true,
  "packageManager": "pnpm@9.15.5",
  "type": "module",
  "scripts": { "run": "agentforge run src/agent.ts", "chat": "agentforge chat src/agent.ts", "start": "agentforge", "typecheck": "tsc --noEmit", "test": "tsx --test test/*.test.ts" },
  "dependencies": { "@agentforge-oss/cli": "^0.0.2", "@agentforge-oss/core": "^0.0.2", "@agentforge-oss/mcp": "^0.0.2", "@agentforge-oss/models": "^0.0.2", "zod": "^3.24.1" },
  "devDependencies": { "@types/node": "^22.10.2", "tsx": "^4.19.2", "typescript": "^5.7.2" }
}
`,
  '.gitignore': `node_modules/
dist/
.env
.env.*
!.env.example
*.log
.agentforge/runs/
`,
  '.env.example': `# Provider credentials. Copy to .env (never commit .env).
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=

# Custom provider module (path or package). See provider.example.mjs.
AGENTFORGE_PROVIDER_MODULE=
# Optional overrides.
AGENTFORGE_PROVIDER=
AGENTFORGE_MODEL=
AGENTFORGE_BASE_URL=
`,
  'agentforge.config.ts': `import type { AgentForgeConfig } from '@agentforge-oss/cli';

const config: AgentForgeConfig = {
  name: '{{name}}',
  entry: 'src/agent.ts',
  providers: [
    { name: 'mock', description: 'Offline deterministic provider' },
    { name: 'custom-provider-module', description: 'Set AGENTFORGE_PROVIDER_MODULE to any ModelProvider package or file URL' },
  ],
  tools: [],
  workflows: [],
};

export default config;
`,
  'src/agent.ts': `import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Agent, type Message, type ModelProvider, type ModelResponse } from '@agentforge-oss/core';
import { createModel } from '@agentforge-oss/models';

const agentName = '{{name}}';
const instructions = 'Be concise and factual.';

const mockModel: ModelProvider = {
  provider: 'mock',
  model: 'agentforge-local',
  async generate(request): Promise<ModelResponse> {
    const input = request.messages.at(-1)?.content ?? '';
    return { id: 'mock-response', content: 'AgentForge received: ' + input, finishReason: 'stop', model: 'agentforge-local', usage: { inputTokens: input.length, outputTokens: input.length, totalTokens: input.length * 2 } };
  },
  async *stream(request) {
    const response = await this.generate(request);
    for (const word of response.content.split(/(\\s+)/)) yield { id: response.id, delta: word };
    yield { id: response.id, delta: '', done: true, usage: response.usage };
  },
};

interface ManagedProvider {
  name: string;
  protocol?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

async function readManagedProviders(): Promise<ManagedProvider[]> {
  try {
    const parsed = JSON.parse(await readFile(join(resolve(process.cwd()), '.agentforge', 'providers.json'), 'utf8')) as { providers?: ManagedProvider[] };
    return Array.isArray(parsed.providers) ? parsed.providers : [];
  } catch {
    return [];
  }
}

/** Resolution order: AGENTFORGE_PROVIDER_MODULE > managed endpoints > builtin providers > mock. */
async function loadModel(): Promise<ModelProvider> {
  const moduleName = process.env.AGENTFORGE_PROVIDER_MODULE;
  if (moduleName) {
    const specifier = moduleName.startsWith('.') || moduleName.startsWith('/') ? pathToFileURL(resolve(process.cwd(), moduleName)).href : moduleName;
    const loaded = await import(specifier) as Record<string, unknown>;
    const options = { provider: process.env.AGENTFORGE_PROVIDER ?? 'custom', model: process.env.AGENTFORGE_MODEL, baseUrl: process.env.AGENTFORGE_BASE_URL };
    type FactoryOptions = typeof options;
    const factory = (typeof loaded.createProvider === 'function' ? loaded.createProvider : typeof loaded.createModel === 'function' ? loaded.createModel : undefined) as ((options: FactoryOptions) => unknown) | undefined;
    const candidate = factory ? await factory(options) : loaded.model ?? loaded.default;
    if (!candidate || typeof candidate !== 'object' || typeof (candidate as { generate?: unknown }).generate !== 'function') throw new Error('Custom provider must export a ModelProvider as default/model, createProvider(options), or createModel(options).');
    return candidate as ModelProvider;
  }
  const wanted = process.env.AGENTFORGE_PROVIDER ?? '';
  if (!wanted || wanted === 'mock') return mockModel;
  const managed = (await readManagedProviders()).find((entry) => entry.name === wanted);
  if (managed) {
    return createModel({
      provider: (managed.protocol && managed.protocol !== 'mock' ? managed.protocol : 'openai-compatible') as 'openai' | 'anthropic' | 'google' | 'gemini' | 'openai-compatible',
      model: process.env.AGENTFORGE_MODEL || managed.model,
      baseUrl: managed.baseUrl,
      apiKey: managed.apiKeyEnv ? process.env[managed.apiKeyEnv] : undefined,
    });
  }
  const known = ['mock', 'openai', 'anthropic', 'google', 'gemini', 'openai-compatible'];
  throw new Error('Unknown provider "' + wanted + '". Add an endpoint with "agentforge providers add ' + wanted + ' ..." (see README), or use one of: ' + known.join(', ') + '.');
}

interface ChatTurn {
  text: string;
  runId?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  durationMs: number;
  meta: Record<string, unknown>;
  /** Present when the model supports streaming; drain it to receive deltas. */
  stream?: AsyncIterable<string>;
}

export interface AgentForgeSession {
  reset(): void;
  send(input: string, options?: { signal?: AbortSignal }): Promise<ChatTurn>;
}

/** Stateful multi-turn session consumed by \`agentforge chat\`. */
export function createSession(): AgentForgeSession {
  const messages: Message[] = [];
  return {
    reset(): void {
      messages.length = 0;
    },
    async send(input: string, options?: { signal?: AbortSignal }): Promise<ChatTurn> {
      const requestSignal = options?.signal;
      const model = await loadModel();
      if (!messages.length) messages.push({ role: 'system', content: instructions });
      messages.push({ role: 'user', content: input });
      const started = Date.now();
      const request = { messages: [...messages], signal: requestSignal };
      const turn: ChatTurn = { text: '', durationMs: 0, meta: {} };
      const finish = (): void => {
        turn.durationMs = Date.now() - started;
        turn.meta = { provider: model.provider, model: model.model ?? '' };
      };
      if (!model.stream) {
        try {
          const response = await model.generate(request);
          turn.text = response.content;
          turn.usage = response.usage;
          turn.runId = response.id;
          messages.push({ role: 'assistant', content: response.content });
        } finally {
          finish();
        }
        return turn;
      }
      const streamFn = model.stream;
      async function* pump(): AsyncGenerator<string> {
        try {
          for await (const chunk of streamFn.call(model, request)) {
            if (typeof chunk.delta === 'string' && chunk.delta) {
              turn.text += chunk.delta;
              yield chunk.delta;
            }
            if (chunk.usage) turn.usage = chunk.usage;
          }
        } finally {
          messages.push({ role: 'assistant', content: turn.text });
          finish();
        }
      }
      turn.stream = pump();
      return turn;
    },
  };
}

/** Build the project agent. Used by one-shot runs, chat sessions, and headless tests.
 *  Plugin and MCP tools registered in .agentforge/extensions.json are merged here. */
export async function createAgent(): Promise<Agent> {
  const model = await loadModel();
  const { pluginContributions } = await import('@agentforge-oss/cli');
  const { projectMcpTools } = await import('@agentforge-oss/cli');
  const { tools: pluginTools, instructions } = await pluginContributions();
  const { tools: mcpTools } = await projectMcpTools();
  return new Agent({ name: agentName, model, instructions: ['Be concise and factual.', ...instructions].join('\n'), tools: [...pluginTools, ...mcpTools] });
}

export async function run(input = 'Hello from AgentForge'): Promise<unknown> {
  return (await createAgent()).run(input);
}
`,
  'plugins/example.ts': `import { z } from 'zod';
import type { AgentForgePlugin } from '@agentforge-oss/cli';

/** Example plugin: contributes one deterministic tool plus a system note. */
const plugin: AgentForgePlugin = {
  name: 'example',
  description: 'Demonstrates the AgentForge plugin contract',
  instructions: 'The example plugin is active.',
  tools: [
    {
      name: 'greet',
      description: 'Return a friendly greeting for a name',
      inputSchema: z.object({ name: z.string() }),
      permissions: [],
      async execute(input: { name: string }) {
        return { text: \`Hello, \${input.name}!\` };
      },
    },
  ],
};

export default plugin;
`,
  '.agentforge/extensions.json': `{
  "plugins": ["./plugins/example.ts"],
  "mcp": { "servers": [] }
}
`,
  'provider.example.mjs': `export default {
  provider: 'custom-example',
  model: 'local-custom-v1',
  async generate(request) {
    const input = request.messages.at(-1)?.content ?? '';
    return { id: 'custom-example', content: 'Custom provider: ' + input, finishReason: 'stop', model: 'local-custom-v1', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  },
};
`,
  'tsconfig.json': `{
  "compilerOptions": { "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true, "esModuleInterop": true, "skipLibCheck": true },
  "include": ["src/**/*.ts", "agentforge.config.ts"]
}
`,
  'test/agent.test.ts': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSession, run } from '../src/agent.js';

test('agent responds through the configured model', async () => {
  const result = await run('ping') as { output?: unknown };
  assert.ok(JSON.stringify(result).includes('ping'));
});

test('session preserves context across turns', async () => {
  const session = createSession();
  async function collect(turn: Awaited<ReturnType<typeof createSession>['send']>): Promise<string> {
    let text = '';
    if (turn.stream) for await (const delta of turn.stream) text += delta;
    return text || turn.text;
  }
  const firstText = await collect(await session.send('hello'));
  assert.ok(firstText.length > 0, 'first turn produced text');
  const second = await session.send('again');
  const secondText = await collect(second);
  assert.ok(secondText.length > 0, 'second turn produced text');
  assert.ok((second.usage?.totalTokens ?? 0) > 0, 'second turn reports token usage');
  assert.equal((second.meta as { provider?: string }).provider, 'mock');
});
`,
  'README.md': `# {{name}}

Generated by AgentForge. Install dependencies, then start an interactive session:

\`\`\`bash
{{install}}
{{start}}
\`\`\`
{{install_note}}
The generated agent uses a deterministic local model so it runs without paid API credentials. Custom providers may export a ModelProvider as \`default\` or \`model\`, or export \`createProvider(options)\` / \`createModel(options)\`. Select one with \`/connect ./provider.mjs\` or \`AGENTFORGE_PROVIDER_MODULE=./provider.mjs\`. Start it with \`{{install}}\` followed by \`{{runner}}\`. For OpenAI, Anthropic, or Gemini, set \`AGENTFORGE_PROVIDER_MODULE=@agentforge-oss/models\`, choose \`AGENTFORGE_PROVIDER\` and \`AGENTFORGE_MODEL\`, and provide the matching API key (see \`.env.example\`); the models package ships adapters for all three.
`,
};

function validName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(name) && name !== '.' && name !== '..';
}

export async function scaffold(name: string, cwd = process.cwd(), force = false, localRoot?: string): Promise<string> {
  const target = name === '.' ? resolve(cwd) : resolve(cwd, name);
  const projectName = name === '.' ? basename(target) : name;
  if (!validName(projectName)) throw new Error('Project name must start with a letter and contain only letters, numbers, dots, underscores, or hyphens.');
  const install = localRoot ? 'pnpm install' : 'npm install';
  const runner = localRoot ? 'pnpm exec agentforge' : 'npx agentforge';
  const installNote = localRoot
    ? `\n> Local-link mode: \`agentforge\`, \`@agentforge-oss/core\` and \`@agentforge-oss/models\` are linked from ${resolve(localRoot)} via \`file:\` dependencies. Run \`pnpm build\` in that repository after changing framework code. Packages are not published yet; this project will not install from a registry.\n`
    : '';
  const replacements: Array<[string, string]> = [
    ['{{name}}', projectName],
    ['{{install}}', install],
    ['{{runner}}', runner],
    ['{{start}}', `${runner} chat`],
    ['{{install_note}}', installNote],
  ];
  await mkdir(target, { recursive: true });
  for (const [relative, template] of Object.entries(files)) {
    const path = join(target, relative);
    await mkdir(dirname(path), { recursive: true });
    const content = replacements.reduce((text, [placeholder, value]) => text.replaceAll(placeholder, value), template);
    if (!force) {
      try { await writeFile(path, '', { flag: 'wx' }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        throw new Error(`Refusing to overwrite ${path}; use --force only for a scaffold you control.`);
      }
      await writeFile(path, content);
    } else {
      await writeFile(path, content);
    }
  }
  if (localRoot) {
    const packagePath = join(target, 'package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      dependencies?: Record<string, string>;
      pnpm?: { overrides?: Record<string, string> };
    };
    const overrides: Record<string, string> = {};
    for (const packageName of ['core', 'cli', 'models']) {
      const spec = `file:${resolve(localRoot, 'packages', packageName)}`;
      const depName = `@agentforge-oss/${packageName}`;
      packageJson.dependencies = { ...(packageJson.dependencies ?? {}) };
      packageJson.dependencies[depName] = spec;
      overrides[depName] = spec;
    }
    // Overrides also rewrite intra-monorepo specs (`workspace:*`) inside the
    // linked packages, which bare `file:` dependencies cannot resolve.
    packageJson.pnpm = { ...(packageJson.pnpm ?? {}), overrides };
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  }
  return target;
}
