import { test } from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { ChatHome } from '/root/mura/packages/cli/src/ui/shell/ChatHome.js';
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
test('dump', async () => {
  const runner = async function* () { yield { text: 'ok' }; };
  const instance = render(React.createElement(ChatHome, { runner, commands: [], autoResume: false, provider: 'zai', model: 'glm-5.3' }));
  await delay(40);
  console.log('====DUMP====');
  console.log(instance.lastFrame() ?? '');
  instance.unmount();
});
