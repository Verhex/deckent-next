import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTurnEvent, ModelInvocationProfile, ModelReference } from '#domain/index.js';
import { openSqliteModelActivationStore, openSqliteModelActivationReader, openSqliteModelInvocationStore, openSqliteProviderSpendAccountReader, registerProviderConfig } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, ModelInvocationApplication, ProviderSpendError, checkModelInvocationCapacity,
  inspectModelSwitch, prepareModelSwitch, OPERATOR_TARIFF_PRICING_ID, providerSpendEvidenceDigest, runAgentTurn, type ModelSwitchPorts } from '#engine/index.js';
import { modelPanelSource } from '#surfaces/core/cli-terminal/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';
import { terminalRenderLabels } from '#surfaces/core/terminal-labels/index.js';
import { clearConfigCache, t } from '#platform/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

const ENTER = '\r', ESC = '\u001b';
const sqlite = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2000 };
const refs: ModelReference[] = ['local', 'claude'].map(providerId => ({ providerId, providerVersion: 1, modelId: 'chat', modelVersion: 1 }));
const principal = { id: 'owner', issuer: 'os', subject: '1', assurance: 'os-user' as const, scopeIds: ['scope'] };
const close: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); clearConfigCache(); });
registerProviderConfig();

/** Real activation, invocation and spend ledger; provider transport is a deterministic, free in-process fixture. */
async function fixture(locale: 'en' | 'tr' = 'tr') {
  const root = await mkdtemp(join(tmpdir(), 'deckent-w6-switch-')); close.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'ledger.db'); await mkdir(join(root, '.deckent'));
  let revision = 'catalog-1', allowed = true, price = true, insufficient = false, holding = false, changedBinding = false, sequence = 0;
  const catalog = () => ({ schemaVersion: 1, revision, providers: refs.map(ref => ({ id: ref.providerId, version: 1, models: [{ id: ref.modelId,
    version: 1, nativeId: `native-${ref.providerId}${changedBinding ? '-changed' : ''}`, protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] })) });
  const bindings = new ModelBindingApplication({ async read() { return catalog(); } });
  const profiles = new Map<string, ModelInvocationProfile>();
  const authorization = { async authorize() { if (!allowed) throw Object.assign(new Error('DENIED'), { code: 'POLICY_DENIED' }); return { revision: 'policy-1', ruleId: 'owner' }; } };
  const activations = new ModelActivationApplication({ async verify() { return principal; } }, authorization, bindings,
    () => openSqliteModelActivationStore(path, sqlite), Date.now);
  // Connecting fixtures explicitly admits both references through the activation owner, before the terminal chooses either.
  for (const [index, reference] of refs.entries()) {
    const inspected = await bindings.inspect(reference); if (inspected.status !== 'declared') throw new Error('FIXTURE_BINDING');
    profiles.set(reference.providerId, { schemaVersion: 1, id: `profile-${index}`, version: 1, scopeId: 'scope', reference, bindingDigest: inspected.binding.digest,
      contextWindowTokens: index === 0 ? 1_050_000 : 1_000_000,
      protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'fixture-native', version: 1, definition: { cache: false } },
      allocation: { id: `allocation-${index}`, maxCalls: null, maxInFlight: 1 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } });
    await activations.admit({ schemaVersion: 1, action: 'activate', commandId: `connect-${index}`, scopeId: 'scope', reference, expectedRevision: 0,
      catalogRevision: revision, expectedBinding: inspected.binding });
  }
  const budget = { schemaVersion: 1 as const, scopeId: 'scope', budgetId: 'shared', revision: 1, currency: 'USD' as const, limitMinorUnits: 100 };
  const config = { provider_catalog: catalog(), provider_invocation_profiles: { schemaVersion: 1, profiles: [...profiles.values()] },
    provider_spending: { schemaVersion: 1, budgets: [budget] } };
  const options = { env: { DECKENT_GLOBAL_HOME: join(root, 'global'), HOME: join(root, 'home') } };
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify(config));
  const preparations: string[] = [], turnReferences: unknown[] = [];
  const sends: { provider: string; cache: unknown; version: number; activation: number }[] = [];
  const app = new ModelInvocationApplication({ async verify() { return principal; } }, authorization, bindings,
    () => openSqliteModelActivationReader(path, { busyTimeoutMs: sqlite.busyTimeoutMs }), { async resolve(_scope, reference) { return profiles.get(reference.providerId) ?? null; } },
    { resolve(profile) { if (profile.adapter.id !== 'fixture-native') return null; return {
      async prepare() { return { profile }; }, async measure() { return { promptTokens: 30_000, windowTokens: profile.contextWindowTokens! }; }, async send(prepared, _signal, onDelta) {
        const { profile: served } = prepared as { profile: ModelInvocationProfile };
        const reader = await openSqliteModelActivationReader(path, { busyTimeoutMs: sqlite.busyTimeoutMs });
        try { sends.push({ provider: served.reference.providerId, cache: served.adapter.definition.cache, version: served.version,
          activation: (await reader.loadRecord('scope', served.reference))!.revision }); } finally { reader.close(); }
        const text = `ANSWER-${served.reference.providerId}-${sends.length}`; onDelta?.({ kind: 'text', text });
        return { schemaVersion: 1 as const, native: { text }, usage: null };
      },
    }; } }, () => openSqliteModelInvocationStore(path, sqlite, 'forbid'),
    { invocationId: () => `invocation-${++sequence}`, ownerId: () => 'fixture-runtime', now: Date.now }, {
      async authorize(input) {
        if (!price && input.command.reference.providerId === 'local') throw new ProviderSpendError('PROVIDER_SPEND_TARIFF_UNVERIFIED');
        const pricing = { schemaVersion: 1, kind: 'synthetic-price' }, evidence = { schemaVersion: 1, kind: 'synthetic-meter' };
        return { budget, quote: { schemaVersion: 1 as const, scopeId: 'scope', requestDigest: input.requestDigest, profileDigest: input.profileDigest,
          pricing: { id: holding ? 'synthetic-price' : OPERATOR_TARIFF_PRICING_ID, version: 1, definition: pricing, digest: providerSpendEvidenceDigest(pricing) },
          meter: { id: 'fixture-meter', version: 1, evidence, evidenceDigest: providerSpendEvidenceDigest(evidence) }, currency: 'USD' as const,
          maxChargeMinorUnits: insufficient && input.command.reference.providerId === 'local' ? 101 : holding ? 100 : 0 } };
      }, checkCapacity: spending => checkModelInvocationCapacity(() => openSqliteProviderSpendAccountReader(path, { busyTimeoutMs: sqlite.busyTimeoutMs }), spending),
    });
  const ports: ModelSwitchPorts = { commandId: () => `preview-${++sequence}`, families: ['openai-chat-completions'], tools: [],
    snapshot: async reference => ({ binding: await bindings.inspect(reference), outputTokens: 32 }), preview: command => app.preview(command), activate: command => activations.admit(command) };
  const source = modelPanelSource(root, 'scope', {
    inspectDeclaredModels: async () => ({ schemaVersion: 1, status: 'declared', catalog: catalog() }),
    inspectModelActivation: async (_root, input) => { const reader = await openSqliteModelActivationReader(path, { busyTimeoutMs: sqlite.busyTimeoutMs });
      try { return { schemaVersion: 1, activation: await reader.loadRecord(input.scopeId, input.reference) }; } finally { reader.close(); } },
    inspectModelReadiness: (_root, scope, reference) => inspectModelSwitch(scope, reference, ports),
    prepareModelSwitch: (_root, scope, reference) => { preparations.push(reference.providerId); return prepareModelSwitch(scope, reference, ports); },
  }, options, locale);
  const view = mountWorkline({ model: 'local', labels: { ...WORKLINE_TEST_LABELS, render: terminalRenderLabels(locale) }, panels: { ports: { model: source }, labels: terminalPanelLabels(locale) },
    async *streamTurn(messages, signal, input) {
      turnReferences.push(input?.reference ?? null);
      const reference = input?.reference ?? refs[0]!;
      const { command } = await inspectModelSwitch('scope', reference, ports), events: AgentTurnEvent[] = [];
      await runAgentTurn({ language: locale, messages, tools: [], signal, emit: event => events.push(event) }, {
        async measure() { return (await app.measure(command))!; },
        async invokeRound(_round, onDelta) {
          const result = await app.invoke({ ...command, commandId: `turn-${++sequence}`, nativeRequest: { ...command.nativeRequest, messages } }, undefined, signal, undefined, onDelta);
          return { status: 'responded', content: String(result.response?.native.text), reasoning: '', toolCalls: [], finish: 'stop', usage: null };
        }, authorize: async () => 'deny', describe: () => null, execute: async () => { throw new Error('NO_TOOLS'); }, now: Date.now,
      });
      for (const event of events) if (event.kind === 'text' || event.kind === 'done' || event.kind === 'context') yield event;
    } });
  close.push(() => view.instance.unmount()); await settle(60);
  const press = async (...keys: string[]) => { for (const key of keys) { view.stdin.write(key); await settle(30); } };
  const choose = async (providerIndex: number, confirm = true) => {
    expect((await source.inspect()).choices[providerIndex]!.blocked).toBeNull();
    await press('/model', ENTER); await until(() => view.stdout.frame.includes('claude'), 'providers');
    const provider = refs[providerIndex]!.providerId;
    await press(provider); await until(() => view.stdout.frame.includes(terminalPanelLabels(locale).picker.filter.replace('{query}', provider)), 'filtered provider');
    await press(ENTER); await until(() => view.stdout.frame.includes(`› ${provider}`), 'provider models');
    await press(ENTER); await until(() => view.stdout.frame.includes(terminalPanelLabels(locale).picker.hintScope), 'confirmation');
    expect(view.stdout.frame).toContain(terminalPanelLabels(locale).model.session);
    if (confirm) { await press(ENTER); await until(() => view.stdout.frame.includes('READY') && !view.stdout.frame.includes(t('tui.model.title', { scope: 'scope' }, locale)), 'confirmed'); }
  };
  const turn = async () => { const expected = sends.length + 1; await press('next turn', ENTER); await until(() => view.stdout.text.includes(`-${expected}`) && sends.length === expected && view.stdout.frame.includes('READY'), 'fixture answer').catch(error => { throw new Error(`${error.message}\n${view.stdout.frame}`); }); };
  const activation = async (reference = refs[1]!) => { const reader = await openSqliteModelActivationReader(path, { busyTimeoutMs: sqlite.busyTimeoutMs });
    try { return (await reader.loadRecord('scope', reference))!; } finally { reader.close(); } };
  return { view, source, ports, app, sends, preparations, turnReferences, press, choose, turn, activation, profiles, activations, bindings,
    revise: () => { revision = 'catalog-2'; }, changeBinding: () => { changedBinding = true; }, deny: () => { allowed = false; },
    unprice: () => { price = false; }, exhaust: () => { insufficient = true; }, hold: () => { holding = true; } };
}

describe('W6: in-process terminal model switch with governed owners', () => {
  it('one confirmation switches the next turn; cache-only profile migration stays valid; catalog drift refreshes before pin', async () => {
    const f = await fixture(); await f.turn(); expect(f.sends[0]!.provider).toBe('local'); expect(f.view.stdout.frame).toContain('1,05 M');
    await f.choose(1, false); expect(f.sends).toHaveLength(1); await f.press(ENTER);
    await until(() => f.view.stdout.frame.includes('READY') && !f.view.stdout.frame.includes(t('tui.model.title', { scope: 'scope' }, 'tr')), 'one confirmation'); expect(f.preparations, f.view.stdout.text).toEqual(['claude']); await f.turn(); expect(f.sends[1]!.provider, JSON.stringify(f.turnReferences)).toBe('claude'); expect(f.view.stdout.frame).toContain('1 M');
    const before = await f.activation(), profile = f.profiles.get('claude')!;
    f.profiles.set('claude', { ...profile, version: 2, adapter: { ...profile.adapter, definition: { cache: true } } });
    await f.turn(); expect(await f.activation()).toEqual(before); expect(f.sends[2]).toMatchObject({ provider: 'claude', cache: true, version: 2, activation: before.revision });
    await f.choose(0); f.revise();
    const stale = await inspectModelSwitch('scope', refs[1]!, f.ports);
    await expect(f.app.invoke({ ...stale.command, commandId: 'stale-direct-turn' })).rejects.toMatchObject({ code: 'MODEL_INVOCATION_ACTIVATION_CONFLICT' });
    expect(f.sends).toHaveLength(3);
    await f.choose(1); await f.turn();
    expect(await f.activation()).toMatchObject({ revision: before.revision + 1, catalogRevision: 'catalog-2', binding: before.binding });
    expect(f.sends[3]).toMatchObject({ provider: 'claude', cache: true, version: 2, activation: before.revision + 1 });
  });

  for (const locale of ['en', 'tr'] as const) it.each(['protocol', 'price', 'budget'] as const)(`${locale}: refuses %s before switching and preserves the serving pin`, async kind => {
    const f = await fixture(locale); await f.choose(1);
    if (kind === 'protocol') { const profile = f.profiles.get('local')!; f.profiles.set('local', { ...profile, adapter: { ...profile.adapter, id: 'unsupported' } }); }
    else if (kind === 'price') f.unprice(); else f.exhaust();
    const local = (await f.source.inspect()).choices.find(choice => choice.group === 'local')!;
    expect(local.blocked).toContain(t(kind === 'protocol' ? 'tui.model.reason.protocol' : kind === 'price' ? 'tui.model.reason.price' : 'tui.model.reason.budget', { code: kind === 'budget' ? 'PROVIDER_SPEND_EXHAUSTED' : 'MODEL_INVOCATION_UNAVAILABLE' }, locale));
    await f.press('/model', ENTER); await until(() => f.view.stdout.frame.includes('local'), 'blocked provider'); await f.press('local', ENTER, ENTER);
    expect(f.sends).toHaveLength(0); await f.press(ESC, ESC); await f.turn(); expect(f.sends[0]!.provider).toBe('claude');
  });

  it('a gate revoked after listing refuses at confirmation; a deactivation stays deactivated', async () => {
    const f = await fixture(); await f.choose(1); await f.choose(0, false); f.deny(); await f.press(ENTER);
    await until(() => f.view.stdout.text.includes('POLICY_DENIED'), 'confirmation refusal'); expect(f.sends).toHaveLength(0);
    const current = await f.activation();
    // Use the already-admitted owner before the denied policy for this independent negative fixture.
    const g = await fixture(), active = await g.activation();
    await g.activations.admit({ schemaVersion: 1, action: 'deactivate', commandId: 'deactivate', scopeId: 'scope', reference: refs[1]!, expectedRevision: active.revision, expectedBinding: active.binding });
    await expect(prepareModelSwitch('scope', refs[1]!, g.ports)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_ACTIVATION_CONFLICT' });
    expect((await g.activation()).state).toBe('inactive'); expect(current.state).toBe('active'); expect(g.sends).toHaveLength(0);
  });

  it('a real held account refuses preview with the reconciliation next step and no model send', async () => {
    const f = await fixture(); f.hold(); await f.turn();
    const before = await f.activation();
    const row = (await f.source.inspect()).choices.find(choice => choice.group === 'claude')!;
    expect(row.blocked).toContain('PROVIDER_SPEND_EXHAUSTED'); expect(row.blocked).toContain('uzlaştırın');
    await expect(prepareModelSwitch('scope', refs[1]!, f.ports)).rejects.toMatchObject({ code: 'PROVIDER_SPEND_EXHAUSTED' });
    expect(await f.activation()).toEqual(before); expect(f.sends).toHaveLength(1);
  });

  it('a changed binding is refused without reactivation', async () => {
    const f = await fixture(), before = await f.activation(); f.changeBinding();
    await expect(prepareModelSwitch('scope', refs[1]!, f.ports)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_ACTIVATION_CONFLICT' });
    expect(await f.activation()).toEqual(before); expect(f.sends).toHaveLength(0);
  });

  it('Escape closes preparation; a late completion cannot pin the model', async () => {
    const f = await fixture(), prepare = f.source.prepare!; let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    f.source.prepare = async choice => { await waiting; await prepare(choice); };
    await f.choose(1, false); await f.press(ENTER); await until(() => f.view.stdout.frame.includes(terminalPanelLabels('tr').loading), 'preparing');
    await f.press(ESC); release(); await settle(80); await f.turn(); expect(f.sends[0]!.provider).toBe('local');
  });
});
