import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import { EffectTargetError, type EffectApplyRequest, type EffectTarget } from '#engine/index.js';
import type { EffectTargetRef } from '#domain/index.js';

const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
/** One configured record service. `http` is accepted only on loopback; credentials are not supported in this slice. */
export const httpConditionalEffectOptionsSchema = z.object({
  kind: z.string().min(1).max(64), baseUrl: z.string().url(), timeoutMs: z.number().int().positive().max(120_000),
  responseMaxBytes: z.number().int().positive().max(16_777_216), idempotencyLookup: z.boolean(),
}).strict().superRefine((value, context) => {
  const url = new URL(value.baseUrl);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback.has(url.hostname)))) {
    context.addIssue({ code: 'custom', message: 'EFFECT_TARGET_URL_INVALID' });
  }
}).readonly();
export type HttpConditionalEffectOptions = z.infer<typeof httpConditionalEffectOptionsSchema>;
type Response = { readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: Buffer };

/** Generic conditional-write record service (documented REST shape, not a vendor adapter):
 * GET {base}/records/{id} → ETag = version; POST {base}/records/{id}/operations with If-Match + Idempotency-Key;
 * GET {base}/idempotency/{key} → {status:'applied', version} or 404. ERP adapters implement EffectTarget with their own protocol. */
export class HttpConditionalEffectTarget implements EffectTarget {
  readonly kind: string;
  private readonly options: HttpConditionalEffectOptions;
  constructor(input: unknown) { this.options = httpConditionalEffectOptionsSchema.parse(input); this.kind = this.options.kind; }
  private url(path: string) { return new URL(`${this.options.baseUrl.replace(/\/+$/, '')}/${path}`); }
  private send(method: 'GET' | 'POST', url: URL, headers: Record<string, string>, body?: string): Promise<Response> {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
      const req = send(url, { method, headers: { accept: 'application/json', ...headers }, timeout: this.options.timeoutMs }, response => {
        const chunks: Buffer[] = []; let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > this.options.responseMaxBytes) { response.destroy(); finish(() => reject(new Error('EFFECT_TARGET_RESPONSE_TOO_LARGE'))); return; }
          chunks.push(chunk);
        });
        response.on('error', error => finish(() => reject(error)));
        response.on('end', () => finish(() => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) })));
      });
      req.on('timeout', () => { req.destroy(); finish(() => reject(new Error('EFFECT_TARGET_TIMEOUT'))); });
      req.on('error', error => finish(() => reject(error)));
      req.end(body);
    });
  }
  private version(headers: IncomingHttpHeaders) {
    const etag = headers.etag;
    return typeof etag === 'string' && etag.length > 0 && etag.length <= 256 ? etag : null;
  }
  async observe(target: EffectTargetRef) {
    let response: Response;
    try { response = await this.send('GET', this.url(`records/${encodeURIComponent(target.id)}`), {}); }
    catch (error) { throw new EffectTargetError('EFFECT_TARGET_UNKNOWN', { cause: error }); }
    if (response.status === 404) return { version: null };
    if (response.status !== 200) throw new EffectTargetError('EFFECT_TARGET_UNKNOWN');
    return { version: this.version(response.headers) };
  }
  async apply(request: EffectApplyRequest) {
    const body = JSON.stringify({ operation: request.operation, input: request.input });
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'idempotency-key': request.idempotencyKey };
    if (request.expectedVersion !== null) headers['if-match'] = request.expectedVersion;
    let response: Response;
    // Any transport failure may have reached the service: the outcome is unknown, never assumed absent.
    try { response = await this.send('POST', this.url(`records/${encodeURIComponent(request.target.id)}/operations`), headers, body); }
    catch (error) { throw new EffectTargetError('EFFECT_TARGET_UNKNOWN', { cause: error }); }
    if (response.status >= 200 && response.status < 300) return { version: this.version(response.headers) };
    if (response.status === 412) throw new EffectTargetError('EFFECT_TARGET_PRECONDITION');
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    throw new EffectTargetError('EFFECT_TARGET_UNKNOWN');
  }
  async lookup(_target: EffectTargetRef, idempotencyKey: string) {
    if (!this.options.idempotencyLookup) return null;
    const response = await this.send('GET', this.url(`idempotency/${encodeURIComponent(idempotencyKey)}`), {});
    if (response.status === 404) return { status: 'absent' as const };
    if (response.status !== 200) return null;
    const parsed = z.object({ status: z.literal('applied'), version: z.string().min(1).max(256).nullable() }).strict().safeParse(JSON.parse(response.body.toString('utf8')));
    return parsed.success ? { status: 'applied' as const, version: parsed.data.version } : null;
  }
}
