import { expect, it, vi } from 'vitest';
import { sendNativeJsonHttp } from '#adapters/core/provider-http-json/index.js';
import { providerSpendRejectionHasNoCharge } from '#engine/index.js';

// A POST constructor is a forbidden effect in these pre-POST cases; no socket or provider is contacted.
const requests = vi.hoisted(() => ({ post: vi.fn(() => { throw new Error('UNEXPECTED_POST'); }) }));
vi.mock('node:http', async importOriginal => ({ ...await importOriginal<typeof import('node:http')>(), request: requests.post }));
vi.mock('node:https', async importOriginal => ({ ...await importOriginal<typeof import('node:https')>(), request: requests.post }));
const adapter = { id: 'fixture', version: 1 };
const request = { definition: { endpoint: 'https://fixture.invalid/chat', authentication: { type: 'bearer' as const, credentialRef: 'FIXTURE_KEY' } },
  limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 50 }, adapter, body: '{}' };
const response = { schemaVersion: 1 as const, native: {}, usage: null };
const parseResponse = () => ({ response });

it.each(['missing', 'invalid', 'resolver-error', 'lookup-timeout', 'cancel-before', 'cancel-during'] as const)('certifies %s before constructing a POST; settlement can release this evidence', async kind => {
  requests.post.mockClear(); const controller = new AbortController(); if (kind === 'cancel-before') controller.abort();
  const resolver = async () => {
    if (kind === 'invalid') return 'not a bearer';
    if (kind === 'resolver-error') throw new Error('secret-resolver-details');
    if (kind === 'lookup-timeout') return new Promise<string>(() => {});
    if (kind === 'cancel-during') { controller.abort(); return 'late-secret'; }
    return undefined;
  };
  const result = await sendNativeJsonHttp(request, { resolveCredential: resolver, parseResponse }, controller.signal);
  expect(result).toMatchObject({ kind: 'rejected', evidence: { reason: 'not-sent', httpStatus: null, body: { complete: true, byteLength: 0, observedBytes: 0 } } });
  expect(requests.post).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('secret');
  if (!('kind' in result)) throw new Error('expected no-send rejection');
  expect(providerSpendRejectionHasNoCharge({ state: 'rejected', evidence: result.evidence, observedAtMs: 1 } as never)).toBe(true);
});

it('certifies a request-byte refusal before POST but never certifies a thrown post-construction failure', async () => {
  requests.post.mockClear();
  const oversized = await sendNativeJsonHttp({ ...request, body: 'x'.repeat(4097) }, { parseResponse });
  expect(oversized).toMatchObject({ kind: 'rejected', evidence: { reason: 'not-sent' } }); expect(requests.post).not.toHaveBeenCalled();
  await expect(sendNativeJsonHttp({ ...request, definition: { ...request.definition, authentication: { type: 'none' } } }, { parseResponse })).rejects.toThrow();
  expect(requests.post).toHaveBeenCalledTimes(1);
});
