import { Agent, request } from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { createImmutableJsonObjectSchema } from '#domain/index.js';
import { OpenRouterPricingError } from './error.js';
import { parseOpenRouterTariff, type OpenRouterTariff } from './tariff.js';

const positive = z.number().int().positive().safe();
const optionsSchema = createImmutableJsonObjectSchema({ maxDepth: 4, maxNodes: 64, maxCodeUnits: 131_072 }).pipe(z.object({
  endpoint: z.string().min(1).max(4096), modelId: z.string().regex(/^[A-Za-z0-9_.:-]+\/[A-Za-z0-9_.:-]+$/),
  endpointTag: z.string().min(1).max(1024), maxAgeMs: positive, maxResponseBytes: positive.max(1_048_576),
  timeoutMs: positive.max(2_147_483_647), caPem: z.string().min(1).max(65_536).optional(),
}).strict());
export type OpenRouterMetadataFetchOptions = z.infer<typeof optionsSchema>;
export interface OpenRouterMetadataObservation {
  readonly schemaVersion: 1; readonly sourceEndpoint: string; readonly sourceBodyDigest: string;
  readonly receivedBytes: number; readonly observedAtMs: number; readonly tariff: OpenRouterTariff;
}
const observations = new WeakSet<OpenRouterMetadataObservation>();
/** A structural copy/config object is not evidence of this process having completed trusted acquisition. */
export function requireOpenRouterMetadataObservation(input: OpenRouterMetadataObservation): OpenRouterMetadataObservation {
  if (!observations.has(input)) throw new OpenRouterPricingError('INVALID_METADATA');
  return input;
}

/** Dedicated metadata acquisition, outside pure invocation quotation. No implicit auth, proxy, redirect,
 * retries or model execution. The composition caller must authorize the configured origin before calling.
 * Only a completed TLS-verified GET can create this observation; it still is not provider invoice proof.
 */
export async function fetchOpenRouterTariff(input: OpenRouterMetadataFetchOptions, now: () => number,
  signal?: AbortSignal): Promise<OpenRouterMetadataObservation> {
  const parsed = optionsSchema.safeParse(input);
  if (!parsed.success) throw new OpenRouterPricingError('INVALID_METADATA');
  const options = parsed.data, endpoint = metadataEndpoint(options);
  const startedAtMs = now();
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) throw new OpenRouterPricingError('INVALID_METADATA');
  const body = await fetchBody(endpoint, options, signal);
  const observedAtMs = now(), expiresAtMs = startedAtMs + options.maxAgeMs;
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < startedAtMs || !Number.isSafeInteger(expiresAtMs)
    || observedAtMs >= expiresAtMs) throw new OpenRouterPricingError('STALE_TARIFF');
  let metadata: unknown;
  try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw new OpenRouterPricingError('INVALID_METADATA'); }
  const tariff = parseOpenRouterTariff(metadata, { modelId: options.modelId, endpointTag: options.endpointTag,
    fetchedAtMs: startedAtMs, expiresAtMs });
  const observation = Object.freeze({ schemaVersion: 1 as const, sourceEndpoint: endpoint.href,
    sourceBodyDigest: createHash('sha256').update(body).digest('hex'), receivedBytes: body.length, observedAtMs, tariff });
  observations.add(observation); return observation;
}

function metadataEndpoint(options: OpenRouterMetadataFetchOptions): URL {
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint); } catch { throw new OpenRouterPricingError('INVALID_METADATA'); }
  const modelPath = options.modelId.split('/').map(encodeURIComponent).join('/');
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.href !== options.endpoint || options.endpoint.includes('?') || options.endpoint.includes('#')
    || endpoint.pathname !== `/api/v1/models/${modelPath}/endpoints`) throw new OpenRouterPricingError('INVALID_METADATA');
  if (options.caPem !== undefined) {
    try {
      const certificate = new X509Certificate(options.caPem);
      const normalized = (value: string) => value.replace(/\r\n/g, '\n').trimEnd();
      if (normalized(certificate.toString()) !== normalized(options.caPem)) throw new Error();
    } catch { throw new OpenRouterPricingError('INVALID_METADATA'); }
  }
  return endpoint;
}

function fetchBody(endpoint: URL, options: OpenRouterMetadataFetchOptions, outerSignal?: AbortSignal): Promise<Buffer> {
  if (outerSignal?.aborted) return Promise.reject(new OpenRouterPricingError('METADATA_CANCELLED'));
  const timeout = AbortSignal.timeout(options.timeoutMs), signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
  return new Promise((resolve, reject) => {
    const agent = new Agent({ keepAlive: false, proxyEnv: {}, rejectUnauthorized: true,
      ...(options.caPem ? { ca: options.caPem } : {}) });
    let settled = false, bytes = 0;
    const chunks: Buffer[] = [];
    let response: import('node:http').IncomingMessage | undefined;
    const done = (error?: OpenRouterPricingError) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); agent.destroy();
      if (error) { response?.destroy(); req.destroy(); reject(error); }
      else resolve(Buffer.concat(chunks, bytes));
    };
    const abort = () => done(new OpenRouterPricingError(timeout.aborted ? 'METADATA_TIMEOUT' : 'METADATA_CANCELLED'));
    const req = request(endpoint, { method: 'GET', agent, headers: { accept: 'application/json', 'accept-encoding': 'identity' } }, incoming => {
      response = incoming;
      if (incoming.statusCode !== 200 || incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity'
        || incoming.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        done(new OpenRouterPricingError('METADATA_UNAVAILABLE')); return;
      }
      incoming.on('data', (chunk: Buffer) => {
        if (settled) return;
        if (chunk.length > options.maxResponseBytes - bytes) { done(new OpenRouterPricingError('METADATA_TOO_LARGE')); return; }
        chunks.push(Buffer.from(chunk)); bytes += chunk.length;
      });
      incoming.once('end', () => done(incoming.complete ? undefined : new OpenRouterPricingError('METADATA_UNAVAILABLE')));
      incoming.once('error', () => done(new OpenRouterPricingError('METADATA_UNAVAILABLE')));
      incoming.once('aborted', () => done(new OpenRouterPricingError('METADATA_UNAVAILABLE')));
    });
    req.once('error', () => done(new OpenRouterPricingError('METADATA_UNAVAILABLE')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else req.end();
  });
}
