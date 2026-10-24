import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { openSqliteLedger, withMcpPrincipal } from '#adapters/index.js';
import { getConfigFieldDefault, prepareProductFile, resolveProductLayout } from '#platform/index.js';

/**
 * alpha.55.1 hotfix: the composed config application (every human surface: CLI, terminal `/config`, its window and records) asks the same
 * terminal witness as the other person-only commands before a write that changes a protected root; the MCP actor is refused whatever the
 * process holds. Real policy, ledger and file writer; the witness is injected (the default is this process's controlling terminal).
 */
beforeEach(context => { if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED'); });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'config-witness-')); roots.push(root);
  const options = { env: { DECKENT_GLOBAL_HOME: join(root, 'global') } };
  await applyPolicyTemplateInstallation(root, 'installation');
  openSqliteLedger(await prepareProductFile(resolveProductLayout({ projectRoot: root }), 'ledger', ['-wal', '-shm', '-journal']), getConfigFieldDefault('storage').sqlite).close();
  const principal = await resolveConfiguredConfigPrincipal(root, 'installation', options);
  return { root, options, path: join(root, '.deckent/config.json'), command: { principal, scopeId: 'installation', layer: 'project' as const } };
}
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; params?: Record<string, unknown> }) => error);
const witness = (value: boolean) => ({ attest: async () => value });

describe('configured config: protected roots need the person terminal witness', () => {
  it('without the terminal witness every protected root is refused and nothing is written; a non-protected key still writes', async () => {
    const f = await setup(), app = createConfiguredConfigApplication(f.root, f.options, undefined, witness(false)), before = await readFile(f.path, 'utf8');
    for (const [index, keyPath] of ['memoryAutomation.extraction.mode', 'runRuntime.nervous.mode', 'runRuntime.recovery.mode', 'catalogEvolution.mode'].entries()) {
      expect(await refusal(app.submit('set', { ...f.command, keyPath, value: 'shadow', commandId: `p${index}` })))
        .toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED', params: { operation: `config set ${keyPath}` } });
    }
    expect(await refusal(app.submit('unset', { ...f.command, keyPath: 'models.headless', commandId: 'u1' }))).toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(await readFile(f.path, 'utf8')).toBe(before);
    expect(await app.submit('set', { ...f.command, keyPath: 'max_workers', value: 2, commandId: 'n1' })).toMatchObject({ status: 'applied' });
  });
  it('with the witness the person writes a protected switch; the MCP actor is refused even when the process holds a terminal', async () => {
    const f = await setup(), app = createConfiguredConfigApplication(f.root, f.options, undefined, witness(true));
    expect(await app.submit('set', { ...f.command, keyPath: 'memoryAutomation.extraction.mode', value: 'shadow', commandId: 'w1' })).toMatchObject({ status: 'applied' });
    expect(JSON.parse(await readFile(f.path, 'utf8')).memoryAutomation.extraction.mode).toBe('shadow');
    expect(await refusal(withMcpPrincipal(() => app.submit('set', { ...f.command, keyPath: 'runRuntime.nervous.mode', value: 'shadow', commandId: 'm1' }))))
      .toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  });
});
