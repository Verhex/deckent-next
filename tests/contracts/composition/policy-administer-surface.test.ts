import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { executeConfiguredOperation } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { main as cli } from '#surfaces/core/cli/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { AUTHORITY_DOCUMENT_TARGET_KIND, POLICY_ADMINISTER_OPERATION } from '#domain/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';

// POLICY-ADMIN P3 (I5-i): the generic operation producers — SDK `executeOperation`, CLI `deckent operation`, and the runtime service
// behind MCP `execute_operation` (same composition function) — refuse an authority-surface operation with a typed refusal, even for a
// principal whose policy allows every operation. Nothing is asked, recorded or written.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); clearConfigCache(); });
registerProviderConfig();

it('refuses policy.administer@1 on the SDK and the product CLI with OPERATION_SURFACE_RESTRICTED; the policy file stays byte-identical', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-authority-surface-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'project'); await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 });
  const options = { env: { HOME: join(root, 'home') } };
  await writeFile(join(dir, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') } }));
  const opened = await openConfiguredAttemptStore(dir, options); opened.store.close();
  const policyPath = productResourcePath(opened.layout, 'policy');
  await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, revision: 'all-ops', restrictions: [], grants: [
    { id: 'ops', effect: 'allow', actions: 'all', scopes: ['s'], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'operation', ids: 'all' } }] }), { mode: 0o600 });
  const before = await readFile(policyPath, 'utf8');
  const command = (commandId: string) => ({ schemaVersion: 1 as const, commandId, scopeId: 's', operation: POLICY_ADMINISTER_OPERATION.operation,
    target: { kind: AUTHORITY_DOCUMENT_TARGET_KIND, id: 'installation' }, idempotencyKey: commandId, input: { schemaVersion: 1, changes: [{ kind: 'grant.remove', id: 'ops' }] },
    expectedVersion: 'all-ops' });
  await expect(executeConfiguredOperation(dir, command('sdk'), options)).rejects.toMatchObject({ code: 'OPERATION_SURFACE_RESTRICTED' });
  const input = join(root, 'cli.json'); await writeFile(input, JSON.stringify(command('cli')));
  const lines: string[] = [];
  const exit = await cli(['operation', 'execute', '--input', input, '--json'], { root: dir, env: options.env, initialize: registerProviderConfig,
    executeOperation: executeConfiguredOperation, stdout: { write: (text: string) => { lines.push(text); return true; } }, stderr: { write: (text: string) => { lines.push(text); return true; } } });
  expect(exit).not.toBe(0);
  expect(lines.join('')).toContain('OPERATION_SURFACE_RESTRICTED');
  expect(await readFile(policyPath, 'utf8')).toBe(before);
});
