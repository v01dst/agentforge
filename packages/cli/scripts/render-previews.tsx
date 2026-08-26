/** Render redesigned TUI surfaces to text files for design review. */

// Simulate an interactive terminal BEFORE any ink/chalk import so the full
// wordmark renders instead of the ASCII fallback.
delete process.env.TERM;
(process.stdout as unknown as { isTTY: boolean }).isTTY = true;

const { mkdir, writeFile } = await import('node:fs/promises');
const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { Text } = await import('ink');
const { resolveSkin, setActiveSkin } = await import('../src/ui/skin.js');
const StartupBanner = (await import('../src/ui/shell/StartupBanner.js')).default;
const { Frame } = await import('../src/ui/shell/Frame.js');

const OUT = '/tmp/opencode/previews';
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function frameToFile(name: string, element: React.ReactElement): Promise<void> {
  const instance = render(element);
  await delay(60);
  await writeFile(`${OUT}/${name}.txt`, instance.lastFrame() ?? '');
  instance.unmount();
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  for (const skinName of ['forge', 'midnight', 'paper']) {
    setActiveSkin((await resolveSkin({ name: skinName })).skin);
    await frameToFile(`banner-${skinName}`, React.createElement(StartupBanner, { version: '0.0.1', modeLine: 'GLOBAL SESSION', provider: 'nous', model: 'stealth/ox-alpha' }));
    await frameToFile(`frame-${skinName}`, React.createElement(Frame, {
      mode: { kind: 'project', name: 'demo' },
      version: '0.0.1',
      provider: 'nous',
      model: 'stealth/ox-alpha',
    }, React.createElement(Text, null, 'body area — messages render here')));
  }
  console.log('previews written to /tmp/opencode/previews');
}

await main();
