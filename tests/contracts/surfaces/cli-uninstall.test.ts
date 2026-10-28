import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createUninstallPlan, type UninstallInventory } from '#engine/core/installation/index.js';
import { uninstallCommand, uninstallPlanLines, uninstallDetailLines, uninstallSummaryLines } from '#surfaces/core/cli-installation/index.js';
import { CLI_COMMANDS, main } from '#surfaces/core/cli/index.js';
import { CLI_CATALOG, cliInstallationContract } from '#surfaces/core/cli-kit/index.js';
const card = vi.hoisted(() => ({ requests: [] as { title: string; body?: readonly string[]; initial?: string; options: readonly { id: string }[] }[], interactive: true, answers: [] as string[] }));
vi.mock('#surfaces/core/cli-human/index.js', async original => ({ ...await original<object>(),
  cliMode: () => ({ mode: card.interactive ? 'interactive' : 'plain' }),
  askCliCard: async (request: typeof card.requests[number]) => { card.requests.push(request); return card.answers.shift() ?? 'cancel'; },
}));
const query = (tier: 'keep-data' | 'all' = 'keep-data') => ({ schemaVersion: 2, tier, force: false, disableUnit: false });
const inventory = (extra: Partial<UninstallInventory> = {}): UninstallInventory => ({ installation: { id: 'temp', root: '/fixture/.deckent' },
  scopeSummary: ['company-a'], layoutRevision: 'l1', policyRevision: 'p1', inventoryRevision: 'i1',
  resources: [{ resourceId: 'scratch', contribution: 'scratch', locator: '/fixture/.deckent/state/scratch', version: 'v1', owner: 'temp', ownership: 'exclusive',
    ownershipEvidence: 'a'.repeat(64), present: true, protected: false, capability: true, backup: 'missing' },
  { resourceId: 'ledger', contribution: 'durable', locator: '/fixture/.deckent/state/ledger.db', version: 'v1', owner: null, ownership: 'unknown',
    ownershipEvidence: null, present: true, protected: true, capability: false, backup: 'missing' },
  { resourceId: 'terminalSessions', contribution: 'durable', locator: '/fixture/.deckent/state/terminal-sessions', version: null, owner: null, ownership: 'unknown',
    ownershipEvidence: null, present: false, protected: true, capability: false, backup: 'missing' }],
  blockers: [], dataBlockers: [], protectedPaths: [], deletionRoots: ['/fixture/.deckent'], backupDestination: '/home/person/.local/state/deckent/uninstall/x/backup',
  packageRemoval: { command: 'npm uninstall -g deckent', shared: true }, managedScopes: [],
  work: { running: [], parked: [], approvals: [], deliveries: [], uncertain: [], complete: true }, service: { running: true, unit: null, unitDisable: 'none', command: null }, ...extra });

it('offers the tiers in one card, checks before the single confirmation, previews only with --json/--dry-run and refuses scripts', async () => {
  const plan = createUninstallPlan(query(), inventory());
  let applies = 0, output = '', shown = plan;
  const context = { root: '/fixture', env: {}, stdout: { write: (text: string) => { output += text; } }, locale: 'en' as const,
    previewUninstall: async (_root: string, value: { tier: string }) => (shown = createUninstallPlan({ ...query(), ...value }, inventory())),
    applyUninstall: async (_root: string, input: unknown, interaction: import('#engine/index.js').UninstallInteraction) => {
      applies++; expect(input).toMatchObject({ schemaVersion: 2, planDigest: shown.planDigest });
      const yes = await interaction.confirm(shown);
      return { schemaVersion: 2 as const, planDigest: shown.planDigest, status: yes ? 'completed' as const : 'cancelled' as const, items: [], recoveryLocation: null,
        backup: shown.backup, packageRemoval: shown.packageRemoval, uncertain: [] };
    } };
  for (const flags of [['--json'], ['--dry-run', '--json'], ['--all', '--json']]) {
    output = ''; expect(await uninstallCommand(['uninstall', ...flags], context)).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ schemaVersion: 2, tier: flags.includes('--all') ? 'all' : 'keep-data' }); expect(output.trim().split('\n')).toHaveLength(1); expect(applies).toBe(0);
  }
  output = ''; expect(await uninstallCommand(['uninstall', '--dry-run'], context)).toBe(0);
  expect(output).toContain(uninstallDetailLines(plan, 'en').join('\n')); expect(output.match(/Remove Deckent/gu)).toHaveLength(1); expect(applies).toBe(0);
  // The menu: one summary card (the title once, a running service is "will be stopped", never "work active"), Cancel changes nothing.
  expect(await uninstallCommand(['uninstall'], context)).toBe(1);
  expect(card.requests).toHaveLength(1); expect(card.requests[0]!.body).toEqual(uninstallSummaryLines(plan, 'en')); expect(card.requests[0]!.initial).toBe('keep-data');
  expect(card.requests[0]!.body!.join('\n')).toContain('will be stopped'); expect(card.requests[0]!.options.map(option => option.id)).toEqual(['keep-data', 'all', 'details', 'cancel']);
  expect(applies).toBe(0);
  // Menu choice → the plan card: what is removed comes first, the absent entry is collapsed, the action names the stop.
  card.requests.length = 0; card.answers.push('keep-data', 'apply');
  expect(await uninstallCommand(['uninstall'], context)).toBe(0);
  expect(card.requests[1]!.body).toEqual(uninstallPlanLines(plan, 'en')); expect(card.requests[1]!.body![0]).toMatch(/^Will be removed: cache/u);
  expect(card.requests[1]!.body!.join('\n')).toContain('Not present: 1 items');
  // --yes skips only the final card; the plan body is still printed.
  card.requests.length = 0; output = '';
  expect(await uninstallCommand(['uninstall', '--keep-data', '--yes'], context)).toBe(0);
  expect(card.requests).toHaveLength(0); expect(output).toContain(uninstallPlanLines(plan, 'en').join('\n'));
  // Nothing to remove: no card and no apply.
  const nothing = { ...context, previewUninstall: async () => createUninstallPlan(query(), inventory({ resources: [], service: { running: false, unit: null, unitDisable: 'none', command: null } })) };
  const before = applies; output = '';
  expect(await uninstallCommand(['uninstall', '--keep-data'], nothing)).toBe(0); expect(applies).toBe(before); expect(card.requests).toHaveLength(0);
  expect(output).toContain('Nothing to remove'); expect(output).toContain('npm uninstall -g deckent');
  await expect(uninstallCommand(['uninstall', '--purge'], context)).rejects.toMatchObject({ code: 'UNINSTALL_FLAG_MOVED', params: { to: '--all' } });
  card.interactive = false;
  await expect(uninstallCommand(['uninstall', '--all', '--force', '--yes'], context)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  for (const flag of ['--actor=human', '--name=Temporary', '--all=Temporary']) await expect(uninstallCommand(['uninstall', flag], context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  await expect(uninstallCommand(['uninstall', '--all', '--keep-data', '--json'], context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  card.interactive = true;
  expect(CLI_CATALOG.find(command => command.name === 'uninstall')).toMatchObject({ installation: 'owned' });
  expect(cliInstallationContract(['uninstall', '--json'], CLI_COMMANDS)).toBe('owned');
  expect(uninstallPlanLines(plan, 'tr').join('\n')).toContain('Silinecek');
  // Own only this command's entry in the shared help goldens; retain other lanes' entries byte-for-byte.
  for (const locale of ['en', 'tr'] as const) {
    let help = '';
    expect(await main(['uninstall', '--help', '--lang', locale], {
      env: { NO_COLOR: '1' }, initialize: () => { throw new Error('help initialized execution'); },
      stdout: { write: text => { help += text; } }, stderr: { write: () => { throw new Error('help wrote an error'); } },
    })).toBe(0);
    const path = `../../fixtures/cli-help/commands-${locale}.json`;
    const golden = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as Record<string, string>;
    delete golden['uninstall'];
    const otherCommands = golden;
    await expect(JSON.stringify({ uninstall: help, ...otherCommands }, null, 2) + '\n').toMatchFileSnapshot(path);
  }
});

it('offers force for running work before any card and prints a kept image\'s step and an unsafe authority path in both locales', async () => {
  const busy = inventory({ service: { running: false, unit: null, unitDisable: 'none', command: null }, work: { running: [{ scopeId: 'company-a', id: 'run-1', revision: 1 }], parked: [], approvals: [], deliveries: [], uncertain: [], complete: true } });
  const asked: unknown[] = [];
  const context = { root: '/fixture', env: {}, stdout: { write: () => {} }, locale: 'en' as const,
    previewUninstall: async (_root: string, value: object) => { asked.push(value); return createUninstallPlan({ ...query(), ...value }, busy); },
    applyUninstall: async () => { throw new Error('not reached'); } };
  card.requests.length = 0; card.answers.push('cancel');
  await expect(uninstallCommand(['uninstall', '--keep-data'], context)).rejects.toMatchObject({ code: 'UNINSTALL_WORK_ACTIVE', params: { runs: '1' } });
  expect(card.requests[0]!.options.map(option => option.id)).toEqual(['force', 'cancel']); expect(asked).toHaveLength(1);
  // The menu keeps a tier whose refusal the person can resolve: running work blocks every tier, yet the choice leads to the force offer.
  card.requests.length = 0; card.answers.push('all', 'cancel');
  await expect(uninstallCommand(['uninstall'], context)).rejects.toMatchObject({ code: 'UNINSTALL_WORK_ACTIVE' });
  expect(card.requests[0]!.options.map(option => option.id)).toEqual(['keep-data', 'all', 'details', 'cancel']); expect(card.requests[1]!.options[0]).toMatchObject({ id: 'force' });
  // m2: running work alone is waiting work too: when keep-work deletes something keep-data keeps (conversation), the menu offers it as the CLI does.
  const talk = { ...context, previewUninstall: async (_root: string, value: object) => createUninstallPlan({ ...query(), ...value }, { ...busy, resources: [...busy.resources,
    { resourceId: 'conversation-data', contribution: 'conversation', locator: '/fixture/.deckent', members: ['/fixture/.deckent/state/terminal-history.jsonl'], version: 'v1', owner: 'temp',
      ownership: 'exclusive', ownershipEvidence: 'b'.repeat(64), present: true, protected: false, capability: true, backup: 'covered', tiers: ['keep-work'] }] }) };
  card.requests.length = 0; card.answers.push('cancel');
  expect((await uninstallCommand(['uninstall'], talk).catch(() => null), card.requests[0]!.options.map(option => option.id))).toEqual(['keep-data', 'keep-work', 'all', 'details', 'cancel']);
  // A policy refusal (legal hold) is the engine's typed decision with its owner, never a generic ownership error from the surface.
  const held = { ...context, previewUninstall: async (_root: string, value: object) => createUninstallPlan({ ...query(), ...value }, { ...inventory(), policyBlocker: 'UNINSTALL_PURGE_DENIED' }),
    applyUninstall: async () => { throw Object.assign(new Error('denied'), { code: 'UNINSTALL_PURGE_DENIED', params: { owner: 'legal-hold' } }); } };
  card.requests.length = 0;
  await expect(uninstallCommand(['uninstall', '--all', '--force', '--yes'], held)).rejects.toMatchObject({ code: 'UNINSTALL_PURGE_DENIED', params: { owner: 'legal-hold' } });
  const command = `docker --host unix:///run/user/1/docker.sock image rm --no-prune -- sha256:${'1'.repeat(64)}`;
  const plan = createUninstallPlan(query('all'), inventory({ resources: [{ resourceId: 'image.1', contribution: 'worker-image', locator: `sha256:${'1'.repeat(64)}`, version: null, owner: null, ownership: 'unknown',
    ownershipEvidence: null, present: null, protected: true, capability: false, backup: 'missing', manualCommand: command }], dataBlockers: ['authority-unsafe:/fixture/bindings.json'] }));
  const en = uninstallPlanLines(plan, 'en').join('\n'), tr = uninstallPlanLines(plan, 'tr').join('\n');
  for (const text of [en, tr]) { expect(text).toContain(command); expect(text).toContain('/fixture/bindings.json'); }
  expect(tr).toContain('Sizin yapmanız gereken');
});

it('asks nothing when no tier would remove or stop anything: no menu, only the nothing-to-remove line', async () => {
  const quiet = inventory({ service: { running: false, unit: null, unitDisable: 'none', command: null }, resources: inventory().resources.filter(item => item.resourceId !== 'scratch') });
  const lines: string[] = [], context = { root: '/fixture', env: {}, stdout: { write: (text: string) => { lines.push(text); return true; } }, locale: 'en' as const,
    previewUninstall: async (_root: string, value: object) => createUninstallPlan({ ...query(), ...value }, quiet), applyUninstall: async () => { throw new Error('not reached'); } };
  card.requests.length = 0;
  expect(await uninstallCommand(['uninstall'], context)).toBe(0);
  expect(card.requests).toEqual([]); expect(lines.join('')).toContain('npm uninstall -g deckent');
});

it('the reopen card counts unknown results from a fresh preview, says when it could not check, and "Not now" keeps the folder retired', async () => {
  const { mkdir, mkdtemp, rm, lstat } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { retireInstallation } = await import('#platform/index.js'), card = await import('#surfaces/core/cli-human/internal/card.js');
  const asked: { body?: readonly string[] }[] = [], ask = vi.spyOn(card, 'askCliCard').mockImplementation(async request => { asked.push(request); return 'cancel'; });
  const { reopenRetiredFolder } = await import('#surfaces/core/cli-human/internal/reopen.js'), project = await mkdtemp(join(tmpdir(), 'deckent-reopen-'));
  try {
    const data = join(project, '.deckent'), config = { productLayout: { root: data }, projectRoot: project };
    await mkdir(data, { mode: 0o700 }); await retireInstallation(data, { installationId: 'i', planDigest: 'd', tier: 'keep-data' });
    const uncertain = { kind: 'effect', scopeId: 's', id: 'erp-1', target: null };
    expect(await reopenRetiredFolder(config, 'en', {}, { previewUninstall: async () => ({ work: { complete: true, uncertain: [uncertain, { ...uncertain, id: 'erp-2' }] } }) })).toBe(false);
    expect(asked[0]!.body!.join('\n')).toContain('2 results of earlier work are still unknown');
    expect(await reopenRetiredFolder(config, 'tr', {}, { previewUninstall: async () => { throw new Error('unreadable'); } })).toBe(false);
    expect(asked[1]!.body!.join('\n')).toContain('denetlenemedi');
    // R12: an incomplete observation is "could not check", never zero unknown results.
    expect(await reopenRetiredFolder(config, 'en', {}, { previewUninstall: async () => ({ work: { complete: false, uncertain: [] } }) })).toBe(false);
    expect(asked[2]!.body!.join('\n')).toContain('could not be checked'); expect(asked[2]!.body!.join('\n')).not.toContain('still unknown');
    expect(await lstat(join(data, 'installation/retired.json'))).toBeTruthy();
  } finally { ask.mockRestore(); await rm(project, { recursive: true, force: true }); }
});
