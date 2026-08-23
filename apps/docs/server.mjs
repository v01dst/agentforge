import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = new URL('./public', import.meta.url).pathname;
const types = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (request, response) => {
  const requested = normalize(decodeURIComponent(request.url?.split('?')[0] ?? '/')).replace(/^\.\.(\/|\\)/, '');
  let file = join(root, requested === '/' ? 'index.html' : requested);
  try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); } catch { response.writeHead(404); response.end('Not found'); return; }
  response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
});
server.listen(Number(process.env.PORT ?? 3001), '127.0.0.1', () => console.log('AgentForge docs: http://127.0.0.1:' + (process.env.PORT ?? 3001)));
