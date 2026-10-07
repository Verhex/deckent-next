import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approvalRequestSchema } from '#domain/index.js';
import { ConfigApplication, configChangeApprovalFacts, parseConfigInput, sealApproval, type ConfigChangeOutcome, type ConfigWritePermission } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { approvalCardLines } from '#surfaces/core/terminal-work/index.js';
import { createWorklineLedgerPorts, workSurfaceLabels } from '#surfaces/core/cli/index.js';
import { configPanelPort, configSchemaChoices, configShortcut, configSlash, type ConfigCommandContext } from '#surfaces/core/config/index.js';
import { configPanelTree } from '#surfaces/core/terminal-panels/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';
import { composeCore } from '#composition/core/root/index.js';

// T3 L4 PANELS — `/config`: the window's port over the L2 write path, its policy locks (a read, never a write), the `key=value` shortcut and
// the config-change approval window in the words of a setting.
const NOW = 1_800_000_000_000;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

async function terminalRoot() {
  composeCore();
  const root = await mkdtemp(join(tmpdir(), 'config-panel-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true }); await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ terminal: { scopeId: 'scope' } }));
  return { root, options: { env: { HOME: root, DECKENT_GLOBAL_HOME: join(root, 'global') }, heal: false } };
}
const FIELDS = [
  { key: 'terminal.theme', value: 'auto', defaultValue: 'auto', source: 'default', descriptionKey: 'x.none', description: 'Colour theme', schema: { type: 'string', enum: ['auto', 'dark', 'light'] },
    binding: { state: 'bound', consumers: ['terminal'] }, apply: 'live', redacted: false },
  { key: 'max_workers', value: 4, defaultValue: 4, source: 'project', descriptionKey: 'x.none', description: 'Workers', schema: { type: 'integer', minimum: 1 },
    binding: { state: 'bound', consumers: ['runtime'] }, apply: 'restart', redacted: false },
  { key: 'language', value: 'en', defaultValue: 'en', source: 'default', descriptionKey: 'x.none', description: 'Language', schema: { type: 'string', enum: ['en', 'tr'] },
    binding: { state: 'bound', consumers: ['cli'] }, apply: 'live', redacted: false },
  { key: 'secrets.token', value: '[REDACTED]', defaultValue: null, source: 'project', descriptionKey: 'x.none', description: 'Token', schema: { type: 'string' },
    binding: { state: 'declared-only', reason: 'secret' }, apply: 'live', redacted: true },
];
function context(permissions: readonly ConfigWritePermission[] | Error | null, seen: { action: string; input: Record<string, unknown> }[], outcome?: ConfigChangeOutcome,
  principal = true): ConfigCommandContext {
  const app = {
    inspect: async () => ({ schemaVersion: 1, digest: null, layer: 'project', fields: FIELDS }),
    explain: async () => ({ apply: 'live' }),
    permissions: async () => { if (permissions instanceof Error) throw permissions; return permissions; },
    submit: async (action: string, input: Record<string, unknown>) => { seen.push({ action, input });
      return outcome ?? { status: 'applied', approvalId: null, result: { keyPath: input['keyPath'], layer: input['layer'], beforeDigest: null, afterDigest: digest('x'), backupPath: null, overridden: false } }; },
  };
  return { configApplication: () => app as never, ...(principal ? { resolveConfigPrincipal: async () => ({ id: 'owner', issuer: 'host', subject: '1000', scopeIds: ['scope'] }) as never } : {}) };
}
const allow = (keyPath: string, layer: 'project' | 'global'): ConfigWritePermission => ({ keyPath, layer, decision: 'allow', ruleId: 'r-allow' });

describe('/config window port', () => {
  it('locks follow the policy read per layer: deny locks with why, approval is a note, secrets are refused; choices come from the schema', async () => {
    const { root, options } = await terminalRoot();
    const permissions: ConfigWritePermission[] = [allow('terminal.theme', 'project'), allow('terminal.theme', 'global'),
      { keyPath: 'max_workers', layer: 'project', decision: 'require-approval', ruleId: 'company-config-approval' }, { keyPath: 'max_workers', layer: 'global', decision: 'deny', ruleId: null },
      { keyPath: 'language', layer: 'project', decision: 'deny', ruleId: null }, { keyPath: 'language', layer: 'global', decision: 'deny', ruleId: null },
      { keyPath: 'secrets.token', layer: 'project', decision: 'refused', ruleId: null }, { keyPath: 'secrets.token', layer: 'global', decision: 'refused', ruleId: null }];
    const view = await configPanelPort(root, context(permissions, []), options, 'tr').inspect();
    const field = (key: string) => view.fields.find(item => item.key === key)!;
    expect(field('terminal.theme')).toMatchObject({ choices: [{ label: 'auto', value: 'auto' }, { label: 'dark', value: 'dark' }, { label: 'light', value: 'light' }], free: false,
      locks: { project: { blocked: null, note: null }, global: { blocked: null, note: null } }, unsettable: false });
    expect(field('max_workers')).toMatchObject({ free: true, unsettable: true, apply: 'yeniden', locks: { project: { blocked: null, note: 'onay ister (kural company-config-approval)' } } });
    expect(field('max_workers').locks.global.blocked).toContain('bu katmanda değiştirmenize izin vermiyor');
    expect(field('language').locks.project.blocked).toContain('policy');
    expect(field('secrets.token')).toMatchObject({ sensitive: true, locks: { project: { blocked: 'Sırlar buradan değil, deckent secret ile değiştirilir.' } } });
    // The tree: a key every layer refuses is a locked row with its reason; one open layer keeps it open and the scope step locks the other.
    const labels = terminalPanelLabels('tr').config;
    const tree = configPanelTree(view, labels, 'max_workers');
    const general = tree.items.find(item => item.id === labels.general)!;
    expect(general.children!.find(item => item.id === 'language')!.blocked?.reason).toContain('policy');
    expect(general.children!.find(item => item.id === 'max_workers')!.blocked).toBeUndefined();
    expect(tree.scopes!.find(scope => scope.id === 'global')!.blocked?.reason).toContain('bu katmanda değiştirmenize izin vermiyor');
    expect(tree.scopes!.find(scope => scope.id === 'project')!.label).toContain('onay ister');
  });
  it('without the principal\'d write route every key is locked read-only; an unreadable policy shows no locks and says why', async () => {
    const { root, options } = await terminalRoot();
    const readOnly = await configPanelPort(root, context(null, [], undefined, false), options, 'en').inspect();
    expect(readOnly.fields.every(field => field.locks.project.blocked && field.locks.global.blocked)).toBe(true);
    expect(readOnly.notes.join('\n')).toContain('read only');
    const unread = await configPanelPort(root, context(Object.assign(new Error('x'), { code: 'POLICY_UNAVAILABLE' }), []), options, 'en').inspect();
    expect(unread.fields.every(field => !field.locks.project.blocked && !field.locks.global.blocked)).toBe(true);
    expect(unread.notes.join('\n')).toContain('POLICY_UNAVAILABLE');
  });
  it('writes only through the L2 port with the chosen layer; a pending approval names its id and writes nothing', async () => {
    const { root, options } = await terminalRoot();
    const seen: { action: string; input: Record<string, unknown> }[] = [];
    const port = configPanelPort(root, context([], seen), options, 'en');
    const applied = await port.write({ action: 'set', keyPath: 'terminal.theme', value: 'dark', layer: 'global' });
    expect(applied.status).toBe('applied'); expect(seen[0]).toMatchObject({ action: 'set', input: { keyPath: 'terminal.theme', value: 'dark', layer: 'global', scopeId: 'scope' } });
    await port.write({ action: 'unset', keyPath: 'max_workers', layer: 'project' });
    expect(seen[1]).toMatchObject({ action: 'unset', input: { keyPath: 'max_workers', layer: 'project' } }); expect(seen[1]!.input).not.toHaveProperty('value');
    const pending: ConfigChangeOutcome = { status: 'approval-pending', commandId: 'cmd-9', expect: null, keyPath: 'max_workers', layer: 'project',
      approval: { approvalId: 'appr-9', revision: 0, expiresAt: NOW, summary: 'Setting will change: max_workers 4 → 2 (project)' } };
    const held = await configPanelPort(root, context([], [], pending), options, 'en').write({ action: 'set', keyPath: 'max_workers', value: 2, layer: 'project' });
    expect(held).toMatchObject({ status: 'approval-pending', approvalId: 'appr-9' });
    expect(held.lines.join('\n')).toContain('Nothing was written');
  });
  it('an entry is read by the key\'s own schema: the text itself, else its JSON; a value that does not fit says what it takes and is not sent', async () => {
    composeCore();
    expect(parseConfigInput('terminal.theme', 'dark')).toEqual({ ok: true, value: 'dark' });
    expect(parseConfigInput('max_workers', '2')).toEqual({ ok: true, value: 2 });
    expect(parseConfigInput('max_workers', 'two')).toEqual({ ok: false });
    const { root, options } = await terminalRoot();
    const port = configPanelPort(root, context([], []), options, 'tr');
    await port.inspect();
    expect(port.parse('max_workers', 'two')).toEqual({ ok: false, reason: expect.stringContaining('integer') });
    expect(configSchemaChoices({ type: 'boolean' })).toEqual([true, false]);
    expect(configSchemaChoices({ anyOf: [{ const: 'a' }, { type: 'string' }] })).toEqual([]);
  });
});

describe('/config key=value', () => {
  it('sets the project layer through the same write port, typed by the key\'s schema; a value that does not fit writes nothing', async () => {
    expect(configShortcut('terminal.theme=dark')).toEqual({ keyPath: 'terminal.theme', text: 'dark' });
    expect(configShortcut('set terminal.theme dark')).toBeNull();
    const { root, options } = await terminalRoot();
    const seen: { action: string; input: Record<string, unknown> }[] = [];
    const lines = await configSlash(root, 'max_workers=2', context([], seen), options, 'en', 80);
    expect(seen).toEqual([{ action: 'set', input: expect.objectContaining({ keyPath: 'max_workers', value: 2, layer: 'project' }) }]);
    expect(lines.join('\n')).toContain('max_workers');
    const refused = await configSlash(root, 'max_workers=two', context([], seen), options, 'tr', 80);
    expect(refused).toEqual(['max_workers bu değeri almıyor; hiçbir şey yazılmadı. Neler aldığını /config max_workers gösterir.']);
    expect(seen).toHaveLength(1);
    expect(await configSlash(root, 'max_workers=2', context([], seen, undefined, false), options, 'en', 80)).toEqual([expect.stringContaining('read only')]);
    expect(seen).toHaveLength(1);
  });
});

describe('ConfigApplication.permissions', () => {
  it('reads every key through one batched policy read when the port can, else per key with a denial as `deny`; secrets never reach the policy', async () => {
    const asked: string[][] = [];
    const documents = { snapshot: async () => { throw new Error('unused'); }, publish: async () => { throw new Error('unused'); } };
    const batched = new ConfigApplication(documents as never, { authorize: async () => 'r', audit: async () => undefined, approvals: {
      evaluate: async () => { throw new Error('per-key read used'); }, admit: async () => { throw new Error('unused'); },
      evaluateMany: async inputs => { asked.push(inputs.map(input => `${input.layer}:${input.keyPath}`)); return inputs.map(input => ({ decision: input.keyPath === 'language' ? 'deny' as const : 'allow' as const, ruleId: 'r' })); } } });
    const principal = { id: 'owner', issuer: 'host', subject: '1000', scopeIds: ['scope'] } as never;
    expect(await batched.permissions({ principal, scopeId: 'scope', keys: ['language', 'secrets.token'], layers: ['project', 'global'] })).toEqual([
      { keyPath: 'language', layer: 'project', decision: 'deny', ruleId: 'r' }, { keyPath: 'language', layer: 'global', decision: 'deny', ruleId: 'r' },
      { keyPath: 'secrets.token', layer: 'project', decision: 'refused', ruleId: null }, { keyPath: 'secrets.token', layer: 'global', decision: 'refused', ruleId: null }]);
    expect(asked).toEqual([['project:language', 'global:language']]);
    const single = new ConfigApplication(documents as never, { authorize: async () => 'r', audit: async () => undefined, approvals: {
      evaluate: async input => { if (input.layer === 'global') throw Object.assign(new Error('denied'), { code: 'POLICY_DENIED' }); return { decision: 'require-approval', revision: 'r', ruleId: 'rule-1' }; },
      admit: async () => { throw new Error('unused'); } } });
    expect(await single.permissions({ principal, scopeId: 'scope', keys: ['max_workers'], layers: ['project', 'global'] })).toEqual([
      { keyPath: 'max_workers', layer: 'project', decision: 'require-approval', ruleId: 'rule-1' }, { keyPath: 'max_workers', layer: 'global', decision: 'deny', ruleId: null }]);
    const none = new ConfigApplication(documents as never, { authorize: async () => 'r', audit: async () => undefined });
    expect(await none.permissions({ principal, scopeId: 'scope', keys: ['max_workers'], layers: ['project'] })).toBeNull();
  });
});

describe('config-change approval window in the words of a setting', () => {
  const integrity = createHmacIntegrity('key', randomBytes(32));
  const record = (summary: string) => sealApproval({ request: approvalRequestSchema.parse({ schemaVersion: 3, approvalId: '7a48a7f0-164d-4a2f-9353-3c3079009bec', scopeId: 'scope',
    subject: { kind: 'config-change', commandId: 'cmd-1', action: 'set', layer: 'project', keyPath: 'terminal.theme', before: '"auto"', after: '"dark"',
      expectDigest: digest('layer'), valueDigest: digest('dark'), ruleId: 'company-config-approval' },
    requester: { id: 'owner', issuer: 'host', subject: '1000' }, actionDigest: digest('action'), policyRevision: 'p1', summary, createdAt: NOW - 10_000, expiresAt: NOW + 590_000,
    facts: configChangeApprovalFacts(null, 'scope') }), revision: 0, status: 'pending', decision: null }, integrity);
  for (const [locale, summary, scope, why, undo] of [
    ['en', 'Setting will change: terminal.theme auto → dark (project)', 'Scope: only this setting: terminal.theme · project layer · this one change',
      "Why asked: Your company's rule company-config-approval asks for approval before this setting changes", 'Undo: Yes — the previous value is kept'],
    ['tr', 'ayar değişecek: terminal.theme auto → dark (proje)', 'Kapsam: yalnız bu ayar: terminal.theme · proje katmanı · yalnız bu değişiklik',
      'Neden soruluyor: Şirketinizin company-config-approval kuralı bu ayar değişmeden önce onay istiyor', 'Geri alınabilir mi: Evet — önceki değer saklı'],
  ] as const) {
    it(`${locale}: scope, why and undo name the setting, its layer and the company rule — never a tool call's words`, async () => {
      const ports = createWorklineLedgerPorts({ root: '/p', scopeId: 'scope', options: {}, locale, inspectWorkers: async () => ({}) as never, inspectRun: async () => ({}) as never,
        listApprovals: async () => [record(summary)], decideApproval: async () => ({}) })!;
      const [item] = (await ports.listApprovalPage!(null)).items;
      expect(item!.config).toEqual({ action: 'set', layer: 'project', keyPath: 'terminal.theme', ruleId: 'company-config-approval' });
      const lines = approvalCardLines(item!, workSurfaceLabels(locale), '', null, { project: '/home/u/acme', mode: 'standart' }, NOW).map(line => line.replace(/\s+/gu, ' ').trim());
      expect(lines).toContain(scope); expect(lines).toContain(why); expect(lines).toContain(undo);
      expect(lines.join('\n')).not.toMatch(/yalnız bu çağrı|only this call|araç bildirmedi|tool did not say/u);
    });
  }
});
