import { FIRST_RUN_V16_RULE_IDS } from '../support/first-run-v16.js';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, afterEach, expect, it } from 'vitest';
import { applyPolicyTemplateInstallation, inspectPolicyTemplate, previewPolicyTemplateInstallation, upgradePolicyTemplateInstallation as upgradeInstallation } from '#composition/core/installation/index.js';
import { main } from '#surfaces/index.js';
import { FileInstallationIdentityStore, readLocalOsIdentity } from '#adapters/index.js';

import { clearConfigCache, resolveProductLayout } from '#platform/index.js';
import { installationBindingNotRunReason } from '../support/binding-capability.js';
import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS as FIRST_RUN_V18_RULE_IDS, POLICY_CHANGE_MAX } from '#domain/index.js';
import { FIRST_RUN_V15_RULE_IDS } from '../support/first-run-v15.js';

// Historical fixtures before v16 exclude both later additive deltas.
const POST_V15_RULE_IDS: readonly string[] = [...FIRST_RUN_V16_RULE_IDS, 'first-run-first-commit', ...FIRST_RUN_V18_RULE_IDS];
/** I-POL (alpha.48): the v13 delta; an older template reconstructed from the current one leaves it out, and the upgrade adds it last. */
/** The v13 delta (I-POL) and the current v14 delta (S4): the rules added after v12, in plan order. */
const V13: readonly string[] = ['first-run-execution-environment-install', 'first-run-installation-repair', 'first-run-model-deactivation', 'first-run-decision-inspect', 'first-run-monitor-scope-diagnostics', 'first-run-standing-grants-all', 'first-run-mcp-observe-pool', 'first-run-memory-inspect', 'first-run-mcp-observe-memory', ...FIRST_RUN_V15_RULE_IDS, ...POST_V15_RULE_IDS];

/** SEC-1 (I-POL): `init policy --upgrade --apply` is an authority write and vitest has no terminal, so this file attests the witness; the refusal
 * without one is tests/contracts/composition/policy-upgrade-witness.test.ts. */
const upgradePolicyTemplateInstallation = (...args: Parameters<typeof upgradeInstallation>) =>
  upgradeInstallation(args[0], args[1], args[2], args[3], args[4], args[5], args[6], { attest: async () => true });
const bindingNotRun = await installationBindingNotRunReason();

// SCR-B (owner 2026-09-28, checkpoint option B, proof/SCR-B-2026-09-28/review.md): a real journal + real adapters
// end to end. W5: no Docker or pool; absent config and ledger are initialized for the first session.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() { const root = await mkdtemp(join(tmpdir(), 'deckent-policy-template-')); roots.push(root); return root; }

describe.skipIf(process.platform === 'win32')('requires POSIX local principal and private installation journal', () => {
it('previews without touching disk, then a real apply journals and writes policy.json + bindings.json privately; a repeated apply is a byte-identical replay', async () => {
  const root = await project();
  const preview = await previewPolicyTemplateInstallation(root, 'installation');
  expect(preview).toMatchObject({ status: 'preview', scopeId: 'installation', template: { id: 'first-run-template', version: 18 } });
  await expect(stat(join(root, '.deckent'))).rejects.toMatchObject({ code: 'ENOENT' });
  const identity = readLocalOsIdentity();
  expect(preview.principal).toEqual({ issuer: identity.issuer, subject: identity.subject });
  expect(await inspectPolicyTemplate(root)).toBeNull(); // no policy file yet

  const result = await applyPolicyTemplateInstallation(root, 'installation');
  expect(result).toMatchObject({ status: 'installed', template: { id: 'first-run-template', version: 18 }, scopeId: 'installation' });
  const policyPath = join(root, '.deckent/policy.json'), bindingsPath = join(root, '.deckent/bindings.json');
  const policyBytes = await readFile(policyPath, 'utf8'), bindingsBytes = await readFile(bindingsPath, 'utf8');
  const identityPaths = ['installation-identity', 'project-identity'].map(name => join(root, '.deckent', name, 'identity.json'));
  const identities = await Promise.all(identityPaths.map(path => readFile(path, 'utf8')));
  expect(JSON.parse(identities[0]!)).toHaveProperty('installationId'); expect(JSON.parse(identities[1]!)).toHaveProperty('projectId');
  expect(JSON.parse(policyBytes)).toMatchObject({ schemaVersion: 2, revision: 'first-run-template-v18' });
  expect(JSON.parse(bindingsBytes)).toEqual({ schemaVersion: 1, revision: 'first-run-template-v18-bindings', bindings: [] });
  expect((await stat(policyPath)).mode & 0o777).toBe(0o600); expect((await stat(bindingsPath)).mode & 0o777).toBe(0o600);

  expect(await inspectPolicyTemplate(root)).toEqual({ id: 'first-run-template', version: 18 });

  const replay = await applyPolicyTemplateInstallation(root, 'installation');
  expect(replay).toMatchObject({ status: 'replayed' });
  expect(await readFile(policyPath, 'utf8')).toBe(policyBytes);
  expect(await readFile(bindingsPath, 'utf8')).toBe(bindingsBytes);
  expect(await Promise.all(identityPaths.map(path => readFile(path, 'utf8')))).toEqual(identities);
});

// G2-1 (analysis 2026-10-18, owner-approved): init gives a new data root its own .gitignore, so `git add -A` in the project never commits the
// approval integrity key, the ledger, the policy or the sessions; `.deckent/docs` (the project's own tracked documents) stays addable.
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.excludesFile=/dev/null', ...args], { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
it('writes .deckent/.gitignore on a new data root: git add -A takes the project and .deckent/docs, never the product state; replay keeps it', async () => {
  const root = await project();
  git(root, 'init', '-q');
  await writeFile(join(root, 'README.md'), 'project\n');
  await applyPolicyTemplateInstallation(root, 'installation');
  const ignore = join(root, '.deckent/.gitignore'), bytes = await readFile(ignore, 'utf8');
  expect(bytes).toBe('/*\n!/docs/\n'); expect((await stat(ignore)).mode & 0o777).toBe(0o600);
  // Product state as a running installation holds it, beside a tracked document.
  for (const [file, content] of [['approvals/authority.key', 'k'], ['state/terminal-history.jsonl', '{}'], ['live-data/state/ledger.db', 'x'], ['docs/core-memory/MEMORY.md', '# m']]) {
    await mkdir(join(root, '.deckent', file, '..'), { recursive: true }); await writeFile(join(root, '.deckent', file), `${content}\n`);
  }
  git(root, 'add', '-A');
  expect(git(root, 'ls-files').trim().split('\n').sort()).toEqual(['.deckent/docs/core-memory/MEMORY.md', 'README.md']);
  expect(await applyPolicyTemplateInstallation(root, 'installation')).toMatchObject({ status: 'replayed' });
  expect(await readFile(ignore, 'utf8')).toBe(bytes);
});

it('keeps the dogfood repository\'s own .deckent/docs allowlist: the data-root rule leaves what lies under docs to the root .gitignore', async () => {
  const root = await project();
  git(root, 'init', '-q');
  // The Deckent repository's root rules for its tracked core-memory (repository .gitignore, unchanged).
  await writeFile(join(root, '.gitignore'), ['.deckent/*', '!.deckent/docs/', '.deckent/docs/*', '!.deckent/docs/core-memory/', '!.deckent/docs/decisions/', ''].join('\n'));
  await applyPolicyTemplateInstallation(root, 'installation');
  for (const file of ['docs/core-memory/law.md', 'docs/decisions/d.md', 'docs/scratch/note.md', 'approvals/authority.key']) {
    await mkdir(join(root, '.deckent', file, '..'), { recursive: true }); await writeFile(join(root, '.deckent', file), 'x\n');
  }
  git(root, 'add', '-A');
  expect(git(root, 'ls-files').trim().split('\n').sort()).toEqual(['.deckent/docs/core-memory/law.md', '.deckent/docs/decisions/d.md', '.gitignore']);
});

it('never writes over a .gitignore already in the data root, whatever its mode or content; the install still completes', async () => {
  const root = await project();
  await mkdir(join(root, '.deckent'), { mode: 0o700 }); await writeFile(join(root, '.deckent/.gitignore'), 'mine\n', { mode: 0o644 });
  expect(await applyPolicyTemplateInstallation(root, 'installation')).toMatchObject({ status: 'installed' });
  expect(await readFile(join(root, '.deckent/.gitignore'), 'utf8')).toBe('mine\n'); expect((await stat(join(root, '.deckent/.gitignore'))).mode & 0o777).toBe(0o644);
  expect(await applyPolicyTemplateInstallation(root, 'installation')).toMatchObject({ status: 'replayed' });
});

it('migrates exactly an untouched first-run v4 policy to v7 (v5 owner 2026-10-07): preview reads only, apply writes once through the authority writer, bindings stay', async () => {
  const root = await project();
  await applyPolicyTemplateInstallation(root, 'installation');
  const policyPath = join(root, '.deckent/policy.json'), bindingsPath = join(root, '.deckent/bindings.json');
  const v5 = JSON.parse(await readFile(policyPath, 'utf8')) as { revision: string; grants: { id: string; resource: { ids: unknown } }[] };
  // The bytes alpha.10 `init policy` wrote: v5 without the MCP rules, read tools without the proposal tool, the v4 revision.
  const v4 = { ...v5, revision: 'first-run-template-v4', grants: v5.grants.filter(grant => !grant.id.startsWith('first-run-mcp-observe-') && !V13.includes(grant.id) && !['first-run-mcp-servers', 'first-run-mcp-call-operation', 'first-run-policy-administer', 'first-run-approvals', 'first-run-secret-switch', 'first-run-model-activation', 'first-run-model-invocation', 'first-run-provider-spending', 'first-run-backup', 'first-run-runs', 'first-run-pools', 'first-run-attempts', 'first-run-work-targets', 'first-run-quota-release', 'first-run-integration', 'first-run-work-target-adopt', 'first-run-scope-inspect', 'first-run-service-shutdown'].includes(grant.id))
    .map(grant => grant.id === 'first-run-read-tools' ? { ...grant, resource: { ...grant.resource, ids: (grant.resource.ids as string[]).filter(name => name !== 'propose_mcp_server') } } : grant) };
  await writeFile(policyPath, `${JSON.stringify(v4)}\n`, { mode: 0o600 });
  const bindingsBefore = await readFile(bindingsPath, 'utf8'), v4Bytes = await readFile(policyPath, 'utf8');
  expect(await inspectPolicyTemplate(root)).toEqual({ id: 'first-run-template', version: 4 });

  const preview = await upgradePolicyTemplateInstallation(root, 'installation', false);
  expect(preview).toMatchObject({ status: 'preview', template: { to: 18 } });
  expect(preview.rules.map(rule => (rule as { id: string }).id)).toEqual(['first-run-read-tools', 'first-run-mcp-servers', 'first-run-mcp-call-operation', 'first-run-policy-administer', 'first-run-approvals', 'first-run-secret-switch', 'first-run-model-activation', 'first-run-model-invocation', 'first-run-provider-spending', 'first-run-backup', 'first-run-mcp-observe-run', 'first-run-mcp-observe-scope', 'first-run-mcp-observe-approval', 'first-run-mcp-observe-model-activation', 'first-run-mcp-observe-model-invocation', 'first-run-mcp-observe-provider-spend-account', 'first-run-runs', 'first-run-pools', 'first-run-attempts', 'first-run-work-targets', 'first-run-quota-release', 'first-run-integration', 'first-run-work-target-adopt', 'first-run-scope-inspect', 'first-run-service-shutdown', ...V13]);
  expect(await readFile(policyPath, 'utf8')).toBe(v4Bytes);

  expect(await upgradePolicyTemplateInstallation(root, 'installation', true)).toMatchObject({ status: 'upgraded', template: { to: 18 } });
  expect(JSON.parse(await readFile(policyPath, 'utf8'))).toEqual(v5);
  expect(await readFile(bindingsPath, 'utf8')).toBe(bindingsBefore);
  expect((await stat(policyPath)).mode & 0o777).toBe(0o600);
  expect(await inspectPolicyTemplate(root)).toEqual({ id: 'first-run-template', version: 18 });
  expect(await upgradePolicyTemplateInstallation(root, 'installation', true)).toMatchObject({ status: 'current' });
});

it('upgrades a changed v4 policy additively (owner 2026-10-07): hand-added and edited rules stay, a same-id rule with other content is a named conflict, wire-name MCP rules are named; on the previewed revision only; a second run is current', async () => {
  const root = await project();
  await applyPolicyTemplateInstallation(root, 'installation');
  const policyPath = join(root, '.deckent/policy.json'), bindingsPath = join(root, '.deckent/bindings.json');
  const v5 = JSON.parse(await readFile(policyPath, 'utf8')) as { grants: { id: string; principals: unknown; resource: { ids: unknown } }[] };
  const person = v5.grants[0]!.principals;
  const wire = { id: 'hand-mcp-github', effect: 'allow', actions: ['invoke'], scopes: ['installation'], principals: person, resource: { kind: 'agent-tool', ids: ['mcp__github__search'] } };
  const odd = { id: 'first-run-approvals', effect: 'allow', actions: ['inspect'], scopes: ['installation'], principals: person, resource: { kind: 'approval', ids: 'all' } };
  const edited = { ...v5, revision: 'a-0000000000000000000000000000000000000000', grants: [...v5.grants.filter(grant => !grant.id.startsWith('first-run-mcp-observe-') && !V13.includes(grant.id) && !['first-run-mcp-servers', 'first-run-mcp-call-operation',
    'first-run-policy-administer', 'first-run-approvals', 'first-run-secret-switch', 'first-run-model-activation', 'first-run-model-invocation', 'first-run-provider-spending', 'first-run-backup', 'first-run-runs', 'first-run-pools', 'first-run-attempts', 'first-run-work-targets', 'first-run-quota-release', 'first-run-integration', 'first-run-work-target-adopt'].includes(grant.id)).map(grant => grant.id === 'first-run-read-tools' ? { ...grant, resource: { ...grant.resource,
    ids: (grant.resource.ids as string[]).filter(name => name !== 'propose_mcp_server') } } : grant), wire, odd] };
  await writeFile(policyPath, `${JSON.stringify(edited)}\n`, { mode: 0o600 });
  const bindingsBefore = await readFile(bindingsPath, 'utf8');
  const preview = await upgradePolicyTemplateInstallation(root, 'installation', false);
  expect(preview).toMatchObject({ status: 'preview', revision: edited.revision, conflicts: ['first-run-approvals'], wireRules: ['hand-mcp-github'] });
  expect(preview.rules.map(rule => (rule as { id: string }).id)).toEqual(['first-run-mcp-servers', 'first-run-mcp-call-operation', 'first-run-mcp-propose-tool', 'first-run-policy-administer', 'first-run-secret-switch', 'first-run-model-activation', 'first-run-model-invocation', 'first-run-provider-spending', 'first-run-backup', 'first-run-mcp-observe-run', 'first-run-mcp-observe-scope', 'first-run-mcp-observe-approval', 'first-run-mcp-observe-model-activation', 'first-run-mcp-observe-model-invocation', 'first-run-mcp-observe-provider-spend-account', 'first-run-runs', 'first-run-pools', 'first-run-attempts', 'first-run-work-targets', 'first-run-quota-release', 'first-run-integration', 'first-run-work-target-adopt', ...V13].slice(0, POLICY_CHANGE_MAX)); // one policy change holds POLICY_CHANGE_MAX rules; the rest is the next run's
  expect(await upgradePolicyTemplateInstallation(root, 'installation', true, 'stale')).toMatchObject({ status: 'conflict' });
  const applied = await upgradePolicyTemplateInstallation(root, 'installation', true, preview.expect!);
  expect(applied).toMatchObject({ status: 'upgraded' });
  const after = JSON.parse(await readFile(policyPath, 'utf8')) as { revision: string; grants: { id: string }[] };
  expect(after.revision).not.toBe(edited.revision);
  expect(after.grants.slice(0, edited.grants.length)).toEqual(edited.grants); // nothing removed or replaced
  expect(after.grants.map(grant => grant.id).slice(edited.grants.length)).toEqual(preview.rules.map(rule => (rule as { id: string }).id));
  expect(await readFile(bindingsPath, 'utf8')).toBe(bindingsBefore);
  // Since v15 the plan is longer than one policy change: the same run again adds the rest (add-only), a third is current.
  expect(await upgradePolicyTemplateInstallation(root, 'installation', true)).toMatchObject({ status: 'upgraded' });
  const rest = JSON.parse(await readFile(policyPath, 'utf8')) as { grants: { id: string }[] };
  expect(rest.grants.slice(0, after.grants.length)).toEqual(after.grants);
  const again = await upgradePolicyTemplateInstallation(root, 'installation', true);
  expect(again).toMatchObject({ status: 'current', conflicts: ['first-run-approvals'] });
  expect(JSON.parse(await readFile(policyPath, 'utf8'))).toEqual(rest);
});

it('security (lead 2026-10-07): only the installation owner may use the direct upgrade, and a read rule for `all` principals is nobody\'s; nothing is written either way', async () => {
  const root = await project();
  await applyPolicyTemplateInstallation(root, 'installation');
  const policyPath = join(root, '.deckent/policy.json');
  const v5 = JSON.parse(await readFile(policyPath, 'utf8')) as { grants: { id: string; principals: unknown; resource: { ids: unknown } }[] };
  const v4 = { ...v5, revision: 'first-run-template-v4', grants: v5.grants.filter(grant => !grant.id.startsWith('first-run-mcp-observe-') && !V13.includes(grant.id) && !['first-run-mcp-servers', 'first-run-mcp-call-operation', 'first-run-policy-administer',
    'first-run-approvals'].includes(grant.id)) };
  await writeFile(policyPath, `${JSON.stringify(v4)}\n`, { mode: 0o600 });
  const before = await readFile(policyPath, 'utf8');
  // Another local user (the files' owner uid is not theirs): refused before anything is read or written; the governed path is named.
  expect(await upgradePolicyTemplateInstallation(root, 'installation', true, undefined, {}, (process.getuid?.() ?? 0) + 1)).toMatchObject({ status: 'unavailable', reason: 'not-owner' });
  expect(await upgradePolicyTemplateInstallation(root, 'installation', false, undefined, {}, (process.getuid?.() ?? 0) + 1)).toMatchObject({ status: 'unavailable', reason: 'not-owner' });
  expect(await readFile(policyPath, 'utf8')).toBe(before);
  // A first-run read rule for every principal proves no owner: unavailable, bytes unchanged.
  const open = { ...v4, revision: 'a-open', grants: v4.grants.map(grant => grant.id === 'first-run-read-tools' ? { ...grant, principals: 'all' } : grant) };
  await writeFile(policyPath, `${JSON.stringify(open)}\n`, { mode: 0o600 });
  const openBytes = await readFile(policyPath, 'utf8');
  expect(await upgradePolicyTemplateInstallation(root, 'installation', true)).toMatchObject({ status: 'unavailable', reason: 'not-this-person' });
  expect(await readFile(policyPath, 'utf8')).toBe(openBytes);
});

it('never overwrites an existing, different policy.json: apply refuses before any journal entry, the file stays byte-identical, and doctor does not recognize it', async () => {
  const root = await project();
  await mkdir(join(root, '.deckent'), { mode: 0o700, recursive: true });
  const before = `${JSON.stringify({ schemaVersion: 1, revision: 'hand-authored', grants: [], restrictions: [] })}\n`;
  await writeFile(join(root, '.deckent/policy.json'), before, { mode: 0o600 });
  expect(await inspectPolicyTemplate(root)).toBeNull();

  await expect(applyPolicyTemplateInstallation(root, 'installation')).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CONFLICT' });

  expect(await readFile(join(root, '.deckent/policy.json'), 'utf8')).toBe(before);
  await expect(stat(join(root, '.deckent/bindings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(root, '.deckent/installation/journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await inspectPolicyTemplate(root)).toBeNull();
});

it('two different scopes cannot both occupy the same project\'s one installation journal', async () => {
  const root = await project();
  await applyPolicyTemplateInstallation(root, 'installation');
  await expect(applyPolicyTemplateInstallation(root, 'other-scope')).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CONFLICT' });
});

});

it.skipIf(process.platform !== 'linux' || bindingNotRun !== null)('[requires installation binding] refuses copied identity before direct policy setup publishes policy, bindings or journal', async () => {
  const original = await project(), copied = await project();
  await new FileInstallationIdentityStore(resolveProductLayout({ projectRoot: original })).loadOrCreate();
  await mkdir(join(copied, '.deckent'), { mode: 0o700 });
  await cp(join(original, '.deckent/installation-identity'), join(copied, '.deckent/installation-identity'), { recursive: true });
  const bytes = await readFile(join(copied, '.deckent/installation-identity/identity.json'));
  await expect(applyPolicyTemplateInstallation(copied, 'installation')).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
  expect(await readFile(join(copied, '.deckent/installation-identity/identity.json'))).toEqual(bytes);
  for (const name of ['policy.json', 'bindings.json', 'installation', 'project-identity']) {
    await expect(stat(join(copied, '.deckent', name))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it.skipIf(process.platform !== 'linux' || bindingNotRun !== null)('[requires installation binding] direct policy setup binds through the configured machine identity source, not the platform one', async () => {
  const root = await project(), source = join(root, 'machine-identity'); await writeFile(source, 'site-policy-template.node-0001\n');
  await mkdir(join(root, '.deckent'), { mode: 0o700 });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ installation: { machineIdentity: { source } } }), { mode: 0o600 }); clearConfigCache();
  const settings = { machineIdentity: { source } };
  const identity = await new FileInstallationIdentityStore(resolveProductLayout({ projectRoot: root }), undefined, undefined, settings).loadOrCreate();
  const path = join(root, '.deckent/installation-identity/identity.json'), bytes = await readFile(path, 'utf8');
  expect(JSON.parse(bytes).binding).toMatchObject({ strength: 'machine', source: 'configured' });
  // Without the configured settings the policy write path would compare against the platform identity (or a weak binding) and stop as RELOCATED.
  await expect(applyPolicyTemplateInstallation(root, 'installation')).resolves.toMatchObject({ status: 'installed' });
  expect(await readFile(path, 'utf8')).toBe(bytes);
  expect(JSON.parse(bytes).installationId).toBe(identity.installationId);
  clearConfigCache();
});


it.skipIf(process.platform === 'win32')('CLI previews exactly the v11 + v12 + v13 delta for v10, applies it on the previewed revision and preserves bindings', async () => {
  const root = await project(); await applyPolicyTemplateInstallation(root, 'installation');
  const path = join(root, '.deckent/policy.json'), bindingPath = join(root, '.deckent/bindings.json');
  const current = JSON.parse(await readFile(path, 'utf8')) as { grants: { id: string }[] };
  const ids = ['first-run-quota-release', 'first-run-integration', 'first-run-work-target-adopt', 'first-run-scope-inspect', 'first-run-service-shutdown', ...V13];
  const older = { ...current, revision: 'first-run-template-v10', grants: current.grants.filter(rule => !ids.includes(rule.id)) };
  await writeFile(path, JSON.stringify(older), { mode: 0o600 });
  const oldBindings = { ...JSON.parse(await readFile(bindingPath, 'utf8')), revision: 'first-run-template-v10-bindings' };
  await writeFile(bindingPath, JSON.stringify(oldBindings), { mode: 0o600 });
  const before = await readFile(path, 'utf8'), bindings = await readFile(bindingPath, 'utf8');
  const output: string[] = [], errors: string[] = [];
  const ctx = { root, initialize() {}, upgradePolicyTemplateInstallation, stdout: { write(value: string) { output.push(value); } },
    stderr: { write(value: string) { errors.push(value); } } };
  for (const locale of ['en', 'tr']) {
    output.length = 0;
    expect(await main(['init', 'policy', '--scope', 'installation', '--upgrade', '--preview', '--lang', locale], ctx)).toBe(0);
    for (const id of ids) expect(output.join('')).toContain(id);
    expect(output.join('')).toContain('--expect first-run-template-v10');
    expect(await readFile(path, 'utf8')).toBe(before);
  }
  const token = /--expect (first-run-template-v10~[a-f0-9]{12})/u.exec(output.join(''))?.[1];
  expect(token).toBeDefined();
  output.length = 0;
  // Negative (Astra 2596): the bare policy revision binds no service identity, so nothing is written.
  expect(await main(['init', 'policy', '--scope', 'installation', '--upgrade', '--apply', '--expect', 'first-run-template-v10', '--json'], ctx)).toBe(0);
  expect(JSON.parse(output.join(''))).toMatchObject({ status: 'conflict', reason: 'service-identity-unbound', rules: [] });
  expect(await readFile(path, 'utf8')).toBe(before);
  output.length = 0;
  expect(await main(['init', 'policy', '--scope', 'installation', '--upgrade', '--apply', '--expect', token!, '--json'], ctx)).toBe(0);
  expect(JSON.parse(output.join(''))).toMatchObject({ status: 'upgraded', template: { to: 18 } });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(current); expect(await readFile(bindingPath, 'utf8')).toBe(bindings);
  expect(errors).toEqual([]);
});
