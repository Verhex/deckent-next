import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeNativeCodingRegistry, configureNativeCodingTemplate } from '#composition/core/native-coding/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { withMcpPrincipal } from '#adapters/index.js';
import { clearConfigCache } from '#platform/index.js';
import { main } from '#surfaces/core/cli/index.js';

/**
 * alpha.55.1 (same class as functest B P1): `deckent init registry --apply` and `deckent coding template --apply` write the protected
 * `admission` root on a person's behalf, so they need the same person terminal witness as `config set`: the composed writer asks it
 * (assertConfigPersonWitness) before the write, the CLI refuses the AI marker, a pipe and `--json` before anything. `--preview` stays open.
 */
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const docker = { executable: 'docker', imageId: `sha256:${'a'.repeat(64)}`, memoryBytes: 268435456, cpus: 1, pids: 64,
  logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const registry = { schemaVersion: 1, scopeId: 's', provider: 'claude', kind: 'feature', poolId: 'customer', executionSlots: 3, inFlightSlots: 5, discovery: 'repository' };
const detect = async () => '2.1.285 (Claude Code)';
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'native-template-witness-')); roots.push(root);
  await applyPolicyTemplateInstallation(root, 's');
  const path = join(root, '.deckent/config.json'), options = { env: { DECKENT_GLOBAL_HOME: join(root, 'global') } };
  const config = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  config['terminal'] = { ...(config['terminal'] as object), scopeId: 's' }; config['execution'] = { docker, git: { gitExecutable: 'git', timeoutMs: 5000 } };
  await writeFile(path, JSON.stringify(config)); clearConfigCache();
  return { root, path, options };
}
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; params?: Record<string, unknown> }) => error);
const witness = (value: boolean) => ({ attest: async () => value });

describe.skipIf(process.platform === 'win32')('native registry and template writes of `admission` need the person terminal witness', () => {
  it('init registry --apply: refused without the witness and for the MCP actor, nothing written; the witnessed person applies it', async () => {
    const f = await setup(), before = await readFile(f.path, 'utf8');
    expect(await refusal(initializeNativeCodingRegistry(f.root, { ...registry, apply: true }, f.options, { detect, witness: witness(false) })))
      .toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED', params: { operation: 'config set admission' } });
    expect(await refusal(withMcpPrincipal(() => initializeNativeCodingRegistry(f.root, { ...registry, apply: true }, f.options, { detect, witness: witness(true) }))))
      .toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(await readFile(f.path, 'utf8')).toBe(before);
    expect((await initializeNativeCodingRegistry(f.root, { ...registry, apply: false }, f.options, { detect, witness: witness(false) })).status).toBe('preview');
    expect((await initializeNativeCodingRegistry(f.root, { ...registry, apply: true }, f.options, { detect, witness: witness(true) })).status).toBe('applied');
  });
  it('coding template --apply: refused without the witness, nothing written; the witnessed person applies it', async () => {
    const f = await setup();
    await initializeNativeCodingRegistry(f.root, { ...registry, apply: true }, f.options, { detect, witness: witness(true) });
    const before = await readFile(f.path, 'utf8'), request = { provider: 'claude', kind: 'review', apply: true };
    expect(await refusal(configureNativeCodingTemplate(f.root, request, f.options, { witness: witness(false) })))
      .toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED', params: { operation: 'config set admission.registry' } });
    expect(await readFile(f.path, 'utf8')).toBe(before);
    expect((await configureNativeCodingTemplate(f.root, { ...request, apply: false }, f.options, { witness: witness(false) })).status).toBe('preview');
    expect((await configureNativeCodingTemplate(f.root, request, f.options, { witness: witness(true) })).status).toBe('applied');
  });
  it('the CLI refuses --apply under the AI marker, through a pipe and with --json before the handler runs; --preview stays open', async () => {
    const handlers = { initializeNativeCodingRegistry: vi.fn(async () => { throw new Error('must not run'); }), configureCodingTemplate: vi.fn(async () => { throw new Error('must not run'); }) };
    const commands = [['init', 'registry', '--scope', 's', '--provider', 'claude', '--kind', 'feature', '--pool', 'p', '--execution-slots', '1', '--in-flight-slots', '1', '--apply'],
      ['coding', 'template', '--provider', 'claude', '--kind', 'feature', '--apply']];
    const term = { TERM: 'xterm-256color', HOME: tmpdir() };
    const ios = [{ env: { ...term, CLAUDECODE: '1' }, tty: true, json: false }, { env: term, tty: false, json: false }, { env: term, tty: true, json: true }];
    for (const argv of commands) for (const io of ios) {
      let error = '';
      const context = { root: '/tmp/native-template-witness', env: io.env, stdin: { isTTY: io.tty }, stdout: { isTTY: io.tty, write: () => true },
        stderr: { write: (chunk: string) => { error += chunk; return true; } }, ...handlers };
      expect(await main([...argv, ...(io.json ? ['--json'] : [])], context as never), `${argv.join(' ')} ${JSON.stringify(io)}`).not.toBe(0);
      expect(error).toContain('AUTHORITY_WITNESS_REQUIRED');
    }
    expect(handlers.initializeNativeCodingRegistry).not.toHaveBeenCalled(); expect(handlers.configureCodingTemplate).not.toHaveBeenCalled();
  });
});
