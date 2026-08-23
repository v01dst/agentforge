import { isIP } from 'node:net';
import { z } from 'zod';
import { defineTool } from './tool.js';

export interface HttpToolOptions { allowedHosts?: string[]; allowedMethods?: string[]; maxResponseBytes?: number; timeoutMs?: number; fetch?: typeof globalThis.fetch; }
const privateHosts = /^(localhost|.*\.localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|::1$|fc|fd)/i;
function assertSafeUrl(value: string, allowedHosts?: string[]): URL { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs are allowed'); const host = url.hostname.replace(/^\[|\]$/g, ''); if (privateHosts.test(host) || (isIP(host) === 4 && isPrivateIpv4(host))) throw new Error('Private network targets are blocked'); if (allowedHosts?.length && !allowedHosts.some((entry) => host === entry || host.endsWith(`.${entry}`))) throw new Error(`Host ${host} is not allowlisted`); return url; }
function isPrivateIpv4(host: string) { const [a = 0, b = 0] = host.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }

export function createHttpTool(options: HttpToolOptions = {}) {
  const methods = options.allowedMethods?.map((method) => method.toUpperCase()) ?? ['GET']; const fetcher = options.fetch ?? globalThis.fetch;
  return defineTool({ name: 'http_request', description: 'Send an HTTP request to an allowlisted public endpoint.', permissions: ['network:http'], timeoutMs: options.timeoutMs ?? 15_000,
    input: z.object({ url: z.string().url(), method: z.string().default('GET'), headers: z.record(z.string()).optional(), body: z.string().optional() }),
    output: z.object({ status: z.number(), headers: z.record(z.string()), body: z.string(), truncated: z.boolean() }),
    async execute(input, context) { const url = assertSafeUrl(input.url, options.allowedHosts); const method = (input.method ?? 'GET').toUpperCase(); if (!methods.includes(method)) throw new Error(`HTTP method ${method} is not allowed`); const response = await fetcher(url, { method, headers: input.headers, body: input.body, signal: context.signal }); const text = await response.text(); const limit = options.maxResponseBytes ?? 1_000_000; return { status: response.status, headers: Object.fromEntries(response.headers), body: text.slice(0, limit), truncated: text.length > limit }; },
  });
}
export const httpRequestTool = createHttpTool();
