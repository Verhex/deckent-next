import { request as httpRequest } from 'node:http';
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

function loopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** GET one loopback metrics URL. No credentials, no redirects, no retries. Limits come from the caller. */
export function readInferenceMetrics(rawInput: InferenceMetricsReadInput): Promise<InferenceMetricsBody> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) throw new InferenceMetricsError('INFERENCE_METRICS_ENDPOINT_INVALID');
  const input = parsed.data;
  let url: URL;
  try { url = new URL(input.url); } catch { throw new InferenceMetricsError('INFERENCE_METRICS_ENDPOINT_INVALID'); }
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== '') throw new InferenceMetricsError('INFERENCE_METRICS_ENDPOINT_INVALID');
  if (!loopbackHost(url.hostname)) throw new InferenceMetricsError('INFERENCE_METRICS_HOST_DENIED');
  return new Promise<InferenceMetricsBody>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const req = httpRequest(url, { method: 'GET', headers: { accept: 'text/plain' }, timeout: input.timeoutMs }, response => {
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
    req.on('timeout', () => { req.destroy(); finish(() => reject(new InferenceMetricsError('INFERENCE_METRICS_TIMEOUT'))); });
    req.on('error', () => finish(() => reject(new InferenceMetricsError('INFERENCE_METRICS_UNAVAILABLE'))));
    req.end();
  });
}
