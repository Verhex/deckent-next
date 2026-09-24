import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { createModelInvocationResponseEvidence } from '#engine/index.js';
import { splitModelInvocationDelta, type ModelInvocationDelta, type ModelInvocationDeltaSink, type ModelInvocationNativeResponse,
  type ModelInvocationNativeResult, type ModelInvocationRejectionReason } from '#domain/index.js';
import { CredentialEchoGuard } from './credential-guard.js';
import { NativeJsonHttpError, nativeJsonHttpAdapterSchema, parseNativeJsonHttpDefinition, parseNativeJsonHttpLimits,
  type NativeJsonHttpDefinition, type NativeJsonHttpLimits } from './contract.js';

export type NativeJsonHttpRequest = Readonly<{ definition: NativeJsonHttpDefinition; limits: NativeJsonHttpLimits;
  body: string; adapter: Readonly<{ id: string; version: number }> }>;
export type NativeJsonHttpParsed = { response: ModelInvocationNativeResponse } | { reason: ModelInvocationRejectionReason };
/**
 * Incremental parser for a streamed (for example SSE) response. The transport keeps the same credential guards,
 * deadline, redirect and status rules; it retains at most `responseMaxBytes` of wire bytes as evidence while the
 * parser bounds its own assembled result. `push` never throws; `limit` asks the transport to stop reading.
 */
export interface NativeJsonHttpStream {
  readonly accept: string;
  readonly wireMaxBytes: number;
  push(chunk: Buffer): Readonly<{ deltas: readonly ModelInvocationDelta[]; limit: boolean }>;
  finish(): NativeJsonHttpParsed;
}
export interface NativeJsonHttpSendOptions {
  readonly resolveCredential?: (reference: string, signal?: AbortSignal) => Promise<string | undefined>;
  /** Exactly one of parseResponse (whole body) and stream (incremental) is required. */
  readonly parseResponse?: (body: Buffer) => NativeJsonHttpParsed;
  readonly stream?: NativeJsonHttpStream;
  /** Presentation-only observer for stream deltas; failures inside it never change the invocation outcome. */
  readonly onDelta?: ModelInvocationDeltaSink;
}

function statusOf(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}
function rejected(adapter: Readonly<{ id: string; version: number }>, reason: ModelInvocationRejectionReason, status: number | null,
  body: Uint8Array, complete: boolean, observedBytes = body.byteLength): ModelInvocationNativeResult {
  return Object.freeze({ kind: 'rejected' as const, evidence: createModelInvocationResponseEvidence(
    adapter, reason, status, body, complete, observedBytes), });
}
function credentialValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 4_096
    || !/^[A-Za-z0-9\-._~+/]+={0,}$/.test(value)) throw new NativeJsonHttpError('NATIVE_JSON_HTTP_CREDENTIAL_UNAVAILABLE');
  return value;
}
async function resolveBearer(definition: NativeJsonHttpDefinition, options: NativeJsonHttpSendOptions,
  signal: AbortSignal, timeout: AbortSignal): Promise<string | undefined> {
  if (definition.authentication.type === 'none') return undefined;
  const resolver = options.resolveCredential;
  if (!resolver) throw new NativeJsonHttpError('NATIVE_JSON_HTTP_CREDENTIAL_UNAVAILABLE');
  if (signal.aborted) throw new NativeJsonHttpError(timeout.aborted ? 'NATIVE_JSON_HTTP_TIMEOUT' : 'NATIVE_JSON_HTTP_CANCELLED');
  let remove = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(new NativeJsonHttpError(timeout.aborted ? 'NATIVE_JSON_HTTP_TIMEOUT' : 'NATIVE_JSON_HTTP_CANCELLED'));
    signal.addEventListener('abort', abort, { once: true }); remove = () => signal.removeEventListener('abort', abort);
  });
  try {
    const value = await Promise.race([Promise.resolve().then(() => resolver(definition.authentication.type === 'bearer'
      ? definition.authentication.credentialRef : '', signal)), stopped]);
    if (signal.aborted) throw new NativeJsonHttpError(timeout.aborted ? 'NATIVE_JSON_HTTP_TIMEOUT' : 'NATIVE_JSON_HTTP_CANCELLED');
    return credentialValue(value);
  } catch (error) {
    if (error instanceof NativeJsonHttpError) throw error;
    throw new NativeJsonHttpError('NATIVE_JSON_HTTP_CREDENTIAL_UNAVAILABLE');
  } finally { remove(); }
}
function hasCredential(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret);
  if (Array.isArray(value)) return value.some(child => hasCredential(child, secret));
  return value !== null && typeof value === 'object' && Object.entries(value).some(([key, child]) => key.includes(secret) || hasCredential(child, secret));
}

function ownData(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (input === null || typeof input !== 'object') throw new NativeJsonHttpError('NATIVE_JSON_HTTP_REQUEST_INVALID');
  let descriptors: PropertyDescriptorMap, symbols: symbol[], prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input); symbols = Object.getOwnPropertySymbols(input);
    prototype = Object.getPrototypeOf(input);
  } catch { throw new NativeJsonHttpError('NATIVE_JSON_HTTP_REQUEST_INVALID'); }
  const allowed = new Set([...required, ...optional]);
  if ((prototype !== Object.prototype && prototype !== null) || symbols.length > 0
    || Object.keys(descriptors).some(key => !allowed.has(key)) || required.some(key => descriptors[key] === undefined)) {
    throw new NativeJsonHttpError('NATIVE_JSON_HTTP_REQUEST_INVALID');
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!('value' in descriptor) || !descriptor.enumerable) throw new NativeJsonHttpError('NATIVE_JSON_HTTP_REQUEST_INVALID');
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

/** Holds streamed text while it could still be the start of the bearer value, so no prefix of an echo is presented. */
class DeltaGate {
  private readonly pending = { text: '', reasoning: '' };
  private readonly guards: Record<ModelInvocationDelta['kind'], CredentialEchoGuard> | undefined;
  constructor(secret: Buffer | undefined, private readonly sink: ModelInvocationDeltaSink | undefined) {
    this.guards = secret ? { text: new CredentialEchoGuard(secret), reasoning: new CredentialEchoGuard(secret) } : undefined;
  }
  /** Returns false when the text completes an echo of the credential. */
  push(delta: ModelInvocationDelta): boolean {
    const guard = this.guards?.[delta.kind];
    if (guard?.push(Buffer.from(delta.text, 'utf8'))) return false;
    this.pending[delta.kind] += delta.text;
    if (!guard?.hasPartialPrefix()) this.flush(delta.kind);
    return true;
  }
  flush(kind: ModelInvocationDelta['kind']): void {
    const text = this.pending[kind]; this.pending[kind] = '';
    if (!text || !this.sink) return;
    for (const delta of splitModelInvocationDelta(kind, text)) {
      try { this.sink(delta); } catch { /* Presentation failures never change the governed outcome. */ }
    }
  }
}

export async function sendNativeJsonHttp(requestInput: NativeJsonHttpRequest, options: NativeJsonHttpSendOptions,
  outerSignal?: AbortSignal): Promise<ModelInvocationNativeResult> {
  const request = ownData(requestInput, ['definition', 'limits', 'body', 'adapter']);
  const optionValues = ownData(options, [], ['parseResponse', 'resolveCredential', 'stream', 'onDelta']);
  const definition = parseNativeJsonHttpDefinition(request.definition);
  const limits = parseNativeJsonHttpLimits(request.limits);
  const adapter = nativeJsonHttpAdapterSchema.safeParse(ownData(request.adapter, ['id', 'version']));
  const body = request.body, parseResponse = optionValues.parseResponse, resolveCredential = optionValues.resolveCredential;
  const stream = optionValues.stream as NativeJsonHttpStream | undefined, onDelta = optionValues.onDelta;
  if (!adapter.success || typeof body !== 'string' || (parseResponse === undefined) === (stream === undefined)
    || (parseResponse !== undefined && typeof parseResponse !== 'function')
    || (stream !== undefined && (typeof stream !== 'object' || stream === null || typeof stream.push !== 'function'
      || typeof stream.finish !== 'function' || typeof stream.accept !== 'string'
      || !Number.isSafeInteger(stream.wireMaxBytes) || stream.wireMaxBytes < limits.responseMaxBytes))
    || (onDelta !== undefined && (typeof onDelta !== 'function' || stream === undefined))
    || (resolveCredential !== undefined && typeof resolveCredential !== 'function')) {
    throw new NativeJsonHttpError('NATIVE_JSON_HTTP_REQUEST_INVALID');
  }
  const stableOptions = Object.freeze({ ...(parseResponse ? { parseResponse: parseResponse as NonNullable<NativeJsonHttpSendOptions['parseResponse']> } : {}),
    ...(resolveCredential ? { resolveCredential: resolveCredential as NonNullable<NativeJsonHttpSendOptions['resolveCredential']> } : {}) });
  if (Buffer.byteLength(body, 'utf8') > limits.requestMaxBytes) throw new NativeJsonHttpError('NATIVE_JSON_HTTP_REQUEST_TOO_LARGE');
  if (outerSignal?.aborted) throw new NativeJsonHttpError('NATIVE_JSON_HTTP_CANCELLED');
  const timeout = AbortSignal.timeout(limits.timeoutMs), signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
  const credential = await resolveBearer(definition, stableOptions, signal, timeout);
  if (signal.aborted) throw new NativeJsonHttpError(timeout.aborted ? 'NATIVE_JSON_HTTP_TIMEOUT' : 'NATIVE_JSON_HTTP_CANCELLED');
  const secret = credential === undefined ? undefined : Buffer.from(credential, 'utf8');
  const endpoint = new URL(definition.endpoint);
  const gate = stream ? new DeltaGate(secret, onDelta as ModelInvocationDeltaSink | undefined) : undefined;
  return new Promise((resolve, rejectPromise) => {
    const secure = endpoint.protocol === 'https:';
    const agent = secure ? new HttpsAgent({ keepAlive: false, proxyEnv: {}, rejectUnauthorized: true,
      ...(definition.tls ? { ca: definition.tls.caPem } : {}) }) : new HttpAgent({ keepAlive: false, proxyEnv: {} });
    let settled = false; let response: import('node:http').IncomingMessage | undefined;
    const retained: Buffer[] = []; let retainedBytes = 0; let observedBytes = 0; let status: number | null = null;
    const wireCredential = secret ? new CredentialEchoGuard(secret) : undefined;
    const retainedCredential = secret ? new CredentialEchoGuard(secret) : undefined;
    const retainedBody = () => Buffer.concat(retained);
    const done = (error?: NativeJsonHttpError, value?: ModelInvocationNativeResult) => {
      if (settled) return; settled = true; signal.removeEventListener('abort', abort);
      agent.destroy();
      if (error) { response?.destroy(); req.destroy(); rejectPromise(error); } else if (value) resolve(value);
    };
    const settleRejected = (reasonInput: ModelInvocationRejectionReason, completeInput: boolean) => {
      if (settled) return;
      if (retainedCredential?.hasPartialPrefix()) { done(new NativeJsonHttpError('NATIVE_JSON_HTTP_CREDENTIAL_ECHO')); return; }
      // Only a fully retained body is complete evidence; a stream past the retention cap is bounded, not complete.
      const complete = completeInput && observedBytes === retainedBytes;
      const reason = complete || reasonInput === 'interrupted' ? reasonInput : 'response-limit';
      try { done(undefined, rejected(adapter.data, reason, status, retainedBody(), complete, observedBytes)); }
      catch { done(new NativeJsonHttpError('NATIVE_JSON_HTTP_RESPONSE_TOO_LARGE')); }
    };
    const interrupted = (error: NativeJsonHttpError) => {
      if (settled) return;
      if (retainedCredential?.hasPartialPrefix()) done(new NativeJsonHttpError('NATIVE_JSON_HTTP_CREDENTIAL_ECHO'));
      else if (response && status !== null) settleRejected('interrupted', false);
      else done(error);
    };
    const abort = () => interrupted(new NativeJsonHttpError(timeout.aborted ? 'NATIVE_JSON_HTTP_TIMEOUT' : 'NATIVE_JSON_HTTP_CANCELLED'));
    const send = secure ? httpsRequest : httpRequest;
    const req = send(endpoint, { agent, method: 'POST', headers: { 'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body, 'utf8')), accept: stream ? stream.accept : 'application/json',
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }) } }, incoming => {
      response = incoming; const currentStatus = statusOf(incoming.statusCode); status = currentStatus;
      if (currentStatus === null) { done(new NativeJsonHttpError('NATIVE_JSON_HTTP_TRANSPORT_UNKNOWN')); return; }
      // Only a successful streamed body is parsed incrementally. Its wire bound replaces the retention cap, which then
      // bounds evidence only; the parser bounds the assembled result. Error and redirect bodies stay evidence only.
      const streaming = stream !== undefined && currentStatus >= 200 && currentStatus < 300;
      const wireMaxBytes = streaming ? stream.wireMaxBytes : limits.responseMaxBytes;
      incoming.on('data', (chunk: Buffer) => {
        if (settled) return;
        observedBytes += chunk.byteLength;
        const remaining = limits.responseMaxBytes - retainedBytes;
        if (remaining > 0) {
          const prefix = chunk.subarray(0, remaining); retained.push(prefix); retainedBytes += prefix.byteLength;
          if (retainedCredential?.push(prefix)) { done(new NativeJsonHttpError('NATIVE_JSON_HTTP_CREDENTIAL_ECHO')); return; }
        }
        if (wireCredential?.push(chunk)) { done(new NativeJsonHttpError('NATIVE_JSON_HTTP_CREDENTIAL_ECHO')); return; }
        if (observedBytes > wireMaxBytes) { settleRejected('response-limit', false); return; }
        if (!streaming) return;
        const parsed = stream.push(chunk);
        for (const delta of parsed.deltas) {
          if (!gate!.push(delta)) { done(new NativeJsonHttpError('NATIVE_JSON_HTTP_CREDENTIAL_ECHO')); return; }
        }
        if (parsed.limit) settleRejected('response-limit', false);
      });
      incoming.on('error', () => { if (!settled) interrupted(new NativeJsonHttpError('NATIVE_JSON_HTTP_TRANSPORT_UNKNOWN')); });
      incoming.on('end', () => {
        if (settled) return;
        try {
          if (credential && !streaming) {
            let decoded: unknown;
            try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(retainedBody())); } catch { decoded = undefined; }
            if (decoded !== undefined && hasCredential(decoded, credential)) throw new NativeJsonHttpError('NATIVE_JSON_HTTP_CREDENTIAL_ECHO');
          }
          if (currentStatus >= 300 && currentStatus < 400) { settleRejected('redirect', true); return; }
          if (currentStatus < 200 || currentStatus >= 300) { settleRejected('http-status', true); return; }
          const parsed = streaming ? stream.finish() : stableOptions.parseResponse!(retainedBody());
          if ('reason' in parsed) { settleRejected(parsed.reason, parsed.reason !== 'interrupted'); return; }
          if (credential && streaming && hasCredential(parsed.response, credential)) throw new NativeJsonHttpError('NATIVE_JSON_HTTP_CREDENTIAL_ECHO');
          gate?.flush('reasoning'); gate?.flush('text');
          done(undefined, parsed.response);
        } catch (error) {
          done(error instanceof NativeJsonHttpError ? error : new NativeJsonHttpError('NATIVE_JSON_HTTP_RESPONSE_TOO_LARGE'));
        }
      });
    });
    req.on('error', () => { if (!settled) interrupted(new NativeJsonHttpError('NATIVE_JSON_HTTP_TRANSPORT_UNKNOWN')); });
    signal.addEventListener('abort', abort, { once: true }); req.end(body);
  });
}
