import { isIP } from 'node:net';
import { z } from 'zod';
import { defineTool } from './tool.js';

export interface HttpToolOptions {
  allowedHosts?: string[];
  allowedMethods?: string[];
  maxResponseBytes?: number;
  timeoutMs?: number;
  /** Maximum redirect hops followed; every hop is re-validated. Default 3. */
  maxRedirects?: number;
  fetch?: typeof globalThis.fetch;
}

const privateHosts = /^(localhost|.*\.localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|::1$|fc|fd)/i;

function isPrivateIpv4(host: string): boolean {
  const [a = 0, b = 0] = host.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Resolves inet_aton-style numeric IPv4 literals to a dotted quad so they can
 * be privacy-checked: `2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1` all
 * address 127.0.0.1 but `isIP` reports none of them as IPv4.
 */
export function canonicalizeIpv4Host(host: string): string | null {
  if (/^[0-9]+$/.test(host)) {
    const value = Number(host);
    if (!Number.isSafeInteger(value) || value > 0xffffffff) return null;
    return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
  }
  if (/^0[xX][0-9a-fA-F]+$/.test(host)) {
    const value = parseInt(host, 16);
    if (!Number.isSafeInteger(value) || value > 0xffffffff) return null;
    return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
  }
  const parts = host.split('.');
  if (parts.length < 2 || parts.length > 4) return null;
  const numeric: number[] = [];
  for (const part of parts) {
    if (part === '') return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) value = parseInt(part, 8);
    else if (/^[0-9]+$/.test(part)) value = Number(part);
    else return null;
    if (!Number.isSafeInteger(value) || value > 0xffffffff) return null;
    numeric.push(value);
  }
  if (parts.length === 4) {
    if (numeric.some((n) => n > 255)) return null;
    return numeric.join('.');
  }
  // a.b / a.b.c / a.b.c.d shorthand: last segment holds the remaining bytes.
  const last = numeric.pop()!;
  const bytes = numeric.slice();
  if (last > 0xffffffff) return null;
  const tail = [(last >>> 16) & 255, (last >>> 8) & 255, last & 255];
  if (numeric.some((n) => n > 255)) return null;
  const quad = [...bytes, ...tail].slice(0, 4);
  while (quad.length < 4) quad.unshift(0);
  return quad.join('.');
}

function assertSafeUrl(value: string, allowedHosts?: string[]): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ipv4 = isIP(host) === 4 ? host : canonicalizeIpv4Host(host);
  if (privateHosts.test(host) || (ipv4 !== null && isPrivateIpv4(ipv4))) throw new Error('Private network targets are blocked');
  if (allowedHosts?.length && !allowedHosts.some((entry) => host === entry || host.endsWith(`.${entry}`))) throw new Error(`Host ${host} is not allowlisted`);
  return url;
}

export function createHttpTool(options: HttpToolOptions = {}) {
  const methods = options.allowedMethods?.map((method) => method.toUpperCase()) ?? ['GET'];
  const fetcher = options.fetch ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? 3;
  return defineTool({
    name: 'http_request',
    description: 'Send an HTTP request to an allowlisted public endpoint. Redirects are followed manually and re-validated against the same policy.',
    permissions: ['network:http'],
    timeoutMs: options.timeoutMs ?? 15_000,
    input: z.object({ url: z.string().url(), method: z.string().default('GET'), headers: z.record(z.string()).optional(), body: z.string().optional() }),
    output: z.object({ status: z.number(), headers: z.record(z.string()), body: z.string(), truncated: z.boolean() }),
    async execute(input, context) {
      let currentUrl = assertSafeUrl(input.url, options.allowedHosts);
      const method = (input.method ?? 'GET').toUpperCase();
      if (!methods.includes(method)) throw new Error(`HTTP method ${method} is not allowed`);

      let response = await fetcher(currentUrl, { method, headers: input.headers, body: input.body, redirect: 'manual', signal: context.signal });
      // Follow redirects by hand so every hop is re-checked: private-network
      // blocks and host allowlists must not be bypassed via a 30x.
      for (let hop = 0; response.status >= 300 && response.status < 400 && hop < maxRedirects; hop++) {
        const location = response.headers.get('location');
        if (!location) break;
        currentUrl = assertSafeUrl(new URL(location, currentUrl).toString(), options.allowedHosts);
        response = await fetcher(currentUrl, { method, headers: input.headers, redirect: 'manual', signal: context.signal });
      }
      if (response.status >= 300 && response.status < 400) {
        throw new Error(`Redirect chain exceeded ${maxRedirects} hops or pointed at a disallowed target`);
      }

      const text = await response.text();
      const limit = options.maxResponseBytes ?? 1_000_000;
      return { status: response.status, headers: Object.fromEntries(response.headers), body: text.slice(0, limit), truncated: text.length > limit };
    },
  });
}
export const httpRequestTool = createHttpTool();
