import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { parseModelInvocationCommand, parseModelInvocationProfile, parseModelBindingDefinition } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';
import { createDecisionHttpNativePort, decisionHttpAdapter, parseDecisionHttpAdvice, prepareDecisionHttpRequest, quoteDecisionHttpOperatorTariff } from '#adapters/core/provider-decision-http/index.js';

const servers: Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map(async server => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); })));
const limits = { requestMaxBytes: 16_384, responseMaxBytes: 16_384, timeoutMs: 5000 };
const tariff = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 };
const caseValue = { schemaVersion: 1, objective: 'Choose safe change', scope: 'scope', revision: 'revision-1', constraints: ['Preserve existing grants'], unknowns: [],
  evidence: [{ id: 'source-1', source: 'fixture', observedAt: '2026-10-01T00:00:00.000Z', observation: 'Both paths verified' }],
  options: [{ id: 'a', action: 'Change a', tradeoffs: ['Low cost'], evidenceIds: ['source-1'] }, { id: 'b', action: 'Change b', tradeoffs: ['Higher cost'], evidenceIds: ['source-1'] }],
  checks: [{ id: 'grants', instructions: 'Preserves grants', evidenceIds: ['source-1'] }], process: { stage: 'review', currentState: 'prepared', acceptedDecisions: [], nextStep: 'Owner reviews selection', reopenReason: null } };
const request = { schemaVersion: 1, case: caseValue };
const binding = { encodingVersion: 1, provider: { id: 'provider', version: 1 }, model: { id: 'model', version: 1, nativeId: 'configured-model',
  protocols: [{ family: decisionHttpAdapter.protocol.family, version: decisionHttpAdapter.protocol.version, capabilities: [] }] } };
function definition(endpoint: string) { return { endpoint, authentication: { type: 'none' }, tariff }; }
function profile(endpoint: string, profileLimits = limits) { return { schemaVersion: 1, id: 'profile', version: 1, scopeId: 'scope',
  reference: { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 }, bindingDigest: 'a'.repeat(64),
  protocol: decisionHttpAdapter.protocol, adapter: { id: decisionHttpAdapter.id, version: decisionHttpAdapter.version, definition: definition(endpoint) },
  allocation: { id: 'allocation', maxCalls: 1, maxInFlight: 1 }, limits: profileLimits }; }
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) { const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address'); return `http://127.0.0.1:${address.port}/`; }
function response() { return { model: 'resolved-model-revision', answers: { selection: { type: 'choice', choice: 'a', probabilities: { a: .8, b: .1, none_of_the_above: .05, insufficient_information: .05 }, confidence: .7 },
  sufficiency: { type: 'noul', noul: .9 }, check_0: { type: 'noul', noul: .95 } }, usage: { input_tokens: 20, output_tokens: 10 } }; }
async function token(endpoint: string, profileLimits = limits) { const port = createDecisionHttpNativePort(); return { port, prepared: await port.prepare(profile(endpoint, profileLimits), binding, request) }; }

it('maps case to exact typed questions and retains native response plus full advice distribution', async () => {
  let body = ''; const endpoint = await fixture((req, res) => { req.on('data', chunk => { body += String(chunk); }); req.on('end', () => res.end(JSON.stringify(response()))); });
  const { port, prepared } = await token(endpoint); expect(body).toBe(''); const result = await port.send(prepared);
  const wire = JSON.parse(body); expect(wire.model).toBe(binding.model.nativeId); expect(wire.state).toEqual(caseValue);
  expect(Object.keys(wire.questions)).toEqual(['selection', 'sufficiency', 'check_0']);
  expect(wire.questions.selection.type).toBe('choice'); expect(Object.keys(wire.questions.selection.criteria)).toEqual(['a', 'b', 'none_of_the_above', 'insufficient_information']);
  expect(wire.questions.sufficiency.type).toBe('noul'); expect(wire.questions.check_0.type).toBe('noul');
  expect(result).toMatchObject({ schemaVersion: 1, native: { decisionAdvice: { choice: 'a' } }, usage: response().usage });
  expect(parseDecisionHttpAdvice(result, caseValue, 50)).toEqual({ schemaVersion: 1, choice: 'a', probabilities: response().answers.selection.probabilities, confidence: .7,
    sufficiency: .9, checks: { grants: .95 }, model: 'resolved-model-revision', usage: { inputTokens: 20, outputTokens: 10 }, latencyMs: 50 });
});

it.each(['missing-abstention', 'extra-option', 'bad-sum', 'nonmaximal-choice', 'bad-confidence', 'bad-noul', 'extra-question', 'missing-question', 'bad-usage'])('rejects malformed wire advice %s with retained evidence', async mutation => {
  const value = response() as { model: string; answers: Record<string, { type: string; choice?: string; probabilities?: Record<string, number>; confidence?: number; noul?: number }>; usage: { input_tokens: number; output_tokens: number } };
  const selection = value.answers['selection']!, probabilities = selection.probabilities!;
  if (mutation === 'missing-abstention') delete probabilities.none_of_the_above;
  if (mutation === 'extra-option') probabilities.rogue = 0;
  if (mutation === 'bad-sum') probabilities.a = .9;
  if (mutation === 'nonmaximal-choice') selection.choice = 'b';
  if (mutation === 'bad-confidence') selection.confidence = 2;
  if (mutation === 'bad-noul') value.answers['sufficiency']!.noul = -1;
  if (mutation === 'extra-question') value.answers.rogue = { type: 'noul', noul: .5 };
  if (mutation === 'missing-question') delete value.answers.check_0;
  if (mutation === 'bad-usage') value.usage.input_tokens = -1;
  const endpoint = await fixture((_req, res) => res.end(JSON.stringify(value))); const { port, prepared } = await token(endpoint);
  expect(await port.send(prepared)).toMatchObject({ kind: 'rejected', evidence: { reason: 'invalid-response', body: { complete: true } } });
});

it.each([429, 529])('does not retry HTTP %s or reuse a consumed prepared token', async status => {
  let count = 0; const endpoint = await fixture((_req, res) => { count++; res.writeHead(status); res.end('{}'); }); const { port, prepared } = await token(endpoint);
  expect(await port.send(prepared)).toMatchObject({ kind: 'rejected', evidence: { reason: 'http-status', httpStatus: status } });
  await expect(port.send(prepared)).rejects.toThrow('DECISION_HTTP_REQUEST_INVALID'); expect(count).toBe(1);
});

it('bounds request bytes and maximum choice count, and rejects getters without evaluating them', () => {
  const endpoint = 'http://127.0.0.1:1/'; expect(() => prepareDecisionHttpRequest(definition(endpoint), { ...limits, requestMaxBytes: 10 }, request, 'model')).toThrow('DECISION_HTTP_REQUEST_TOO_LARGE');
  const tooMany = { ...request, case: { ...caseValue, options: Array.from({ length: 254 }, (_, n) => ({ ...caseValue.options[0], id: `o${n}` })) } };
  expect(() => prepareDecisionHttpRequest(definition(endpoint), limits, tooMany, 'model')).toThrow('DECISION_HTTP_REQUEST_INVALID');
  let calls = 0; const getter = { ...request }; Object.defineProperty(getter, 'case', { enumerable: true, get() { calls++; return caseValue; } });
  expect(() => prepareDecisionHttpRequest(definition(endpoint), limits, getter, 'model')).toThrow('DECISION_HTTP_REQUEST_INVALID'); expect(calls).toBe(0);
});

it('handles observed cancellation and enforces response limits', async () => {
  let seen!: () => void; const observed = new Promise<void>(resolve => { seen = resolve; }); const endpoint = await fixture(() => seen()); const { port, prepared } = await token(endpoint);
  const controller = new AbortController(); const sending = port.send(prepared, controller.signal); await observed; controller.abort(); await expect(sending).rejects.toThrow('DECISION_HTTP_CANCELLED');
  const oversized = await fixture((_req, res) => res.end('x'.repeat(1000))); const limited = await token(oversized, { ...limits, responseMaxBytes: 100 });
  expect(await limited.port.send(limited.prepared)).toMatchObject({ kind: 'rejected', evidence: { reason: 'response-limit', body: { complete: false } } });
});

it('rejects unpaid/undeclared profile variants before transport and resolves no credential during preparation', async () => {
  let requests = 0, credentials = 0;
  const endpoint = await fixture((_req, res) => { requests++; res.end(JSON.stringify(response())); });
  const port = createDecisionHttpNativePort({ resolveCredential: async () => { credentials++; return 'test-secret'; } });
  const paid = profile(endpoint); paid.adapter.definition.tariff = { ...tariff, inputMinorUnitsPerMillionTokens: 1 };
  await expect(port.prepare(paid, binding, request)).rejects.toThrow('DECISION_HTTP_DEFINITION_INVALID');
  await expect(port.prepare({ ...profile(endpoint), adapter: { ...profile(endpoint).adapter, version: 2 } }, binding, request)).rejects.toThrow('DECISION_HTTP_DEFINITION_INVALID');
  await expect(port.prepare(profile(endpoint), { ...binding, model: { ...binding.model, protocols: [] } }, request)).rejects.toThrow('DECISION_HTTP_REQUEST_INVALID');
  await expect(port.prepare(profile(endpoint), binding, { ...request, case: { ...caseValue, scope: 'other' } })).rejects.toThrow('DECISION_HTTP_REQUEST_INVALID');
  await port.prepare(profile(endpoint), binding, request); expect(requests).toBe(0); expect(credentials).toBe(0);
});


it('quotes the exact prepared zero tariff through existing spending evidence and rejects detached prepared input', () => {
  const configured = parseModelInvocationProfile(profile('http://127.0.0.1:1/'));
  const command = parseModelInvocationCommand({ schemaVersion: 1, commandId: 'cmd', scopeId: 'scope', reference: configured.reference, catalogRevision: 'catalog',
    expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: configured.bindingDigest }, nativeRequest: request });
  const prepared = prepareDecisionHttpRequest(configured.adapter.definition, configured.limits, request, binding.model.nativeId);
  const input = { command, prepared, profile: configured, definition: parseModelBindingDefinition(binding), requestDigest: modelInvocationRequestDigest(command), profileDigest: modelInvocationProfileDigest(configured) };
  expect(quoteDecisionHttpOperatorTariff(input)).toMatchObject({ scopeId: 'scope', currency: 'USD', maxChargeMinorUnits: 0,
    requestDigest: input.requestDigest, profileDigest: input.profileDigest, pricing: { definition: tariff } });
  expect(() => quoteDecisionHttpOperatorTariff({ ...input, prepared: { ...prepared, body: '{}' } })).toThrow('DECISION_HTTP_REQUEST_INVALID');
});
