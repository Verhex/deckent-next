import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createUninstallPlan } from '#engine/core/installation/index.js';
import { uninstallCommand, uninstallPlanLines } from '#surfaces/core/cli-installation/index.js';
import { CLI_COMMANDS, main } from '#surfaces/core/cli/index.js';
import { CLI_CATALOG, cliInstallationContract } from '#surfaces/core/cli-kit/index.js';
const card = vi.hoisted(() => ({ requests: [] as { body?: readonly string[]; initial?: string }[], interactive: true }));
vi.mock('#surfaces/core/cli-human/index.js', async original => ({ ...await original<object>(),
  cliMode: () => ({ mode: card.interactive ? 'interactive' : 'plain' }),
  askCliCard: async (request: { body?: readonly string[]; initial?: string }) => { card.requests.push(request); return 'cancel'; },
}));

it('renders one plan in the card and both preview modes, never applies JSON and refuses script or consent-bypass flags', async () => {
  const plan = createUninstallPlan({ schemaVersion: 1, purge: false }, { installation: { id: 'temp', root: '/fixture' },
    scopeSummary: ['company-a'], layoutRevision: 'l1', policyRevision: 'p1', inventoryRevision: 'i1',
    resources: [{ resourceId: 'ledger', contribution: 'durable', locator: '/fixture/data/ledger', version: 'v1', owner: 'temp', ownership: 'exclusive',
      ownershipEvidence: 'a'.repeat(64), present: true, protected: false, capability: true, backup: 'missing' }],
    blockers: [], protectedPaths: [], deletionRoots: ['/fixture'], backupDestination: null, packageRemoval: { command: null, shared: true } });
  let applies = 0, output = '';
  const context = { root: '/fixture', env: {}, stdout: { write: (text: string) => { output += text; } }, locale: 'en' as const,
    previewUninstall: async () => plan,
    applyUninstall: async (_root: string, _input: unknown, interaction: import('#engine/index.js').UninstallInteraction) => {
      applies++; expect(await interaction.confirm(plan)).toBe(false);
      return { schemaVersion: 1 as const, planDigest: plan.planDigest, status: 'cancelled' as const, items: [], recoveryLocation: null,
        backup: plan.backup, packageRemoval: plan.packageRemoval };
    } };
  for (const flags of [['--json'], ['--dry-run', '--json'], ['--purge', '--json']]) {
    output = ''; expect(await uninstallCommand(['uninstall', ...flags], context)).toBe(0);
    expect(JSON.parse(output)).toEqual(plan); expect(output.trim().split('\n')).toHaveLength(1); expect(applies).toBe(0);
  }
  output = ''; expect(await uninstallCommand(['uninstall', '--dry-run'], context)).toBe(0);
  expect(output).toContain(uninstallPlanLines(plan, 'en').join('\n')); expect(applies).toBe(0);
  expect(await uninstallCommand(['uninstall'], context)).toBe(1);
  expect(card.requests).toHaveLength(1); expect(card.requests[0]!.body).toEqual(uninstallPlanLines(plan, 'en')); expect(card.requests[0]!.initial).toBe('cancel');
  card.interactive = false;
  await expect(uninstallCommand(['uninstall'], context)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  for (const flag of ['--yes', '--actor=human', '--name=Temporary', '--purge=Temporary']) await expect(uninstallCommand(['uninstall', flag], context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  expect(applies).toBe(1);
  expect(CLI_CATALOG.find(command => command.name === 'uninstall')).toMatchObject({ installation: 'owned' });
  expect(cliInstallationContract(['uninstall', '--json'], CLI_COMMANDS)).toBe('owned');
  expect(uninstallPlanLines(plan, 'tr').join('\n')).toContain('Korunacak');
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

it('prints a kept image\'s exact manual step and an unsafe authority file\'s path and fix on the card in both locales', () => {
  const command = `docker --host unix:///run/user/1/docker.sock image rm --no-prune -- sha256:${'1'.repeat(64)}`;
  const plan = createUninstallPlan({ schemaVersion: 1, purge: true }, { installation: { id: 'temp', root: '/fixture' },
    scopeSummary: ['s'], layoutRevision: 'l1', policyRevision: 'p1', inventoryRevision: 'i1',
    resources: [{ resourceId: 'image.1', contribution: 'worker-image', locator: `sha256:${'1'.repeat(64)}`, version: null, owner: null, ownership: 'unknown',
      ownershipEvidence: null, present: null, protected: true, capability: false, backup: 'missing', manualCommand: command }],
    blockers: ['authority-unsafe:/fixture/bindings.json'], protectedPaths: [], deletionRoots: ['/fixture'], backupDestination: '/backup', packageRemoval: { command: null, shared: true } });
  const en = uninstallPlanLines(plan, 'en').join('\n'), tr = uninstallPlanLines(plan, 'tr').join('\n');
  for (const text of [en, tr]) { expect(text).toContain(command); expect(text).toContain('/fixture/bindings.json'); expect(text).toContain('deckent uninstall'); }
  expect(tr).toContain('kendiniz kaldırabilirsiniz');
});
