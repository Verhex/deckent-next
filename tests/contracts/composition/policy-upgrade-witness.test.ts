import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPolicyTemplateInstallation, upgradePolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { attestLocalInteractiveTerminal, withLocalPrincipalChannel } from '#adapters/index.js';
import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS } from '#domain/index.js';
import * as adapters from '#adapters/index.js';
import { configuredPolicyTemplateUpgrade } from '#composition/core/approvals/index.js';
import { getConfigFieldDefault } from '#platform/index.js';
import { terminalApplication } from '../support/approval-terminal.js';
import { homeEnv } from '../support/host-platform.js';
import { main } from '#surfaces/index.js';

// I-POL (lead decision on SEC-1 open item 2, owner A48-D5): `deckent init policy --upgrade --apply` writes authority outside the governed chain, so it
// needs the SEC-1 authority witness (Core: a person at this process's controlling terminal). Without it, or from the MCP actor, it is refused with
// `AUTHORITY_WITNESS_REQUIRED` before anything is read or written; `--preview` needs no witness. vitest itself runs without a terminal.
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const attested = { attest: async () => true };
/** Every file under the data root with its bytes: the refusal must leave all of them (policy, bindings, config, journal, ledger, identities) as they were. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[relative(root, path)] = (await readFile(path)).toString('base64');
  }
  return out;
}

describe.skipIf(process.platform !== 'linux')('init policy --upgrade --apply needs the authority witness (SEC-1)', () => {
  it('a non-terminal apply and an MCP apply are refused with nothing written; preview works; a witnessed apply upgrades', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-policy-witness-')); roots.push(root);
    await applyPolicyTemplateInstallation(root, 'installation', { env: homeEnv(join(root, 'home')) });
    const policyPath = join(root, '.deckent/policy.json');
    const current = JSON.parse(await readFile(policyPath, 'utf8')) as { revision: string; grants: { id: string }[] };
    const delta: readonly string[] = FIRST_RUN_CURRENT_UPGRADE_RULE_IDS;
    await writeFile(policyPath, JSON.stringify({ ...current, revision: 'first-run-template-v17', grants: current.grants.filter(rule => !delta.includes(rule.id)) }), { mode: 0o600 });
    // The test process has no controlling terminal: the Core witness says no.
    expect(await attestLocalInteractiveTerminal()).toBe(false);
    const preview = await upgradePolicyTemplateInstallation(root, 'installation', false, undefined, { env: homeEnv(join(root, 'home')) });
    expect(preview).toMatchObject({ status: 'preview', template: { to: 20 } });
    const before = await snapshot(root), mtime = (await stat(policyPath)).mtimeMs;

    // Default (Core) witness, no terminal: typed refusal, every file byte-identical.
    await expect(upgradePolicyTemplateInstallation(root, 'installation', true, preview.expect!)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    // The MCP actor is refused even when a witness would attest.
    await expect(withLocalPrincipalChannel('mcp', () => upgradePolicyTemplateInstallation(root, 'installation', true, preview.expect!, { env: homeEnv(join(root, 'home')) }, process.getuid?.(), undefined, attested)))
      .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    // The CLI (no terminal): a failing exit with the typed code, nothing written.
    const output: string[] = [], errors: string[] = [];
    const ctx = { root, initialize() {}, upgradePolicyTemplateInstallation: (root: string, scope: string, apply: boolean, expect?: string) => upgradePolicyTemplateInstallation(root, scope, apply, expect, { env: homeEnv(join(root, 'home')) }), stdout: { write(value: string) { output.push(value); } }, stderr: { write(value: string) { errors.push(value); } } };
    expect(await main(['init', 'policy', '--scope', 'installation', '--upgrade', '--apply', '--expect', preview.expect!, '--json'], ctx)).not.toBe(0);
    expect([...output, ...errors].join('')).toContain('AUTHORITY_WITNESS_REQUIRED');
    expect(await snapshot(root)).toEqual(before);
    expect((await stat(policyPath)).mtimeMs).toBe(mtime);

    // Positive control: the same witnessed apply restores every v20 grant and keeps the separately installed workload roles.
    expect(await upgradePolicyTemplateInstallation(root, 'installation', true, preview.expect!, { env: homeEnv(join(root, 'home')) }, process.getuid?.(), undefined, attested))
      .toMatchObject({ status: 'upgraded', template: { to: 20 } });
    const upgraded = JSON.parse(await readFile(policyPath, 'utf8'));
    expect(upgraded).toEqual({ ...current, revision: expect.stringMatching(/^a-/u), grants: [...current.grants, ...preview.rules] });
    expect(upgraded.grants.filter((rule: { id: string }) => !delta.includes(rule.id))).toEqual(current.grants);
    expect(upgraded.revision).not.toBe(current.revision); // The explicit v17 rewrite cannot reuse the earlier authority revision.
  });
});

// The risky path has a terminal witness; only the automation marker must prevent opening administration.
it.skipIf(process.platform !== 'linux')('119-F1a: AI-marked person apply AND rollback refuse before all writes; markerless terminal succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-upgrade-marker-')); roots.push(root);
  await applyPolicyTemplateInstallation(root, 'installation', { env: homeEnv(join(root, 'home')) });
  const marker = getConfigFieldDefault('cli').agentEnvironment[0]!, marked = { env: { ...homeEnv(join(root, 'home')), [marker]: '1' } };
  vi.spyOn(adapters, 'attestLocalInteractiveTerminal').mockResolvedValue(true);
  const preview = await upgradePolicyTemplateInstallation(root, 'installation', false, undefined, marked);
  expect(preview).toMatchObject({ status: 'preview', rules: FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.map(id => ({ id })) });
  const before = await snapshot(root);
  await expect(upgradePolicyTemplateInstallation(root, 'installation', true, preview.expect!, marked, process.getuid?.(), undefined, attested))
    .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  for (const mode of ['apply', 'rollback'] as const) for (const only of [undefined, 'ai-execution'] as const) {
    await expect(configuredPolicyTemplateUpgrade(root, 'installation', marked, { mode, reason: 'agent at a PTY', ...(only ? { only } : {}) }))
      .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(await snapshot(root)).toEqual(before);
  }
  expect(await snapshot(root)).toEqual(before);
  const personTerminalEnv = { ...homeEnv(join(root, 'home')), ...Object.fromEntries(getConfigFieldDefault('cli').agentEnvironment.map(name => [name, undefined])) };
  expect(await upgradePolicyTemplateInstallation(root, 'installation', true, preview.expect!, { env: personTerminalEnv }, process.getuid?.(), undefined, attested))
    .toMatchObject({ status: 'upgraded', rules: FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.map(id => ({ id })) });
  expect(await terminalApplication({ project: root, env: personTerminalEnv }, 'policy-upgrade', 'installation', { mode: 'rollback', reason: 'person withdraws' }))
    .toMatchObject({ status: 'rolled-back', reason: FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.join(',') });
  const after = JSON.parse(await readFile(join(root, '.deckent/policy.json'), 'utf8'));
  expect(after.grants.some((rule: { id: string }) => FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.includes(rule.id))).toBe(false);
  expect(await terminalApplication({ project: root, env: personTerminalEnv }, 'policy-upgrade', 'installation', { mode: 'apply', only: 'ai-execution', reason: 'markerless person at terminal' }))
    .toMatchObject({ status: 'upgraded' });
  expect(await terminalApplication({ project: root, env: personTerminalEnv }, 'policy-upgrade', 'installation', { mode: 'rollback', only: 'ai-execution', reason: 'person withdraws again' }))
    .toMatchObject({ status: 'rolled-back', reason: FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.join(',') });
});


it.skipIf(process.platform !== 'linux')('119-F1a-3: a fresh installed system-row baseline permits a real person governed21 add and archive rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-fresh-governed-custody-')); roots.push(root);
  const env = { ...homeEnv(join(root, 'home')), ...Object.fromEntries(getConfigFieldDefault('cli').agentEnvironment.map(name => [name, undefined])) };
  await applyPolicyTemplateInstallation(root, 'installation', { env });
  const path = join(root, '.deckent/policy.json'), baseline = JSON.parse(await readFile(path, 'utf8'));
  expect(baseline.grants.some((rule: { id: string }) => FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.includes(rule.id))).toBe(false);
  expect(await terminalApplication({ project: root, env }, 'policy-upgrade', 'installation', { mode: 'apply', only: 'ai-execution', reason: 'person grants on fresh install' }))
    .toMatchObject({ status: 'upgraded', rules: FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.map(id => ({ id })) });
  expect(await terminalApplication({ project: root, env }, 'policy-upgrade', 'installation', { mode: 'rollback', reason: 'person withdraws on fresh install' }))
    .toMatchObject({ status: 'rolled-back', reason: FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.join(','), conflicts: [] });
  expect(JSON.parse(await readFile(path, 'utf8')).grants).toEqual(baseline.grants);
});
