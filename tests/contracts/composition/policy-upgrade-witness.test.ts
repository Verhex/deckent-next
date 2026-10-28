import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPolicyTemplateInstallation, upgradePolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { attestLocalInteractiveTerminal, withLocalPrincipalChannel } from '#adapters/index.js';
import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS } from '#domain/index.js';
import { main } from '#surfaces/index.js';

// I-POL (lead decision on SEC-1 open item 2, owner A48-D5): `deckent init policy --upgrade --apply` writes authority outside the governed chain, so it
// needs the SEC-1 authority witness (Core: a person at this process's controlling terminal). Without it, or from the MCP actor, it is refused with
// `AUTHORITY_WITNESS_REQUIRED` before anything is read or written; `--preview` needs no witness. vitest itself runs without a terminal.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
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
    await applyPolicyTemplateInstallation(root, 'installation');
    const policyPath = join(root, '.deckent/policy.json');
    const current = JSON.parse(await readFile(policyPath, 'utf8')) as { revision: string; grants: { id: string }[] };
    const delta: readonly string[] = FIRST_RUN_CURRENT_UPGRADE_RULE_IDS;
    await writeFile(policyPath, JSON.stringify({ ...current, revision: 'first-run-template-v17', grants: current.grants.filter(rule => !delta.includes(rule.id)) }), { mode: 0o600 });
    // The test process has no controlling terminal: the Core witness says no.
    expect(await attestLocalInteractiveTerminal()).toBe(false);
    const preview = await upgradePolicyTemplateInstallation(root, 'installation', false);
    expect(preview).toMatchObject({ status: 'preview', template: { to: 18 } });
    const before = await snapshot(root), mtime = (await stat(policyPath)).mtimeMs;

    // Default (Core) witness, no terminal: typed refusal, every file byte-identical.
    await expect(upgradePolicyTemplateInstallation(root, 'installation', true, preview.expect!)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    // The MCP actor is refused even when a witness would attest.
    await expect(withLocalPrincipalChannel('mcp', () => upgradePolicyTemplateInstallation(root, 'installation', true, preview.expect!, {}, process.getuid?.(), undefined, attested)))
      .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    // The CLI (no terminal): a failing exit with the typed code, nothing written.
    const output: string[] = [], errors: string[] = [];
    const ctx = { root, initialize() {}, upgradePolicyTemplateInstallation, stdout: { write(value: string) { output.push(value); } }, stderr: { write(value: string) { errors.push(value); } } };
    expect(await main(['init', 'policy', '--scope', 'installation', '--upgrade', '--apply', '--expect', preview.expect!, '--json'], ctx)).not.toBe(0);
    expect([...output, ...errors].join('')).toContain('AUTHORITY_WITNESS_REQUIRED');
    expect(await snapshot(root)).toEqual(before);
    expect((await stat(policyPath)).mtimeMs).toBe(mtime);

    // Positive control: the same witnessed apply restores every v18 grant and keeps the separately installed workload roles.
    expect(await upgradePolicyTemplateInstallation(root, 'installation', true, preview.expect!, {}, process.getuid?.(), undefined, attested))
      .toMatchObject({ status: 'upgraded', template: { to: 18 } });
    const upgraded = JSON.parse(await readFile(policyPath, 'utf8'));
    expect(upgraded).toEqual({ ...current, revision: expect.stringMatching(/^a-/u) });
    expect(upgraded.revision).not.toBe(current.revision); // The explicit v17 rewrite cannot reuse the earlier authority revision.
  });
});
