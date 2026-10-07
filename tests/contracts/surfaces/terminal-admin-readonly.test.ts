import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyModelCatalog, inspectModelCatalog } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache, ErrorRegistry } from '#platform/index.js';
import { runKernelCommand } from '#surfaces/core/cli/index.js';
import { terminalAdminPorts, type TerminalAdminContext } from '#surfaces/core/terminal-admin/index.js';
import { WORKLINE_SLASH_COMMANDS, EMPTY_SESSION_USAGE, addSessionUsage } from '#surfaces/core/terminal-kit/index.js';
import type { WorklineProps } from '#surfaces/core/terminal/index.js';
import { mountWorkline, settle, until as harnessUntil } from '../support/workline-harness.js';
import { seedCatalog, SEED_CHANNEL } from '../support/model-catalog.js';

// TERMINAL-CLOSE S09: read-only /status /model /usage /doctor /scope. Every call asks its typed producer again; a failed query shows its typed
// error and never an earlier value. The /model path runs on the real catalog application and ledger (the same handler the CLI context holds).
const until = (check: () => boolean, label: string) => harnessUntil(check, label, 300);
const roots: string[] = [], views: Array<ReturnType<typeof mountWorkline>> = [];
afterEach(async () => { for (const view of views.splice(0)) view.instance.unmount(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function type(view: ReturnType<typeof mountWorkline>, text: string) { for (const char of text) { view.stdin.write(char); await settle(2); } }
async function open(props: Partial<WorklineProps>) {
  const view = mountWorkline(props); views.push(view);
  await until(() => view.stdout.frame.includes('READY'), 'workline ready');
  return view;
}
const typed = (code: string) => ErrorRegistry.createError(code as never);
const base = { root: '/unused', scopeId: 's', installationId: 'inst-1', projectId: 'proj-1', options: {}, status: async () => 'STATUS-BODY', doctor: async () => undefined };

async function catalogFixture() {
  const project = await mkdtemp(join(tmpdir(), 'dn-term-admin-')); roots.push(project); const data = join(project, 'd');
  await mkdir(join(project, '.deckent'), { recursive: true });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data } }));
  const options = { env: { HOME: join(project, 'h') } };
  (await openConfiguredAttemptStore(project, options)).store.close();
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'catalog', effect: 'allow', actions: ['activate', 'deactivate', 'inspect'], scopes: 'all', principals, resource: { kind: 'model-activation', ids: 'all' } },
  ] }), { mode: 0o600 });
  return { project, options };
}

describe('terminal read-only management (S09)', () => {
  it('registers /model /usage /doctor /scope with catalog descriptions in both locales', () => {
    for (const name of ['model', 'usage', 'doctor', 'scope']) {
      const command = WORKLINE_SLASH_COMMANDS.find(entry => entry.name === name);
      expect(command, name).toMatchObject({ descriptionKey: `terminal.slash.${name}` });
      expect(command?.argumentKey).toBeUndefined();
    }
  });

  describe.skipIf(process.platform === 'win32')('/model on the real catalog application', () => {
    it.each(['en', 'tr'] as const)('lists the ledger catalog with activation state and marks the current model (%s)', async locale => {
      const { project, options } = await catalogFixture();
      await applyModelCatalog(project, { schemaVersion: 1, commandId: 'seed', scopeId: 's', action: 'register', catalog: await seedCatalog() }, options);
      // A real chat reference names the provider (= ledger channel) and the catalog model id; the ledger lists the native id.
      const reference = { providerId: SEED_CHANNEL, providerVersion: 1, modelId: 'opus-5-5', modelVersion: 1 };
      const ports = terminalAdminPorts({ ...base, root: project, options, locale, context: { inspectModelCatalog: inspectModelCatalog as never,
        describeTerminalChatPlan: async () => ({ status: 'ready', reference }) } }).inspect;
      const first = (await ports.model!('', { usage: EMPTY_SESSION_USAGE })).join('\n');
      expect(first).toContain(SEED_CHANNEL); expect(first).toContain('claude-opus-5-5'); expect(first).toContain(`${SEED_CHANNEL}@1/opus-5-5@1`);
      const mark = locale === 'en' ? '<- current' : '<- geçerli';
      expect(first.split('\n').filter(line => line.includes(mark)).map(line => line.trim().split(/\s+/u)[0])).toEqual(['claude-opus-5-5']); expect(first).toContain(locale === 'en' ? 'inactive' : 'etkin değil');
      // Activation changes what the very next call shows: nothing is remembered between calls.
      await applyModelCatalog(project, { schemaVersion: 1, commandId: 'on', scopeId: 's', action: 'activate', channelId: SEED_CHANNEL, modelId: 'claude-opus-5-5', expectedRevision: 0 }, options);
      const second = (await ports.model!('', { usage: EMPTY_SESSION_USAGE })).join('\n');
      expect(second).toMatch(/claude-opus-5-5 +\S+ +(active|etkin)\b/u);
    });

    it('shows the catalog inside the real workline and refuses arguments (selection is a later governed step)', async () => {
      const { project, options } = await catalogFixture();
      await applyModelCatalog(project, { schemaVersion: 1, commandId: 'seed', scopeId: 's', action: 'register', catalog: await seedCatalog() }, options);
      const { inspect } = terminalAdminPorts({ ...base, root: project, options, locale: 'en', context: { inspectModelCatalog: inspectModelCatalog as never } });
      const view = await open({ inspect });
      await type(view, '/model \r');
      await until(() => view.stdout.text.includes(SEED_CHANNEL) && view.stdout.text.includes('availability of a model is not observed'), 'catalog in the workline');
      expect(view.stdout.text).toContain('Current model');
      const mark = view.stdout.text.length;
      await type(view, '/model claude-opus-5-5\r');
      await until(() => view.stdout.text.slice(mark).includes('Usage: /model'), 'argument refused');
    });
  });

  // BATCH-FIX 2026-10-07 MODEL-CURRENT (P2-3b): the mark follows the exact reference; the same model id under another provider channel or
  // another provider/model version is not the current model.
  it('/model marks only the entry of the exact provider, provider version and model version', async () => {
    // Codex-style rows: the native id equals the catalog id, so a bare model-id comparison matched every provider's row.
    const entry = (id: string, version: number) => ({ modelId: id, revision: 1, model: { id, version, lifecycle: { state: 'active' } }, activation: null });
    const channel = (channelId: string, providerVersion: number, models: unknown[]) => ({ channelId, access: 'allowed' as const, revision: 1, providerVersion,
      catalogRevision: 'c', channel: { kind: 'native-cli' }, activation: null, models });
    const catalog = { schemaVersion: 1, scopeId: 's', channels: [channel('provider-a', 1, [entry('m', 1), entry('m', 2)]), channel('provider-b', 1, [entry('m', 1)]),
      channel('provider-c', 2, [entry('m', 1)])] };
    const marked = async (reference: { providerId: string; providerVersion: number; modelId: string; modelVersion: number }) => {
      const { inspect } = terminalAdminPorts({ ...base, locale: 'en', context: { inspectModelCatalog: async () => catalog as never,
        describeTerminalChatPlan: async () => ({ status: 'ready', reference }) } });
      const lines = (await inspect.model!('', { usage: EMPTY_SESSION_USAGE }));
      let channelId = '';
      return lines.flatMap(line => { const head = /^(provider-\w)\b/u.exec(line.trim()); if (head) channelId = head[1]!; return line.includes('<- current') ? [`${channelId}:${line.trim().split(/\s+/u)[0]}`] : []; });
    };
    expect(await marked({ providerId: 'provider-b', providerVersion: 1, modelId: 'm', modelVersion: 1 })).toEqual(['provider-b:m']);
    expect(await marked({ providerId: 'provider-a', providerVersion: 1, modelId: 'm', modelVersion: 2 })).toEqual(['provider-a:m']);
    expect(await marked({ providerId: 'provider-c', providerVersion: 1, modelId: 'm', modelVersion: 1 })).toEqual([]);
    expect(await marked({ providerId: 'provider-z', providerVersion: 1, modelId: 'm', modelVersion: 1 })).toEqual([]);
  });

  it('a failed query is a typed error and never an earlier value (/model, /status)', async () => {
    let failing = false;
    const context: TerminalAdminContext = { inspectModelCatalog: async () => {
      if (failing) throw typed('MODEL_CATALOG_UNAVAILABLE');
      return { schemaVersion: 1, scopeId: 's', channels: [{ channelId: 'ch-1', access: 'denied' as const }] } as never;
    } };
    let statusCalls = 0;
    const { inspect } = terminalAdminPorts({ ...base, locale: 'en', context, status: async () => { if (++statusCalls === 3) throw typed('SERVICE_UNAVAILABLE'); return `STATUS-READ-${statusCalls}`; } });
    expect((await inspect.model!('', { usage: EMPTY_SESSION_USAGE })).join('\n')).toContain('ch-1  access denied');
    failing = true;
    const failed = (await inspect.model!('', { usage: EMPTY_SESSION_USAGE })).join('\n');
    expect(failed).toContain('MODEL_CATALOG_UNAVAILABLE'); expect(failed).not.toContain('ch-1'); expect(failed).toContain('Model catalog: not read');
    const view = await open({ inspect });
    await type(view, '/status \r');
    await until(() => view.stdout.text.includes('STATUS-READ-1'), 'fresh status');
    await type(view, '/status \r');
    await until(() => view.stdout.text.includes('STATUS-READ-2'), 'status read again');
    await type(view, '/status \r');
    await until(() => view.stdout.text.includes('ERR:'), 'typed status failure');
    expect(statusCalls).toBe(3); expect(view.stdout.text).not.toContain('STATUS-LINE'); expect(view.stdout.text).not.toContain('STATUS-READ-3');
  });

  it('/status without a fresh port keeps the opening line', async () => {
    const view = await open({});
    await type(view, '/status \r');
    await until(() => view.stdout.text.includes('STATUS-LINE'), 'static line');
  });

  it('/usage reports what the terminal measured, then a typed spend account; a failed or malformed query shows no figure', async () => {
    const spend = vi.fn(async (_root: string, query: { budgetId: string; budgetRevision: number }) => {
      if (query.budgetId === 'broken') throw typed('PROVIDER_SPEND_UNAVAILABLE');
      return { schemaVersion: 2, scopeId: 's', budgetId: query.budgetId, budgetRevision: query.budgetRevision, checkpoint: null, audit: null, spendingHistoryIntegrity: 'not-recorded' } as never;
    });
    const { inspect } = terminalAdminPorts({ ...base, locale: 'en', context: { inspectProviderSpendAccount: spend as never } });
    const streamTurn = async function* () {
      yield { kind: 'text' as const, text: 'ok' };
      yield { kind: 'usage' as const, promptTokens: 30, completionTokens: 7, reasoningTokens: null };
      yield { kind: 'done' as const, finish: 'stop' as const };
    };
    const view = await open({ inspect, streamTurn });
    await type(view, '/usage \r');
    await until(() => view.stdout.text.includes('No token usage reported yet'), 'empty usage');
    await type(view, 'hi\r');
    await until(() => view.stdout.text.includes('30 in 7 out'), 'turn footer');
    await type(view, '/usage \r');
    await until(() => view.stdout.text.includes('prompt 30 tokens, completion 7 tokens, reasoning not measured'), 'measured usage');
    await type(view, '/usage b1 2\r');
    await until(() => spend.mock.calls.length === 1, 'spend query');
    expect(spend.mock.calls[0]![1]).toEqual({ schemaVersion: 1, scopeId: 's', budgetId: 'b1', budgetRevision: 2 });
    await until(() => view.stdout.text.includes('b1'), 'spend rendered');
    const mark = view.stdout.text.length;
    await type(view, '/usage broken 1\r');
    await until(() => view.stdout.text.slice(mark).includes('PROVIDER_SPEND_UNAVAILABLE'), 'typed spend failure');
    expect(view.stdout.text.slice(mark)).toContain('not read');
    await type(view, '/usage b1 zero\r/usage b1\r');
    await settle(100);
    expect(spend).toHaveBeenCalledTimes(2);
    expect(view.stdout.text.split('Usage: /usage').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('adds usage reports without losing earlier totals', () => {
    const total = addSessionUsage(addSessionUsage(EMPTY_SESSION_USAGE, { promptTokens: 1, completionTokens: 2, reasoningTokens: 3 }), { promptTokens: 4, completionTokens: 5, reasoningTokens: null });
    expect(total).toEqual({ reports: 2, promptTokens: 5, completionTokens: 7, reasoningTokens: 3, reasoningUnmeasured: 1 });
  });

  // BATCH-FIX 2026-10-07 USAGE-UNKNOWN (P2-3a): an unreported reasoning count is never summed as 0; a partial sum says what it misses.
  it.each([
    ['en', 'reasoning 3 tokens (', 'reasoning at least 3 tokens (not measured in 1 of 2 reports)', 'reasoning not measured'],
    ['tr', 'akıl yürütme 3 token (', 'akıl yürütme en az 3 token (2 raporun 1 tanesinde ölçülmedi)', 'akıl yürütme ölçülmedi'],
  ] as const)('/usage keeps an unmeasured reasoning count unknown (%s)', async (locale, measured, partial, none) => {
    const { inspect } = terminalAdminPorts({ ...base, locale, context: {} });
    const lines = async (...reasoning: (number | null)[]) => (await inspect.usage!('', { usage: reasoning.reduce((total, value) =>
      addSessionUsage(total, { promptTokens: 1, completionTokens: 1, reasoningTokens: value }), EMPTY_SESSION_USAGE) })).join('\n');
    expect(await lines(3)).toContain(measured);
    expect(await lines(3, null)).toContain(partial);
    const unknown = await lines(null, null);
    expect(unknown).toContain(none); expect(unknown).not.toMatch(/(reasoning|akıl yürütme) 0 tok/u);
  });

  it('/scope names each part it could not read and still shows the rest', async () => {
    const context: TerminalAdminContext = {
      inspectPermissionMode: async () => { throw typed('POLICY_DENIED'); },
      inspectSurfaceAccess: async () => ({ binding: 'bind-1', kinds: ['run', 'worker'] }),
    };
    const { inspect } = terminalAdminPorts({ ...base, root: '/nonexistent-root-for-scope-test', locale: 'en', context });
    const text = (await inspect.scope!('', { usage: EMPTY_SESSION_USAGE })).join('\n');
    expect(text).toContain('Scope: s'); expect(text).toContain('Installation: inst-1'); expect(text).toContain('Project: proj-1');
    expect(text).toContain('Permission mode: not read'); expect(text).toContain('POLICY_DENIED');
    expect(text).toContain('Surface access: bind-1 (run, worker)');
    expect((await inspect.scope!('x', { usage: EMPTY_SESSION_USAGE }))[0]).toContain('Usage: /scope');
    const none = terminalAdminPorts({ ...base, locale: 'tr', context: { inspectSurfaceAccess: async () => null } }).inspect;
    expect((await none.scope!('', { usage: EMPTY_SESSION_USAGE })).join('\n')).toContain('Yüzey erişimi: henüz yok');
  });

  it('/doctor shows what the host doctor wrote, and a doctor that fails shows its typed error', async () => {
    const ok = terminalAdminPorts({ ...base, locale: 'en', context: {}, doctor: async sink => { sink.write('DOCTOR-LINE-1\nDOCTOR-LINE-2\n'); } }).inspect;
    expect(await ok.doctor!('', { usage: EMPTY_SESSION_USAGE })).toEqual(['DOCTOR-LINE-1', 'DOCTOR-LINE-2']);
    // The real host doctor command, written into the captured sink (the wiring `terminal.ts` passes), human text in both languages.
    for (const locale of ['en', 'tr'] as const) {
      const root = await mkdtemp(join(tmpdir(), 'dn-term-doctor-')); roots.push(root); const env = { HOME: join(root, 'h'), USERPROFILE: join(root, 'h') };
      const real = terminalAdminPorts({ ...base, locale, context: {}, doctor: sink => runKernelCommand(['doctor', '--lang', locale], { root, env, stdout: sink, stderr: sink }) }).inspect;
      const lines = await real.doctor!('', { usage: EMPTY_SESSION_USAGE });
      expect(lines.length).toBeGreaterThan(3); expect(lines.join('\n')).not.toContain('"schemaVersion"');
    }
    const bad = terminalAdminPorts({ ...base, locale: 'en', context: {}, doctor: async () => { throw typed('CLI_USAGE'); } }).inspect;
    const view = await open({ inspect: bad });
    await type(view, '/doctor \r');
    await until(() => view.stdout.text.includes('ERR:'), 'typed doctor failure');
  });

  it('commands without a wired port answer plainly and are never unknown', async () => {
    const view = await open({});
    await type(view, '/model \r/usage \r/doctor \r/scope \r');
    await until(() => ['model', 'usage', 'doctor', 'scope'].every(name => view.stdout.text.includes(`NO-PORT ${name}`)), 'unwired notices');
    expect(view.stdout.text).not.toContain('UNKNOWN');
  });
});
