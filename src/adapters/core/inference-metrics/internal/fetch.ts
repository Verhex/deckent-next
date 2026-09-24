import { request as httpRequest, type ClientRequest } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import { z } from 'zod';

export type InferenceMetricsErrorCode = 'INFERENCE_METRICS_ENDPOINT_INVALID' | 'INFERENCE_METRICS_HOST_DENIED'
  | 'INFERENCE_METRICS_TIMEOUT' | 'INFERENCE_METRICS_STATUS' | 'INFERENCE_METRICS_REDIRECT'
  | 'INFERENCE_METRICS_RESPONSE_TOO_LARGE' | 'INFERENCE_METRICS_UNAVAILABLE';

/** Bounded failure evidence: never carries response bodies, headers or redirect targets. */
export class InferenceMetricsError extends Error {
  constructor(readonly code: InferenceMetricsErrorCode, readonly status?: number) { super(code); this.name = 'InferenceMetricsError'; }
}

const inputSchema = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().positive().max(2_147_483_647),
  responseMaxBytes: z.number().int().positive().safe(),
}).strict();
export type InferenceMetricsReadInput = z.infer<typeof inputSchema>;
export type InferenceMetricsBody = Readonly<{ body: string }>;

const unbracket = (hostname: string) => hostname.replace(/^\[|\]$/g, '');
/** Real address validation, not a pattern: 127.0.0.0/8 in dotted-quad form or exactly ::1. Shorthand ('127.1'),
 * out-of-range octets, IPv4-mapped IPv6 and zone ids are refused (Astra 2054 R5). */
function loopbackAddress(address: string): boolean {
  return (isIPv4(address) && address.startsWith('127.')) || (isIPv6(address) && address === '::1');
}
function loopbackHost(hostname: string): boolean { const host = unbracket(hostname); return host === 'localhost' || loopbackAddress(host); }
export type InferenceMetricsLookup = (hostname: string) => Promise<readonly { readonly address: string }[]>;
const systemLookup: InferenceMetricsLookup = hostname => lookup(hostname, { all: true, verbatim: true });

/** A literal loopback address is used as is; the name `localhost` is resolved and every answer must be loopback before
 * any connection, and connections go only to those checked addresses (Astra 2045: a name check is not a target check). */
async function checkedAddresses(hostname: string, resolve: InferenceMetricsLookup): Promise<readonly string[]> {
  const host = unbracket(hostname);
  if (host !== 'localhost') return [host];
  let answers: readonly { readonly address: string }[];
  try { answers = await resolve(host); } catch { throw new InferenceMetricsError('INFERENCE_METRICS_UNAVAILABLE'); }
  if (!answers.length || answers.some(answer => !loopbackAddress(answer.address))) throw new InferenceMetricsError('INFERENCE_METRICS_HOST_DENIED');
  return answers.map(answer => answer.address);
}

/** GET one loopback metrics URL. No credentials, no redirects, no retries beyond the next checked address after a
 * connection failure. Limits come from the caller. */
export function readInferenceMetrics(rawInput: InferenceMetricsReadInput, resolveHost: InferenceMetricsLookup = systemLookup): Promise<InferenceMetricsBody> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) throw new InferenceMetricsError('INFERENCE_METRICS_ENDPOINT_INVALID');
  const input = parsed.data;
  let url: URL;
  try { url = new URL(input.url); } catch { throw new InferenceMetricsError('INFERENCE_METRICS_ENDPOINT_INVALID'); }
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== '') throw new InferenceMetricsError('INFERENCE_METRICS_ENDPOINT_INVALID');
  if (!loopbackHost(url.hostname)) throw new InferenceMetricsError('INFERENCE_METRICS_HOST_DENIED');
  return new Promise<InferenceMetricsBody>((resolve, reject) => {
    let settled = false;
    let req: ClientRequest | undefined;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(deadline); fn(); } };
    // The request `timeout` only bounds socket idleness; this deadline bounds the whole read, name resolution included,
    // across every address (Astra 2054 R5: a hanging lookup must not outlive timeoutMs).
    const deadline = setTimeout(() => { req?.destroy(); finish(() => reject(new InferenceMetricsError('INFERENCE_METRICS_TIMEOUT'))); }, input.timeoutMs);
    // A resolver may list ::1 before 127.0.0.1 while the server listens on one family only; a connection failure
    // before any response moves to the next checked address, never to an unchecked one.
    const attempt = (addresses: readonly string[], index: number) => {
      const address = addresses[index]!;
      let responded = false;
      const current = httpRequest({ host: address, family: address.includes(':') ? 6 : 4, port: url.port || 80, path: `${url.pathname}${url.search}`, method: 'GET',
        headers: { accept: 'text/plain', host: url.host }, timeout: input.timeoutMs }, response => {
        responded = true;
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          finish(() => reject(new InferenceMetricsError('INFERENCE_METRICS_REDIRECT', status)));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > input.responseMaxBytes) {
            response.destroy();
            finish(() => reject(new InferenceMetricsError('INFERENCE_METRICS_RESPONSE_TOO_LARGE')));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', () => finish(() => reject(new InferenceMetricsError('INFERENCE_METRICS_UNAVAILABLE'))));
        response.on('end', () => finish(() => {
          if (status !== 200) { reject(new InferenceMetricsError('INFERENCE_METRICS_STATUS', status)); return; }
          resolve(Object.freeze({ body: Buffer.concat(chunks).toString('utf8') }));
        }));
      });
      req = current;
      current.on('timeout', () => { current.destroy(); finish(() => reject(new InferenceMetricsError('INFERENCE_METRICS_TIMEOUT'))); });
      current.on('error', () => {
        if (!settled && !responded && index + 1 < addresses.length) { attempt(addresses, index + 1); return; }
        finish(() => reject(new InferenceMetricsError('INFERENCE_METRICS_UNAVAILABLE')));
      });
      current.end();
    };
    // A lookup that answers after the deadline (or any other settlement) starts no connection.
    checkedAddresses(url.hostname, resolveHost).then(addresses => { if (!settled) attempt(addresses, 0); },
      (error: unknown) => finish(() => reject(error)));
  });
}
