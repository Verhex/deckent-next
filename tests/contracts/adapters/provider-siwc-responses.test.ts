import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as http from '#adapters/core/provider-http-json/index.js';
import { createSiwcResponsesPort, siwcResponsesBody, siwcRejection, parseSiwcModels, SIWC_INFERENCE, SIWC_REQUEST_RULES, siwcResponsesDefinitionSchema } from '#adapters/core/provider-siwc/index.js';
import { headlessRejectionBodySchema, readHeadlessRejection } from '#domain/index.js';
import { createModelInvocationResponseEvidence } from '#engine/index.js';
import { responsesFixture, responsesFinal, responsesCreated, callItem, event } from '../support/openai-responses.js';

const TOKEN = 'fixture-siwc-access-canary', ID = '314bd19c-07b4-416e-a222-314af4dc8e2a', NOW = 1800000000000;
afterEach(() => { vi.restoreAllMocks(); });
function fixture() {
  const f = responsesFixture(SIWC_INFERENCE.endpoint);
  const profile = { ...f.profile, schemaVersion: 2 as const, billingAxis: 'subscription' as const,
    adapter: { ...SIWC_INFERENCE.adapter, definition: { schemaVersion: 1, connectionId: ID, owner: { issuer: 'os-fixture', subject: 'person' },
      rawUse: 'person', delegatedUse: null, apiContinuation: null } } };
  const lease = vi.fn(async () => ({ accessToken: TOKEN, expiresAtMs: NOW + 10000 }));
  return { ...f, profile, lease, port: createSiwcResponsesPort({ now: () => NOW, lease }) };
}
function transport(body: string, status = 200) {
  return vi.spyOn(http, 'sendNativeJsonHttp').mockImplementation(async (request, options, signal) => {
    expect(request.definition.endpoint).toBe(SIWC_INFERENCE.endpoint);
    expect(await options.resolveCredential!('SIWC_ACCESS_TOKEN', signal)).toBe(TOKEN);
    expect(JSON.stringify(request)).not.toContain(TOKEN);
    const reject = (reason: 'http-status' | 'invalid-response' | 'model-mismatch' | 'response-limit' | 'interrupted') => ({ kind: 'rejected' as const,
      evidence: createModelInvocationResponseEvidence(request.adapter, reason, status, Buffer.from(body), reason !== 'interrupted') });
    if (status !== 200) return reject('http-status');
    const pushed = options.stream!.push(Buffer.from(body));
    if (pushed.rejected) return reject(pushed.rejected);
    if (pushed.limit) return reject('response-limit');
    const parsed = options.stream!.finish(); return 'reason' in parsed ? reject(parsed.reason) : parsed.response;
  });
}
it('encodes the allowlisted SIWC dialect and complete tool history; unsupported explicit controls fail closed', () => {
  const f = fixture(), request = { ...f.request, messages: [{ role: 'system', content: 'Be precise.' }, ...f.request.messages,
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'value' }] };
  const body = siwcResponsesBody(request);
  expect(body).toMatchObject({ model: f.request.model, store: false, stream: true, instructions: 'Be precise.',
    tools: [{ type: 'namespace', name: 'deckent', tools: [{ type: 'function', name: 'read_file' }] }] });
  expect(body['input']).toEqual([{ role: 'user', content: 'read a.ts' },
    { type: 'function_call', call_id: 'call_1', name: 'read_file', namespace: 'deckent', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'value' }]);
  expect(Object.keys(body).sort()).toEqual(['input', 'instructions', 'model', 'store', 'stream', 'tools']);
  for (const name of ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt',
    'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id', 'service_tier']) {
    expect(SIWC_REQUEST_RULES.forbiddenFields).toContain(name); expect(body).not.toHaveProperty(name);
  }
  expect(SIWC_REQUEST_RULES.unverifiedFields).toEqual(['reasoning', 'tool_choice', 'include']);
  expect(() => siwcResponsesBody({ ...request, reasoning_effort: 'high' })).toThrow();
  expect(() => siwcResponsesBody({ ...request, tool_choice: 'required' })).toThrow();
  expect(() => siwcResponsesBody({ ...request, service_tier: 'priority' })).toThrow();
  expect(() => siwcResponsesBody({ ...request, response_format: { type: 'json_object' } })).toThrow('OPENAI_CHAT_REQUEST_INVALID');
  expect(siwcResponsesBody({ ...request, tool_choice: 'none' })).not.toHaveProperty('tools');
});
it('parses only visible models[] entries in server order, preserving slugs and rejecting malformed/duplicate/oversized input', () => {
  expect(parseSiwcModels({ models: [{ slug: 'second', display_name: 'Second', visibility: 'list' },
    { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' }, { slug: 'first', display_name: 'First', visibility: 'list' }] }))
    .toEqual([{ slug: 'second', display_name: 'Second' }, { slug: 'first', display_name: 'First' }]);
  expect(() => parseSiwcModels({ data: [] })).toThrow();
  expect(() => parseSiwcModels({ models: [{ slug: 'one', display_name: 'One' }] })).toThrow();
  expect(() => parseSiwcModels({ models: Array(2).fill({ slug: 'one', display_name: 'One', visibility: 'list' }) })).toThrow();
  expect(() => parseSiwcModels({ models: [], extra: 'x'.repeat(SIWC_INFERENCE.modelsMaxBytes) })).toThrow();
});
it('is a subscription-only, single-send host lease port; only completed settles and a local unsent token cap cannot reject valid usage', async () => {
  const sent = transport(event('response.completed', 1, { response: responsesFinal() })), f = fixture();
  expect(f.port.billingAxis).toBe('subscription');
  const prepared = await f.port.prepare(f.profile, f.definition, { ...f.request, max_completion_tokens: 1 } as never);
  expect(f.lease).not.toHaveBeenCalled(); expect(f.port.responseBytesUpperBound!(prepared)).toBeGreaterThan(0n);
  const result = await f.port.send(prepared);
  expect('kind' in result).toBe(false); expect(JSON.stringify(result)).not.toContain(TOKEN); expect(f.lease).toHaveBeenCalledTimes(1);
  expect(JSON.parse(sent.mock.calls[0]![0].body)).not.toHaveProperty('max_output_tokens');
  await expect(f.port.send(prepared)).rejects.toThrow();
  await expect(f.port.prepare({ ...f.profile, billingAxis: 'metered' }, f.definition, f.request as never)).rejects.toThrow();
  await expect(f.port.prepare(f.profile, f.definition, { ...f.request, model: 'different' } as never)).rejects.toThrow();
  sent.mockRestore();
  transport(event('response.incomplete', 1, { response: responsesFinal([], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }) }));
  expect(await f.port.send(await f.port.prepare(f.profile, f.definition, f.request as never))).toMatchObject({ kind: 'rejected' });
});
it('maps HTTP and streamed plan refusals to versioned machine-only evidence; unknown/incomplete streams never become success or a guessed quota', async () => {
  const f = fixture(), ids = new Set([SIWC_INFERENCE.adapter.id]);
  const legacyReader = z.object({ schemaVersion: z.literal(1), refusal: z.enum(['quota', 'login-required']), status: z.number().nullable().optional(), resetsAtMs: z.number().nullable().optional() }).strict();
  const run = async (body: string, status: number) => {
    const sent = transport(body, status);
    try { return await f.port.send(await f.port.prepare(f.profile, f.definition, f.request as never)); } finally { sent.mockRestore(); }
  };
  for (const [code, status, expected] of [['subscription_sharing_usage_limit_exceeded', 429, 'quota'], ['subscription_sharing_usage_unavailable', 503, 'usage-unavailable'],
    ['subscription_sharing_user_unavailable', 503, 'service-unavailable'],
    ['subscription_sharing_user_not_eligible', 403, 'plan-unavailable'], ['subscription_sharing_invalid_user', 401, 'login-required']] as const) {
    const result = await run(JSON.stringify({ error: { code, message: 'private-provider-prose' } }), status);
    expect(result).toMatchObject({ kind: 'rejected' }); if (!('kind' in result)) throw new Error('expected rejection');
    const body = readHeadlessRejection(result.evidence, ids)!;
    expect(body).toMatchObject({ schemaVersion: expected === 'usage-unavailable' || expected === 'service-unavailable' ? 3 : expected === 'plan-unavailable' ? 2 : 1, refusal: expected });
    if (body.refusal === 'quota') expect(body.resetsAtMs).toBeNull();
    if (body.schemaVersion === 3) {
      expect(body).toMatchObject({ code, status }); expect(body).not.toHaveProperty('resetsAtMs');
      expect(legacyReader.safeParse(body).success).toBe(false);
      const v2Reader = z.object({ schemaVersion: z.literal(2), refusal: z.literal('plan-unavailable'), status: z.number().nullable() }).strict();
      expect(v2Reader.safeParse(body).success).toBe(false);
    }
    if (expected === 'plan-unavailable') expect(legacyReader.safeParse(body).success).toBe(false);
    expect(headlessRejectionBodySchema.safeParse(body).success).toBe(true);
    expect(readHeadlessRejection(result.evidence)).toBeNull();
    expect(JSON.stringify(body)).not.toContain('private-provider-prose');
  }
  const failed = await run(responsesCreated() + event('response.failed', 1, { response: responsesFinal([], { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded' } }) }), 200);
  if (!('kind' in failed)) throw new Error('expected rejection');
  // A stream machine code with no actual HTTP 429 is not a confirmed limit.
  expect(readHeadlessRejection(failed.evidence, ids)).toBeNull();
  expect(await run(responsesCreated(), 200)).toMatchObject({ kind: 'rejected', evidence: { reason: 'interrupted', body: { complete: false } } });
  const unknown = await run(JSON.stringify({ error: { code: 'unknown' } }), 403);
  if (!('kind' in unknown)) throw new Error('expected rejection');
  expect(readHeadlessRejection(unknown.evidence, ids)).toBeNull();
});

it('keeps tool namespace identity through completion and rejects calls from another namespace before projection', async () => {
  const f = fixture();
  for (const namespace of ['deckent', 'other', undefined]) {
    const call = { ...callItem(), ...(namespace ? { namespace } : {}) };
    const sent = transport(event('response.completed', 1, { response: responsesFinal([call]) }));
    try {
      const result = await f.port.send(await f.port.prepare(f.profile, f.definition, f.request as never));
      expect('kind' in result).toBe(namespace !== 'deckent');
    } finally { sent.mockRestore(); }
  }
});
it('refuses expired leases and pre-cancellation before the real transport constructs a request', async () => {
  const f = fixture();
  const expired = createSiwcResponsesPort({ now: () => NOW, lease: async () => ({ accessToken: TOKEN, expiresAtMs: NOW }) });
  expect(await expired.send(await expired.prepare(f.profile, f.definition, f.request as never)))
    .toMatchObject({ kind: 'rejected', evidence: { reason: 'not-sent', httpStatus: null, body: { observedBytes: 0 } } });
  expect(await f.port.send(await f.port.prepare(f.profile, f.definition, f.request as never), AbortSignal.abort()))
    .toMatchObject({ kind: 'rejected', evidence: { reason: 'not-sent', httpStatus: null } });
  expect(f.lease).not.toHaveBeenCalled();
});

it('never turns transient, mismatched, unknown or stateless stream errors into quota evidence', async () => {
  const limit = 'subscription_sharing_usage_limit_exceeded', usage = 'subscription_sharing_usage_unavailable';
  const f = fixture(), ids = new Set([SIWC_INFERENCE.adapter.id]);
  for (const [code, status] of [[limit, 503], [usage, 429], ['unlisted_private_code', 503], [null, 503]] as const) {
    const sent = transport(JSON.stringify(code === null ? { detail: 'private-diagnostic' } : { error: { code, message: 'private-diagnostic' } }), status);
    try {
      const result = await f.port.send(await f.port.prepare(f.profile, f.definition, f.request as never));
      if (!('kind' in result)) throw new Error('expected rejection');
      const body = readHeadlessRejection(result.evidence, ids);
      expect(body?.refusal).not.toBe('quota');
      if (status === 503) {
        expect(body).toMatchObject({ schemaVersion: 3, refusal: 'service-unavailable', status: 503 });
        expect(body).not.toHaveProperty('resetsAtMs');
        expect(JSON.stringify(body)).not.toContain('private');
      } else expect(body).toBeNull();
    } finally { sent.mockRestore(); }
  }
  for (const code of [limit, usage]) {
    const sent = transport(responsesCreated() + event('response.failed', 1, { response: responsesFinal([], { status: 'failed', error: { code } }) }), 200);
    try {
      const result = await f.port.send(await f.port.prepare(f.profile, f.definition, f.request as never));
      if (!('kind' in result)) throw new Error('expected rejection');
      const body = readHeadlessRejection(result.evidence, ids);
      expect(body?.refusal).not.toBe('quota');
      if (code === usage) expect(body).toEqual({ schemaVersion: 3, refusal: 'usage-unavailable', code: usage, status: null });
    } finally { sent.mockRestore(); }
  }
  expect(siwcRejection({ error: { code: '__proto__' } }, 429)).toBeNull();
  expect(headlessRejectionBodySchema.safeParse({ schemaVersion: 3, refusal: 'usage-unavailable', status: 503, resetsAtMs: null }).success).toBe(false);
});


it('versions exact revocable API continuation without changing the null-only v1 contract', () => {
  const definition = fixture().profile.adapter.definition, reference = { providerId: 'api', providerVersion: 1, modelId: 'exact-model', modelVersion: 1 };
  expect(siwcResponsesDefinitionSchema.safeParse({ ...definition, apiContinuation: { reference, profileDigest: 'a'.repeat(64) } }).success).toBe(false);
  expect(siwcResponsesDefinitionSchema.parse({ ...definition, schemaVersion: 2, apiContinuation: { reference, profileDigest: 'a'.repeat(64) } })).toMatchObject({ schemaVersion: 2, apiContinuation: { reference, profileDigest: 'a'.repeat(64) } });
  expect(siwcResponsesDefinitionSchema.safeParse({ ...definition, schemaVersion: 2, apiContinuation: { model: 'derived-model' } }).success).toBe(false);
  expect(siwcResponsesDefinitionSchema.safeParse({ ...definition, schemaVersion: 3 }).success).toBe(false);
});
