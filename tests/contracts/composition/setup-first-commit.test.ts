import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { configuredSetup } from '#composition/core/setup/index.js';
import { withLocalPrincipalChannel } from '#adapters/index.js';

const witness = vi.hoisted(() => ({ person: true }));
// Inject the host attestation in this author fixture; actual PTY custody remains a separate lead acceptance step.
vi.mock('#adapters/core/local-principal/internal/interactive.js', async original => ({ ...await original<object>(),
  attestLocalInteractiveTerminal: async () => witness.person }));
const roots: string[] = [], execute = promisify(execFile);
afterEach(async () => { witness.person = true; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it.skipIf(process.platform !== 'linux')('U4E G1: actual installed grant → approved card → one durable first commit; replay, MCP and false witness cannot commit again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-first-commit-policy-')); roots.push(root);
  const env = { ...process.env, HOME: root, DECKENT_GLOBAL_HOME: join(root, 'global'), GIT_CONFIG_NOSYSTEM: '1' }, options = { env };
  const git = async (...args: string[]) => (await execute('git', args, { cwd: root, env })).stdout.trim();
  await git('init', '-q'); await git('config', 'user.name', 'Person'); await git('config', 'user.email', 'person@example.test'); await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'README.md'), 'Public project\n');
  await writeFile(join(root, 'notes.txt'), `${'x'.repeat(70_000)}\n-----BEGIN PRIVATE KEY-----\nfixture\n`);
  await applyPolicyTemplateInstallation(root, 's', options);
  const onboarding = await configuredSetup({}).openOnboarding(root, 's', '.', options);
  const preview = await onboarding.previewFirstCommit('Initial commit');
  if (preview.state !== 'offered') throw new Error('missing first-commit offer');
  expect(preview.rows.find(row => row.path === 'notes.txt')?.flag).toBe('secret-content');
  const input = { message: 'Initial commit', digest: preview.digest };
  const result = await onboarding.firstCommit(input);
  expect(result.status).toBe('settled');
  const head = await git('rev-parse', 'HEAD'), index = await readFile(join(root, '.git/index'));
  expect(await git('ls-tree', '--name-only', 'HEAD')).toBe('README.md');
  const db = new DatabaseSync(join(root, '.deckent/state/ledger.db'), { readOnly: true });
  try {
    // The effect cannot run until its real required-approval card is durably allowed and sealed.
    const approvals = db.prepare('SELECT snapshot FROM approvals WHERE current=1').all();
    expect(approvals).toHaveLength(1);
    const approval = JSON.parse(String(approvals[0]!['snapshot']));
    expect(await configuredApproval(root, 'inspect', { schemaVersion: 1, scopeId: 's', approvalId: approval.request.approvalId }, options))
      .toMatchObject({ status: 'decided', decision: { decision: 'allow', deciderClass: 'human-tty' } });
    const effects = db.prepare('SELECT count(*) AS n FROM effect_intents').get()!['n'];
    expect(effects).toBe(1);
    expect(await onboarding.firstCommit(input)).toEqual(result);
    const policyPath = join(root, '.deckent/policy.json'), policyBytes = await readFile(policyPath, 'utf8'), policy = JSON.parse(policyBytes);
    await writeFile(policyPath, JSON.stringify({ ...policy, grants: policy.grants.map((row: { id: string }) => row.id === 'first-run-first-commit' ? { ...row, effect: 'deny' } : row) }));
    await expect(onboarding.firstCommit(input)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await writeFile(policyPath, policyBytes);
    await expect(withLocalPrincipalChannel('mcp', () => onboarding.firstCommit(input))).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    witness.person = false;
    await expect(onboarding.firstCommit(input)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(await git('rev-parse', 'HEAD')).toBe(head); expect(await git('rev-list', '--count', 'HEAD')).toBe('1');
    expect(await readFile(join(root, '.git/index'))).toEqual(index);
    expect(db.prepare('SELECT count(*) AS n FROM effect_intents').get()!['n']).toBe(effects);
  } finally { db.close(); }
});
