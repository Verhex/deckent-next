import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as platform from '#platform/index.js';
import * as domain from '#domain/index.js';
import * as scope from '#composition/core/scoped-request/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId } from '#engine/index.js';
import { openSqliteModelActivationStore, FilePolicySource, installationSecretRoot, projectVaultDirectory, openSecretGrantStore } from '#adapters/index.js';
import { openConfiguredModelInspection } from '#composition/core/cli/index.js';
import { inspectDeclaredModels, inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { inspectConfiguredModelActivation, inspectConfiguredModelCatalog } from '#composition/core/model-activation/index.js';
import { resolveProjectVaultAnchor } from '#composition/core/secrets/index.js';
import { inspectConfiguredInvocableModels, invokeConfiguredModel } from '#composition/core/model-invocation/index.js';
import { inspectConfiguredBrainModels } from '#composition/core/run-planner/index.js';
import { describeTerminalChat, prepareTerminalChatCommand } from '#composition/core/terminal-chat/index.js';
import { prepareConfiguredModelSwitch } from '#composition/core/model-connect/index.js';
import { modelPanelSource, providerPanelPort, type ProviderConnectHost } from '#surfaces/core/cli-terminal/index.js';
import type { ModelPanelView } from '#surfaces/core/terminal-panels/index.js';
import { grantFixtureSecrets } from '../../fixtures/project-grant.js';
import { runtime, me, principal } from '../support/chat-turn-harness.js';

afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === 'win32')('30 models: one opening reads inputs once, publishes locked names first, and selection rechecks a revoked credential', async () => {
  const f = await runtime({ noServer: true, extraGrants: [
    { id: 'all-invocations', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'model-invocation', ids: 'all' } },
    { id: 'activation-read', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: me, resource: { kind: 'model-activation', ids: 'all' } },
    { id: 'catalog-read', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: me, resource: { kind: 'model-catalog', ids: 'all' } },
  ] });
  const path = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(path, 'utf8'));
  const template = config.provider_catalog.providers[0].models[0], profile = config.provider_invocation_profiles.profiles[0];
  const models = Array.from({ length: 30 }, (_, n) => ({ ...template, id: `model-${n}`, nativeId: `native-${n}` }));
  const catalog = { ...config.provider_catalog, providers: [{ ...config.provider_catalog.providers[0], models }] };
  const bindings = new ModelBindingApplication({ read: async () => catalog });
  const references = models.map(model => ({ providerId: 'local-openai', providerVersion: 1, modelId: model.id, modelVersion: 1 }));
  config.provider_catalog = catalog; config.service.responseMaxBytes = 1_048_576; config.terminal.scopeId = 'scope'; config.terminal.chat.reference = references[0];
  config.provider_invocation_profiles.profiles = await Promise.all(references.map(async (reference, n) => ({ ...profile, id: `profile-${n}`, reference,
    bindingDigest: (await bindings.inspect(reference)).binding!.digest,
    adapter: { ...profile.adapter, definition: { ...profile.adapter.definition, endpoint: 'https://127.0.0.1:9/v1/chat/completions', authentication: { type: 'bearer', credentialRef: 'FIXTURE_OPENING' } } },
  })));
  await writeFile(path, JSON.stringify(config)); platform.clearConfigCache();
  const app = new ModelActivationApplication({ verify: async () => principal }, { authorize: async () => ({ revision: 'fixture', ruleId: 'fixture' }) }, bindings,
    async () => openSqliteModelActivationStore(f.ledger, config.storage.sqlite), () => 1);
  for (const reference of references) await app.admit({ schemaVersion: 1, commandId: `activate-${reference.modelId}`, scopeId: 'scope', reference,
    action: 'activate', expectedRevision: 0, expectedBinding: (await bindings.inspect(reference)).binding!, catalogRevision: catalog.revision });
  await grantFixtureSecrets(f.project, 'scope', ['FIXTURE_OPENING'], { env: f.env });
  let credentialPresent = true, resolutions = 0;
  const options = { env: f.env, heal: false as const, secretResolver: async () => { resolutions++; return credentialPresent ? 'synthetic-fixture-only' : undefined; } };
  const providerConnect: ProviderConnectHost = { kinds: [{ id: 'local-openai', labelKey: 'tui.provider.kind.localOpenai', available: true,
    endpointDefault: null, endpointEditable: true, keyRequired: false, secretName: null, probePath: null, endpointChoices: [] }],
    endpoint: () => ({ ok: false, reason: 'fixture' }), probe: async () => { throw new Error('no network during inspection'); } };
  const host = { openModelInspection: openConfiguredModelInspection, providerConnect, prepareModelSwitch: prepareConfiguredModelSwitch };
  const loads = vi.spyOn(platform, 'loadConfig'), contexts = vi.spyOn(scope, 'loadConfiguredScopeContext'), parses = vi.spyOn(domain, 'parseProviderCatalog'), policies = vi.spyOn(FilePolicySource.prototype, 'load');
  const counts = () => ({ config: loads.mock.calls.length, scope: contexts.mock.calls.length, catalog: parses.mock.calls.length, policy: policies.mock.calls.length });
  const reset = () => { loads.mockClear(); contexts.mockClear(); parses.mockClear(); policies.mockClear(); };
  const source = modelPanelSource(f.project, 'scope', host, options, 'en'), frames: ModelPanelView[] = [];
  const result = await source.inspect(view => frames.push(structuredClone(view)));
  expect(frames[0]!.choices).toHaveLength(30);
  expect(frames[0]!.choices.every(row => row.label.startsWith('native-') && row.blocked === 'Checking…' && !row.fixes?.length)).toBe(true);
  expect(result.choices.map(row => row.blocked)).toEqual(Array(30).fill(null));
  expect(frames.some(view => view.choices.some(row => row.blocked === null) && view.choices.some(row => row.blocked === 'Checking…'))).toBe(true);
  expect(counts()).toEqual({ config: 1, scope: 1, catalog: 1, policy: 1 });
  expect(resolutions).toBeGreaterThanOrEqual(30); // Credential values are read for each model, never retained in the opening snapshot.
  platform.clearConfigCache(); reset();
  await source.inspect();
  expect(counts()).toEqual({ config: 1, scope: 1, catalog: 3, policy: 1 }); // Authored + effective config validation, then one display parse.
  reset();
  const providerFrames: boolean[] = [];
  await providerPanelPort(f.project, 'scope', host, options, 'en', () => 'fixture-error').inspect(view => providerFrames.push(view.kinds.every(row => row.blocked === 'Checking…')));
  expect(providerFrames[0]).toBe(true);
  expect(counts()).toEqual({ config: 1, scope: 1, catalog: 1, policy: 1 });
  // Fresh opening after a policy change: per-model decisions must remain distinct, without N config/scope loads.
  await f.writePolicy([...f.grants, { id: 'deny-one', effect: 'deny', actions: ['invoke'], scopes: ['scope'], principals: me,
    resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(references[1]!)] } }]);
  reset();
  const changed = await source.inspect();
  expect(changed.choices.find(row => row.reference.modelId === 'model-1')?.blocked).not.toBeNull();
  expect(changed.choices.find(row => row.reference.modelId === 'model-0')?.blocked).toBeNull();
  expect(counts()).toEqual({ config: 1, scope: 1, catalog: 1, policy: 1 });
  // A key removed after the opening is read again at send, then refused before a provider request.
  credentialPresent = false; reset(); const beforeResolutions = resolutions;
  const { command } = await prepareTerminalChatCommand({ projectRoot: f.project, scopeId: 'scope', messages: [{ role: 'user', content: 'fixture' }], options }, false, references[0]);
  const sent = await invokeConfiguredModel(f.project, command, options);
  expect(sent.receipt.outcome).toMatchObject({ state: 'rejected', evidence: { reason: 'not-sent', httpStatus: null } });
  expect(resolutions).toBeGreaterThan(beforeResolutions); expect(loads.mock.calls.length).toBeGreaterThan(0);
  expect(f.state.requests).toEqual([]);
  // Revoking this project's credential grant also refuses selection under its ordinary fresh admission.
  credentialPresent = true;
  const context = await scope.loadConfiguredScopeContext(f.project, 'scope', options, 'read'), anchor = await resolveProjectVaultAnchor(context, options);
  const secretRoot = installationSecretRoot(f.env)!;
  expect(await projectVaultDirectory(secretRoot, anchor!, false)).not.toBeNull();
  await openSecretGrantStore(secretRoot, anchor!, 2_000).update(() => []);
  reset(); const beforeSelection = resolutions;
  await expect(source.prepare!(result.choices[0]!)).rejects.toMatchObject({ code: 'TERMINAL_MODEL_SWITCH_REFUSED' });
  expect(loads.mock.calls.length).toBeGreaterThan(0); expect(resolutions).toBe(beforeSelection);
  await grantFixtureSecrets(f.project, 'scope', ['FIXTURE_OPENING'], { env: f.env });
  // Legacy producer wiring is exercised separately below to retain explicit before/after counts for the identical fixture.
  credentialPresent = true; await f.writePolicy(f.grants); reset();
  await modelPanelSource(f.project, 'scope', { inspectDeclaredModels, inspectModelBinding, inspectModelActivation: inspectConfiguredModelActivation,
    inspectModelCatalog: inspectConfiguredModelCatalog, inspectInvocableModels: inspectConfiguredInvocableModels, inspectBrainModels: inspectConfiguredBrainModels,
    describeTerminalChatPlan: describeTerminalChat, providerConnect }, options, 'en').inspect();
  console.info('same-fixture unshared producer counts', counts());
  const abort = new AbortController(), opening = await openConfiguredModelInspection(f.project, 'scope', options, abort.signal);
  abort.abort(); reset();
  await expect(opening.host.inspectInvocableModels!(f.project, 'scope', options)).rejects.toMatchObject({ name: 'AbortError' });
  expect(counts()).toEqual({ config: 0, scope: 0, catalog: 0, policy: 0 });
}, 60_000);
