import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigApplication, ConfigApplicationError } from '#engine/index.js';
import { createConfigFileDocuments, discoverConfigRecordFiles, readConfigRecordFile } from '#adapters/index.js';
import { composeCore } from '#composition/core/root/index.js';
import { configPanelPort, configRecordPort, type ConfigCommandContext, type ConfigChoiceSourcePort } from '#surfaces/core/config/index.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const execution = { docker: { executable: 'docker', imageId: `sha256:${'a'.repeat(64)}`, memoryBytes: 1, pids: 1, cpus: 1, logMaxSizeKiB: 1, logMaxFiles: 1,
  tmpBytes: 1, deadlineMs: 1, controlTimeoutMs: 1, outputBytes: 1 }, git: { gitExecutable: 'git', timeoutMs: 1 }, adoption: { targets: ['refs/heads/main'] } };
async function fixture(extra = {}, policy: 'allow' | 'deny' | 'approval' = 'allow') {
  composeCore(); const root = await mkdtemp(join(tmpdir(), 'config-records-')); roots.push(root);
  const path = join(root, '.deckent/config.json'); await mkdir(join(root, '.deckent'));
  await writeFile(path, JSON.stringify({ terminal: { scopeId: 'test' }, ...extra }));
  const options = { env: { HOME: root, DECKENT_GLOBAL_HOME: join(root, 'global') }, heal: false };
  const documents = createConfigFileDocuments(root, options), audits: unknown[] = [], writes: unknown[] = [];
  let decision = policy;
  const app = new ConfigApplication({ ...documents, publish: async (input, plan) => { writes.push(input); return documents.publish(input, plan); } }, {
    authorize: async () => { if (decision === 'deny') throw new ConfigApplicationError('POLICY_DENIED'); return 'p1'; }, audit: async event => { audits.push(event); },
    approvals: { evaluate: async () => { if (decision === 'deny') throw new ConfigApplicationError('POLICY_DENIED'); return { decision: decision === 'approval' ? 'require-approval' : 'allow', revision: 'p1', ruleId: 'rule' }; },
      admit: async () => ({ pending: { approvalId: 'approval', revision: 1, expiresAt: Date.now() + 60000, summary: 'Change setting' } }) },
  });
  const context: ConfigCommandContext = { configApplication: () => app, resolveConfigPrincipal: async () => ({ id: 'owner', issuer: 'local-os', subject: '1000', assurance: 'os-user', scopeIds: ['test'] }) as never };
  const sources: ConfigChoiceSourcePort = { list: async source => (source === 'scopes' ? ['test'] : source === 'branches' ? ['refs/heads/main', 'refs/heads/dev'] : source === 'paths' ? [root] : []).map(value => ({ id: value, label: value, value })),
    browse: directory => discoverConfigRecordFiles(directory, { maxEntries: 64, timeoutMs: 1000, outputBytes: 4096 }), readDocument: file => readConfigRecordFile(file, 4096) };
  return { root, path, options, context, sources, app, audits, writes, policy: (next: typeof policy) => { decision = next; }, port: configRecordPort(root, context, options, 'en', sources), document: async () => JSON.parse(await readFile(path, 'utf8')) };
}
describe('config record editors: actual config publication', () => {
  it('budgets: add from scope and stage-1 USD choices, edit and remove, each preview is inert and each commit audited', async () => {
    const f = await fixture();
    await f.port.open('provider_spending.budgets', 'project'); const draft = await f.port.draft(null);
    expect(draft.fields[1]).toMatchObject({ choices: [expect.objectContaining({ value: 5 }), expect.objectContaining({ value: 10 }), expect.objectContaining({ value: 25 }), expect.objectContaining({ value: 50 }), expect.objectContaining({ value: 100 })], stepper: { min: 1, max: 1000, step: 1 } });
    const add = await f.port.preview(null, { scopeId: 'test', usd: 25 }); expect(f.writes).toHaveLength(0); expect(add.after).toContain('2500');
    await f.port.commit(add.token); expect((await f.document()).provider_spending.budgets).toEqual([{ schemaVersion: 1, budgetId: 'scope-budget', revision: 1, currency: 'USD', scopeId: 'test', limitMinorUnits: 2500 }]);
    await f.port.open('provider_spending.budgets', 'project'); await f.port.draft('0'); const edit = await f.port.preview('0', { scopeId: 'test', usd: 26 }); await f.port.commit(edit.token);
    expect((await f.document()).provider_spending.budgets[0].limitMinorUnits).toBe(2600);
    await f.port.open('provider_spending.budgets', 'project'); const remove = await f.port.preview('0', null); await f.port.commit(remove.token);
    expect((await f.document()).provider_spending.budgets).toEqual([]); expect(f.audits).toHaveLength(3);
  });
  it('workers: folder, source type and principal scope selections add, edit and remove a stable generated member', async () => {
    const f = await fixture(); await f.port.open('inspection.workers.sources', 'project'); await f.port.draft(null);
    await f.port.commit((await f.port.preview(null, { path: f.root, scopeId: 'test', kind: 'next-project' })).token);
    const first = (await f.document()).inspection.workers.sources[0]; expect(first.id).toMatch(/^source-/u);
    await f.port.open('inspection.workers.sources', 'project'); await f.port.draft('0');
    await f.port.commit((await f.port.preview('0', { path: f.root, scopeId: 'test', kind: 'legacy-tasks' })).token);
    expect((await f.document()).inspection.workers.sources[0]).toEqual({ ...first, kind: 'legacy-tasks' });
    await f.port.open('inspection.workers.sources', 'project'); await f.port.commit((await f.port.preview('0', null)).token);
    expect((await f.document()).inspection.workers.sources).toEqual([]); expect(f.audits).toHaveLength(3);
  });
  it('adoption: discovered branches add, edit and remove; selected leaf preserves Docker/Git settings', async () => {
    const f = await fixture({ execution }); await f.port.open('execution.adoption.targets', 'project'); await f.port.draft(null);
    await f.port.commit((await f.port.preview(null, { branch: 'refs/heads/dev' })).token);
    expect((await f.document()).execution.adoption.targets).toEqual(['refs/heads/main', 'refs/heads/dev']);
    await f.port.open('execution.adoption.targets', 'project'); await f.port.draft('0');
    await expect(f.port.preview('0', { branch: 'refs/heads/dev' })).rejects.toThrow(); // duplicate before write
    await f.port.commit((await f.port.preview('0', null)).token);
    await f.port.open('execution.adoption.targets', 'project'); await f.port.draft('0');
    await f.port.commit((await f.port.preview('0', { branch: 'refs/heads/main' })).token);
    expect((await f.document()).execution).toMatchObject({ docker: execution.docker, git: execution.git, adoption: { targets: ['refs/heads/main'] } });
  });
  it('work targets: add, edit from discovered repository branches, and remove through the optional parent; keep other execution settings', async () => {
    const f = await fixture({ execution }); await f.port.open('execution.workTargets.targets', 'project'); await f.port.draft(null);
    await f.port.commit((await f.port.preview(null, { path: f.root, branch: 'refs/heads/main' })).token);
    const target = (await f.document()).execution.workTargets.targets[0]; expect(target).toMatchObject({ kind: 'git', path: f.root, baseRef: 'refs/heads/main' });
    await f.port.open('execution.workTargets.targets', 'project'); await expect(f.port.draft(null)).rejects.toThrow(); await f.port.draft('0');
    await f.port.commit((await f.port.preview('0', { path: f.root, branch: 'refs/heads/dev' })).token);
    expect((await f.document()).execution.workTargets.targets[0]).toEqual({ ...target, baseRef: 'refs/heads/dev' });
    await f.port.open('execution.workTargets.targets', 'project'); await f.port.commit((await f.port.preview('0', null)).token);
    expect((await f.document()).execution).not.toHaveProperty('workTargets'); expect((await f.document()).execution.docker).toEqual(execution.docker); expect(f.audits).toHaveLength(3);
  });
  it('layout resources: select registry resource and relative location, edit, remove; refuse fixed resources and escaping paths', async () => {
    const f = await fixture(); await f.port.open('layout.resources', 'project'); await f.port.draft(null, { resource: 'memory' });
    await f.port.commit((await f.port.preview(null, { resource: 'memory', path: 'brain/memory.db' })).token);
    expect((await f.document()).layout.resources).toEqual({ memory: 'brain/memory.db' });
    await f.port.open('layout.resources', 'project'); await f.port.draft('0');
    const location = join(f.root, '.deckent/custom-memory.db'); await writeFile(location, ''); await f.port.browse(join(f.root, '.deckent'));
    await f.port.commit((await f.port.preview('0', { resource: 'memory', path: location })).token);
    expect((await f.document()).layout.resources).toEqual({ memory: 'custom-memory.db' });
    await f.port.open('layout.resources', 'project'); await f.port.draft('0');
    await expect(f.port.preview('0', { resource: 'config', path: 'brain/memory.db' })).rejects.toThrow();
    await expect(f.port.preview('0', { resource: 'memory', path: '../outside' })).rejects.toThrow();
    await f.port.commit((await f.port.preview('0', null)).token); expect((await f.document()).layout.resources).toEqual({}); expect(f.audits).toHaveLength(3);
  });
  it('the real panel exposes all five record editor fields, including the work target leaf hidden by the old document container', async () => {
    const f = await fixture({ execution }); const view = await configPanelPort(f.root, f.context, f.options, 'en', f.sources).inspect();
    for (const key of ['provider_spending.budgets', 'inspection.workers.sources', 'execution.adoption.targets', 'execution.workTargets.targets', 'layout.resources']) {
      expect(view.fields.find(field => field.key === key)).toMatchObject({ records: true, free: false, readOnly: null });
    }
  });
  it('rejects missing values, unknown scopes/branches/paths, over-limit budgets, arbitrary JSON, duplicates and invalid members before write', async () => {
    const f = await fixture({ execution });
    for (const [key, bad] of [ ['provider_spending.budgets', { scopeId: 'foreign', usd: 5 }], ['provider_spending.budgets', { scopeId: 'test', usd: 1001 }],
      ['inspection.workers.sources', { path: '/typed', kind: 'next-project', scopeId: 'test' }], ['inspection.workers.sources', { path: f.root, kind: 'new', scopeId: 'test' }],
      ['execution.adoption.targets', { branch: 'refs/heads/typed' }] ] as const) {
      await f.port.open(key, 'project'); await f.port.draft(null); await expect(f.port.preview(null, bad)).rejects.toThrow();
      await expect(f.port.preview(null, {})).rejects.toThrow(); await expect(f.port.preview('absent', null)).rejects.toThrow();
    }
    const panel = configPanelPort(f.root, f.context, f.options, 'en', f.sources); await panel.inspect();
    for (const key of ['provider_spending.budgets', 'inspection.workers.sources', 'execution.adoption.targets', 'provider_catalog.providers']) expect(panel.parse(key, '[]').ok).toBe(false);
    expect(f.writes).toEqual([]); expect(f.audits).toEqual([]);
  });
  it('denied preview, a denial after preview, approval pending, and stale preview never publish changes', async () => {
    const f = await fixture({}, 'deny'); await f.port.open('inspection.workers.sources', 'project'); await f.port.draft(null);
    const values = { path: f.root, scopeId: 'test', kind: 'next-project' };
    await expect(f.port.preview(null, values)).rejects.toMatchObject({ code: 'POLICY_DENIED' }); expect(f.writes).toEqual([]);
    f.policy('allow'); const preview = await f.port.preview(null, values); f.policy('deny'); await expect(f.port.commit(preview.token)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    f.policy('approval'); const held = await f.port.preview(null, values); expect(await f.port.commit(held.token)).toMatchObject({ status: 'approval-pending', approvalId: 'approval' }); expect(f.writes).toEqual([]);
    f.policy('allow'); const stale = await f.port.preview(null, values); await writeFile(f.path, JSON.stringify({ terminal: { scopeId: 'test' }, projectName: 'changed' }));
    await expect(f.port.commit(stale.token)).rejects.toMatchObject({ code: 'CONFIG_CONCURRENT_REVISION_HOLD' }); expect(f.audits).toEqual([]);
  });
  it('large catalog imports validate before preview and preserve the original on malformed files or invalid members', async () => {
    const f = await fixture(); const path = join(f.root, 'catalog.json'); await f.port.open('operations.targets', 'project');
    await writeFile(path, '{'); await expect(f.port.importFile(path)).rejects.toThrow();
    await writeFile(path, JSON.stringify([{ unknown: true }])); await expect(f.port.importFile(path)).rejects.toThrow();
    await writeFile(path, '[]'); const preview = await f.port.importFile(path); expect(f.writes).toEqual([]); await f.port.commit(preview.token);
    expect((await f.document()).operations.targets).toEqual([]);
    await expect(f.port.draft(null)).rejects.toThrow();
  });
  it('all large catalogs accept only validated selected-file declarations; their prepared bytes remain pinned', async () => {
    const f = await fixture(); const file = join(f.root, 'import.json');
    for (const [key, document] of [
      ['provider_catalog.providers', { schemaVersion: 1, revision: 'selected-file', providers: [] }],
      ['provider_invocation_profiles.profiles', { schemaVersion: 1, profiles: [] }],
      ['operations.catalog', []], ['operations.targets', []],
    ] as const) {
      await f.port.open(key, 'project'); await writeFile(file, JSON.stringify(document)); const preview = await f.port.importFile(file);
      await writeFile(file, '{"changed":true}'); await f.port.commit(preview.token);
      await expect(f.port.draft(null)).rejects.toThrow();
    }
    expect((await f.document()).provider_catalog.revision).toBe('selected-file'); expect(f.audits).toHaveLength(4);
  });
  it('keeps one discovered file selection source through import and refreshes it on the next open', async () => {
    const f = await fixture(); let factories = 0;
    f.context.configChoiceSources = () => {
      factories++; const selected = new Set<string>();
      return { list: async () => [], browse: async () => { selected.add('selected.json'); return [{ path: 'selected.json', label: 'Selected', kind: 'file' }]; },
        readDocument: async path => { if (!selected.has(path)) throw Error('unselected file'); return []; } };
    };
    const port = configRecordPort(f.root, f.context, f.options, 'en'); await port.open('operations.targets', 'project'); await port.browse();
    await expect(port.importFile('selected.json')).resolves.toHaveProperty('token'); expect(factories).toBe(1);
    await port.open('operations.targets', 'project'); expect(factories).toBe(2); await expect(port.importFile('selected.json')).rejects.toThrow('unselected file');
  });
  it('invalidated previews and reused confirmation tokens cannot reach a second write', async () => {
    const f = await fixture(); await f.port.open('provider_spending.budgets', 'project'); await f.port.draft(null);
    const first = await f.port.preview(null, { scopeId: 'test', usd: 5 });
    await expect(f.port.preview(null, { scopeId: 'foreign', usd: 5 })).rejects.toThrow(); await expect(f.port.commit(first.token)).rejects.toThrow();
    const valid = await f.port.preview(null, { scopeId: 'test', usd: 5 }); await f.port.commit(valid.token); await expect(f.port.commit(valid.token)).rejects.toThrow(); expect(f.audits).toHaveLength(1);
  });
  it('engine raw record inspection refuses secret and redacted paths', async () => {
    const f = await fixture(); await expect(f.app.inspectValue({ keyPath: 'secrets', layer: 'project' })).rejects.toThrow();
  });
});
describe('regular-file import adapter', () => {
  it('bounds bytes, refuses symlinks, never discovers links, and lists folders for navigation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'config-record-import-')); roots.push(root);
    const file = join(root, 'data.json'), link = join(root, 'link.json'); await writeFile(file, '[]'); await symlink(file, link); await mkdir(join(root, 'sub'));
    const entries = await discoverConfigRecordFiles(root, { maxEntries: 64, timeoutMs: 1000, outputBytes: 1024 });
    expect(entries.some(entry => entry.path === link)).toBe(false); expect(entries.some(entry => entry.kind === 'directory' && entry.label === 'sub')).toBe(true);
    await expect(readConfigRecordFile(link, 1024)).rejects.toThrow(); await expect(readConfigRecordFile(file, 1)).rejects.toThrow(); expect(await readConfigRecordFile(file, 2)).toEqual([]);
  });
});
