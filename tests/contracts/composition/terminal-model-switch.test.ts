import { createServer, type Server } from 'node:https';
import { createServer as createProbe } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelReference } from '#domain/index.js';
import { PROVIDER_CONNECT_REGISTRY, parseProviderConnectRegistry } from '#adapters/index.js';
import { connectConfiguredModel, inspectConfiguredModelReadiness, planConfiguredProfileCache, prepareConfiguredModelSwitch } from '#composition/core/model-connect/index.js';
import { inspectDeclaredModels, inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { inspectConfiguredModelActivation } from '#composition/core/model-activation/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { describeTerminalChat } from '#composition/core/terminal-chat/index.js';
import { cachePanelPort, modelPanelSource } from '#surfaces/core/cli-terminal/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';
import { streamTerminalAgentTurn } from '#surfaces/core/terminal-turn/index.js';
import { clearConfigCache, t } from '#platform/index.js';
import { me, runtime } from '../support/chat-turn-harness.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';
import { createLocalTls } from '../../fixtures/local-tls.js';

const ENTER = '\r', DOWN = '\u001b[B', ESC = '\u001b';
const local: ModelReference = { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
const mounted: ReturnType<typeof mountWorkline>[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) view.instance.unmount();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
const grants = [
  { id: 'models', effect: 'allow', actions: ['register', 'inspect'], scopes: 'all', principals: me, resource: { kind: 'model-catalog', ids: 'all' } },
  { id: 'activation', effect: 'allow', actions: ['activate', 'deactivate', 'inspect'], scopes: 'all', principals: me, resource: { kind: 'model-activation', ids: 'all' } },
  { id: 'invoke-all', effect: 'allow', actions: ['invoke', 'inspect', 'inspect-content'], scopes: 'all', principals: me, resource: { kind: 'model-invocation', ids: 'all' } },
  { id: 'config', effect: 'allow', actions: ['read', 'write'], scopes: 'all', principals: me, resource: { kind: 'config', ids: 'all' } },
];
const sse = (type: string, payload: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

describe.skipIf(process.platform !== 'linux')('W6: real terminal model switching with free provider fixtures', () => {
  it('one confirmation sends the next turn to Claude; cache migration alone remains valid; stale catalog activation is repaired before repinning', async context => {
    const probe = createProbe();
    const error = await new Promise<NodeJS.ErrnoException | null>(resolve => { probe.once('error', resolve); probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(null))); });
    if (error?.code === 'EPERM' || error?.code === 'EACCES') context.skip(`Loopback fixture unavailable: ${error.code}`);
    if (error) throw error;
    const f = await runtime({ extraGrants: grants, windowTokens: 1_050_000, serviceLanguage: 'tr' });
    const path = join(f.project, '.deckent/config.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    config.service.responseMaxBytes = 1_048_576;
    await writeFile(path, JSON.stringify(config)); clearConfigCache();
    const { key, caPem } = await createLocalTls(f.project), requests: Record<string, unknown>[] = [];
    const server = createServer({ key, cert: caPem }, (req, res) => {
      const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (req.url?.endsWith('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 30 })); return; }
        requests.push(body); res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse('message_start', { message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model,
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })
          + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
          + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Claude fixture yanıtı.' } })
          + sse('content_block_stop', { index: 0 }) + sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } })
          + sse('message_stop', {}));
      });
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
    const endpoint = `https://127.0.0.1:${address.port}`;
    const registry = parseProviderConnectRegistry({ ...PROVIDER_CONNECT_REGISTRY, kinds: [{ id: 'claude-fixture', labelKey: 'tui.provider.kind.anthropicApi', available: true,
      endpoint: { default: endpoint, editable: false }, key: { required: true, secretName: 'DECKENT_ANTHROPIC_KEY' }, probe: null,
      connect: { adapter: 'anthropic-messages-http', chatPath: '/v1/messages', seed: 'anthropic-api' } }] });
    const options = { env: { ...f.env, DECKENT_ANTHROPIC_KEY: 'fixture-only-not-a-provider-key' }, heal: false as const };
    Object.assign(f.env, { DECKENT_ANTHROPIC_KEY: options.env.DECKENT_ANTHROPIC_KEY });
    await f.start();
    const connected = await connectConfiguredModel(f.project, { schemaVersion: 1, commandId: 'connect-claude', scopeId: 'scope', connection: 'claude-fixture', endpoint: null,
      model: { nativeId: 'claude-sonnet-5-5' } }, options, { registry });
    expect(connected.status).toBe('connected');
    const reference = connected.reference;
    // Fixture TLS is authored before any provider transport. All subsequent mutations go through the real governed config writer.
    const setup = JSON.parse(await readFile(path, 'utf8'));
    setup.provider_invocation_profiles.profiles.find((p: { reference: ModelReference }) => p.reference.providerId === reference.providerId).adapter.definition.tls = { caPem };
    await writeFile(path, JSON.stringify(setup)); clearConfigCache();
    const host = { inspectDeclaredModels, inspectModelBinding, inspectModelActivation: inspectConfiguredModelActivation, describeTerminalChatPlan: describeTerminalChat,
      inspectModelReadiness: inspectConfiguredModelReadiness, prepareModelSwitch: prepareConfiguredModelSwitch,
      listSecretNames: async () => ({ schemaVersion: 1 as const, backend: 'fixture', names: ['DECKENT_ANTHROPIC_KEY'] }) };
    const source = modelPanelSource(f.project, 'scope', host, options, 'tr');
    const view = mountWorkline({ model: 'chat', panels: { ports: { model: source }, labels: terminalPanelLabels('tr') },
      streamTurn: (messages, signal, input) => streamTerminalAgentTurn({ projectRoot: f.project, scopeId: 'scope', messages, options, signal,
        ...input }, { chatTurn: async (_root, command, onEvent) => f.client().chatTurn(command, onEvent), cancelChatTurn: async (_root, command) => f.client().cancelChatTurn(command) }) });
    mounted.push(view); await settle(60);
    const press = async (...keys: string[]) => { for (const key of keys) { view.stdin.write(key); await settle(35); } };
    const switchTo = async (providerIndex: number) => {
      await press('/model', ENTER); await until(() => view.stdout.frame.includes('anthropic-api'), 'provider groups');
      await press(...Array.from({ length: providerIndex }, () => DOWN), ENTER, ENTER);
      expect(requests.length).toBeLessThanOrEqual(3);
      await press(ENTER); // the only confirmation after choosing the model
      await until(() => !view.stdout.frame.includes(t('tui.model.title', { scope: 'scope' }, 'tr')) && view.stdout.frame.includes('READY'), 'switch closes');
    };
    const localTurn = async () => { f.state.script.push({ content: 'Local fixture yanıtı.' }); await press('local turn', ENTER); await until(() => view.stdout.text.includes('Local fixture yanıtı.'), 'local answer'); };
    await localTurn();
    await switchTo(1); await press('Claude turn', ENTER);
    await until(() => requests.length === 1 && view.stdout.text.includes('Claude fixture yanıtı.'), 'new model next turn');
    expect(requests[0]!.model).toBe('claude-sonnet-5-5'); expect(f.state.requests).toHaveLength(1);
    const activationBefore = (await inspectConfiguredModelActivation(f.project, { schemaVersion: 1, scopeId: 'scope', reference }, options)).activation;
    const app = createConfiguredConfigApplication(f.project, options), principal = await resolveConfiguredConfigPrincipal(f.project, 'scope', options);
    const cache = cachePanelPort(f.project, 'scope', { planProfileCache: planConfiguredProfileCache, configApplication: app,
      resolveConfigPrincipal: resolveConfiguredConfigPrincipal }, options, 'tr');
    expect((await cache.apply()).status).toBe('applied');
    expect((await inspectConfiguredModelActivation(f.project, { schemaVersion: 1, scopeId: 'scope', reference }, options)).activation).toEqual(activationBefore);
    const cached = await f.client().chatTurn({ schemaVersion: 1, turnId: 'cache-only', scopeId: 'scope', reference, messages: [{ role: 'user', content: 'cache-only' }] }, () => undefined);
    expect(cached.finish).toBe('stop'); expect(requests[1]!.cache_control).toEqual({ type: 'ephemeral' });
    await switchTo(0);
    const current = JSON.parse(await readFile(path, 'utf8'));
    const changed = await app.submit('set', { keyPath: 'provider_catalog', value: { ...current.provider_catalog, revision: 'catalog-after-cache' }, layer: 'project', scopeId: 'scope', principal });
    expect(changed.status).toBe('applied');
    const stale = await f.client().chatTurn({ schemaVersion: 1, turnId: 'stale-proof', scopeId: 'scope', reference, messages: [{ role: 'user', content: 'stale' }] }, () => undefined);
    expect(stale.note).toContain('MODEL_INVOCATION_ACTIVATION_CONFLICT'); expect(requests).toHaveLength(2);
    await switchTo(1); await press('after migration', ENTER);
    await until(() => requests.length === 3, 'current activation next turn');
    const activationAfter = (await inspectConfiguredModelActivation(f.project, { schemaVersion: 1, scopeId: 'scope', reference }, options)).activation!;
    expect(activationAfter.revision).toBe(activationBefore!.revision + 1);
    expect(activationAfter.catalogRevision).toBe('catalog-after-cache'); expect(activationAfter.binding).toEqual(activationBefore!.binding);
    expect(requests[2]!.model).toBe('claude-sonnet-5-5'); expect(requests[2]!.cache_control).toEqual({ type: 'ephemeral' });
    // A known unsupported adapter is refused before pin; the previous Claude pin keeps serving the next turn.
    const unsupported = JSON.parse(await readFile(path, 'utf8')).provider_invocation_profiles;
    unsupported.profiles.find((p: { reference: ModelReference }) => p.reference.providerId === local.providerId).adapter = { id: 'fixture-unsupported', version: 1, definition: {} };
    expect((await app.submit('set', { keyPath: 'provider_invocation_profiles', value: unsupported, layer: 'project', scopeId: 'scope', principal })).status).toBe('applied');
    await press('/model', ENTER); await until(() => view.stdout.frame.includes('local-openai'), 'unsupported list'); await press(ENTER);
    await until(() => view.stdout.frame.includes('desteklenen protokol'), 'refusal and next step'); await press(ENTER, ESC, ESC);
    await press('still Claude', ENTER); await until(() => requests.length === 4, 'refused switch preserves pin');
    expect(f.state.requests).toHaveLength(1);
  }, 60_000);
});
