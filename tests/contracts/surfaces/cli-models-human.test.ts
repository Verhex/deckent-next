import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearConfigCache, ErrorRegistry } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { main } from '#surfaces/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

registerProviderConfig(); // the `terminal` section (terminal.scopeId) is registered by the composed entry

/*
 * C-MODELS (alpha.48, owner CLI review 2026-10-19 `models`): one table of the models a scope can use, grouped by channel, the retirement
 * shown in words with a configurable warning (law 6: `models.retirementWarningDays`, default 15), the declared list behind `--declared`,
 * a person's activation by selection (exact ids only, binding and revision read by the system, a scoped card), a bare `spending` summary.
 * Synthetic ids only. A person's card is simulated (the Ink view is PTY-proven on the built binary).
 */
const card = vi.hoisted(() => ({ interactive: false, answers: [] as (string | null)[], asked: [] as CliCardRequest[] }));
vi.mock('#surfaces/core/cli-human/index.js', async importOriginal => {
  const real = await importOriginal<typeof import('#surfaces/core/cli-human/index.js')>();
  return { ...real,
    cliMode: (context: Parameters<typeof real.cliMode>[0], json?: boolean) => card.interactive && !json ? { mode: 'interactive' as const, reason: 'tty' as const } : real.cliMode(context, json),
    askCliCard: async (request: CliCardRequest, io: Parameters<typeof real.askCliCard>[1]) => {
      if (!card.interactive) return real.askCliCard(request, io);
      card.asked.push(request); return card.answers.length ? card.answers.shift()! : null;
    } };
});
const roots: string[] = [];
beforeEach(() => { card.interactive = false; card.answers = []; card.asked = []; vi.useFakeTimers({ now: new Date('2026-10-19T12:00:00Z'), toFake: ['Date'] }); });
afterEach(async () => { vi.useRealTimers(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function project(config: Record<string, unknown> = { terminal: { scopeId: 'live' } }, language = 'en') {
  const base = await mkdtemp(join(tmpdir(), 'deckent-cli-models-')); roots.push(base);
  const home = join(base, 'home'), root = join(base, 'project');
  await mkdir(join(root, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(root, '.deckent', 'config.json'), JSON.stringify(config), { mode: 0o600 });
  return { root, env: { HOME: home, USERPROFILE: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', DECKENT_LANGUAGE: language, NO_COLOR: '1' } };
}
const capture = () => { const lines: string[] = []; return { text: () => lines.join(''), sink: { write: (text: string) => { lines.push(String(text)); return true; } } }; };
const lifecycle = (state: string, retireNotBefore: string | null = null, retiredOn: string | null = null) => ({ state, deprecatedOn: null, retireNotBefore, retiredOn, source: null });
const entry = (modelId: string, life: ReturnType<typeof lifecycle>, state: 'active' | 'inactive' | null, efforts: string[] = ['low', 'high']) => ({ modelId, revision: 1,
  model: { id: modelId, version: 1, nativeId: modelId, protocols: [], lifecycle: life, minCliVersion: null, efforts, aliases: ['alias-of-' + modelId] },
  activation: state ? { state, revision: 4 } : null });
const catalog = { schemaVersion: 1, scopeId: 'live', channels: [
  { channelId: 'sub-a', access: 'allowed', revision: 1, providerVersion: 1, catalogRevision: 'r1', channel: { kind: 'native-cli', cli: 'claude', aliases: [] }, activation: { state: 'active', revision: 1 },
    models: [entry('model-a-1', lifecycle('active'), 'active'), entry('model-a-old', lifecycle('active', '2026-10-15'), 'inactive'),
      entry('model-a-soon', lifecycle('deprecated', '2026-10-29'), 'active')] },
  { channelId: 'api-b', access: 'allowed', revision: 1, providerVersion: 1, catalogRevision: 'r1', channel: { kind: 'http-api', cli: null, aliases: [] }, activation: { state: 'active', revision: 1 },
    models: [entry('model-b-later', lifecycle('active', '2026-11-08'), 'active', [])] },
  { channelId: 'sub-c', access: 'denied' }] };
const declared = { schemaVersion: 1, availability: 'not-observed', status: 'declared', catalog: { schemaVersion: 1, revision: 'connect-1', providers: [
  { id: 'prov-a', version: 1, models: [{ id: 'model-x', version: 2, nativeId: 'model-x-exact-2', protocols: [{ family: 'openai-chat-completions', version: 1, capabilities: [] }] }] }] } };
function host(f: Awaited<ReturnType<typeof project>>, calls: { kind: string; value: unknown }[] = [], extra: Record<string, unknown> = {}) {
  const out = capture(), err = capture();
  const context = { root: f.root, env: f.env, stdin: Object.assign(Readable.from([]), { isTTY: false }), stdout: out.sink, stderr: err.sink,
    configChoiceSources: () => ({ list: async () => [{ value: 'live' }, { value: 'other' }] }),
    inspectModelCatalog: async (_root: string, query: unknown) => { calls.push({ kind: 'catalog', value: query }); return catalog; },
    inspectDeclaredModels: async () => { calls.push({ kind: 'declared', value: null }); return declared; },
    inspectModelBinding: async (_root: string, reference: unknown) => { calls.push({ kind: 'binding', value: reference });
      return { schemaVersion: 1, reference, availability: 'not-observed', status: 'declared', catalogRevision: 'connect-1', definition: { model: { nativeId: 'model-x-exact-2' } },
        binding: { encodingVersion: 1, algorithm: 'sha256', digest: 'd'.repeat(64) } }; },
    inspectModelActivation: async (_root: string, query: { scopeId: string; reference: unknown }) => { calls.push({ kind: 'activation', value: query });
      return { schemaVersion: 1, scopeId: query.scopeId, reference: query.reference, activation: { state: 'active', revision: 3 }, availability: 'not-observed' }; },
    admitModelActivation: async (_root: string, command: Record<string, unknown>) => { calls.push({ kind: 'admit', value: command });
      return { replayed: false, receipt: { command, record: { reference: command['reference'], revision: 4, state: command['action'] === 'activate' ? 'active' : 'inactive' } } }; },
    applyModelCatalog: async (_root: string, command: Record<string, unknown>) => { calls.push({ kind: 'apply', value: command });
      return { replayed: false, receipt: { command, authorizations: [{ level: 'scope' }], changes: [{ kind: 'activation', channelId: command['channelId'], modelId: command['modelId'], revision: 5 }] } }; },
    inspectProviderSpendAccount: async (_root: string, query: unknown) => { calls.push({ kind: 'spending', value: query });
      return { schemaVersion: 1, scopeId: 'live', budgetId: 'scope-budget', budgetRevision: 2, checkpoint: { revision: 7, reservationCount: 1, digest: 'c'.repeat(64),
        account: { budget: { currency: 'USD', limitMinorUnits: 5000, budgetId: 'scope-budget', revision: 2 }, reservedMinorUnits: 120, settledExactMinorUnits: "1234.5", settledMinorUnits: 1235, frozen: false } },
      spendingHistoryIntegrity: 'not-recorded', audit: null }; },
    ...extra };
  return { out, err, calls, context: context as never };
}

it('bare models: one table of the scope\'s models grouped by channel, state in words, retired with its date, no raw values (EN)', async () => {
  const f = await project(), h = host(f);
  expect(await main(['models'], h.context)).toBe(0);
  expect(h.calls).toEqual([{ kind: 'catalog', value: { schemaVersion: 1, scopeId: 'live' } }]);
  const text = h.out.text();
  expect(text).toContain('scope: live (default)');
  expect(text).toContain('Models you can use in scope live');
  expect(text).toMatch(/Model\s+Channel\s+State\s+Effort/u);
  expect(text).toMatch(/model-a-1\s+subscription claude\s+active\s+low, high/u);
  expect(text).toMatch(/model-a-old\s+subscription claude\s+retired \(2026-10-15\)/u);
  expect(text).toMatch(/model-b-later\s+API api-b\s+active/u);
  expect(text).toMatch(/sub-c.*no access/u);
  expect(text).toMatch(/model-a-soon.*2026-10-29.*10 days/u);
  expect(text).not.toMatch(/model-b-later retires/u);
  expect(text).not.toMatch(/@1|aliases|alias-of|catalog r1|—|\{/u);
  const json = host(f);
  expect(await main(['models', '--catalog', '--json'], json.context)).toBe(0);
  expect(JSON.parse(json.out.text())).toEqual(catalog);
  // Lead J2e (C-MODELS decision 2): plain `models --json` keeps the declared-list contract; the catalog JSON is behind `--catalog` (or `--scope`).
  const plain = host(f);
  expect(await main(['models', '--json'], plain.context)).toBe(0);
  expect(JSON.parse(plain.out.text())).toEqual(declared);
  expect(plain.calls).toEqual([{ kind: 'declared', value: null }]);
  const scoped = host(f);
  expect(await main(['models', '--scope', 'live', '--json'], scoped.context)).toBe(0);
  expect(JSON.parse(scoped.out.text())).toEqual(catalog);
  const both = host(f);
  expect(await main(['models', '--declared', '--catalog', '--json'], both.context)).toBe(2);
  expect(both.err.text()).toContain('CLI_USAGE'); expect(both.calls).toEqual([]);
});

it('the retirement warning threshold is the config field (law 6): 30 days warns about a model 20 days away; the TR table reads in Turkish', async () => {
  const f = await project({ terminal: { scopeId: 'live' }, models: { retirementWarningDays: 30 } }, 'tr'), h = host(f);
  expect(await main(['models'], h.context)).toBe(0);
  const text = h.out.text();
  expect(text).toContain("Scope live'da kullanılabilir modeller");
  expect(text).toMatch(/Model kimliği\s+Kanal\s+Durum\s+Effort düzeyi/u);
  expect(text).toMatch(/model-a-old\s+abonelik claude\s+emekli \(2026-10-15\)/u);
  expect(text).toMatch(/model-b-later.*2026-11-08.*20 gün/u);
  expect(text).toMatch(/sub-c.*erişim yok/u);
});

it('--declared shows the connected providers\' declarations; --scope names another scope; spending bare reads the default scope\'s budget', async () => {
  const f = await project(), h = host(f);
  expect(await main(['models', '--declared'], h.context)).toBe(0);
  expect(h.calls.map(call => call.kind)).toEqual(['declared']);
  expect(h.out.text()).toContain('model-x-exact-2'); expect(h.out.text()).not.toMatch(/\[|@v1|:supported/u);
  const other = host(f);
  expect(await main(['models', '--scope', 'other'], other.context)).toBe(0);
  expect(other.calls[0]).toEqual({ kind: 'catalog', value: { schemaVersion: 1, scopeId: 'other' } });
  const spending = host(f);
  expect(await main(['models', 'spending'], spending.context)).toBe(0);
  expect(spending.calls).toEqual([{ kind: 'spending', value: { schemaVersion: 1, scopeId: 'live', current: true } }]);
  expect(spending.out.text()).toContain('scope: live (default)');
  expect(spending.out.text()).toMatch(/50/u); expect(spending.out.text()).toMatch(/12[.,]35/u);
});

it('a person activates by selection: provider, then the exact model id (never an alias), binding and revision read by the system, a scoped card', async () => {
  card.interactive = true; card.answers = ['live', 'prov-a@1', 'model-x@2', 'apply'];
  const f = await project(), h = host(f);
  expect(await main(['models', 'activate'], h.context)).toBe(0);
  const modelPick = card.asked[2]!;
  expect(modelPick.options.map(option => option.label)).toEqual(['model-x-exact-2']);
  expect(card.asked[3]!.title).toContain('model-x-exact-2'); expect(card.asked[3]!.body?.join('\n')).toContain('live');
  const admitted = h.calls.find(call => call.kind === 'admit')!.value as Record<string, unknown>;
  expect(admitted).toMatchObject({ schemaVersion: 1, action: 'activate', scopeId: 'live', reference: { providerId: 'prov-a', providerVersion: 1, modelId: 'model-x', modelVersion: 2 },
    expectedRevision: 3, expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: 'd'.repeat(64) }, catalogRevision: 'connect-1' });
  // A cancelled card writes nothing.
  card.answers = ['live', 'prov-a@1', 'model-x@2', 'cancel'];
  const cancelled = host(f);
  expect(await main(['models', 'activate'], cancelled.context)).not.toBe(0);
  expect(cancelled.calls.some(call => call.kind === 'admit')).toBe(false);
});

it('a catalog model is switched on or off by selection in the scope (expected revision read by the system); a denied switch names the next step', async () => {
  card.interactive = true; card.answers = ['sub-a', 'model-a-1', 'apply'];
  const f = await project(), h = host(f);
  expect(await main(['models', 'catalog', 'deactivate', '--scope', 'live'], h.context)).toBe(0);
  expect(card.asked[1]!.options.map(option => option.id)).not.toContain('alias-of-model-a-1');
  expect(h.calls.find(call => call.kind === 'apply')!.value).toMatchObject({ schemaVersion: 1, scopeId: 'live', action: 'deactivate', channelId: 'sub-a', modelId: 'model-a-1', expectedRevision: 4 });
  card.answers = ['sub-a', 'model-a-1', 'apply'];
  const denied = host(f, [], { applyModelCatalog: async () => { throw ErrorRegistry.createError('POLICY_DENIED'); } });
  expect(await main(['models', 'catalog', 'deactivate', '--scope', 'live'], denied.context)).not.toBe(0);
  expect(denied.err.text()).toContain('POLICY_DENIED');
  expect(denied.err.text()).toMatch(/model-activation.*deactivate/u);
  // Off a terminal the long AI form is unchanged: flags required, nothing is asked.
  card.interactive = false;
  const piped = host(f);
  expect(await main(['models', 'catalog', 'deactivate', '--scope', 'live'], piped.context)).toBe(2);
  expect(piped.calls.some(call => call.kind === 'apply')).toBe(false);
});
