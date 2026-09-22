import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inspectToolchainCurrency, prepareNativeCodingProfile } from '../../../src/index.js';
import { admittedToolchains } from '#composition/core/toolchains/index.js';
import { runKernelCommand } from '#surfaces/core/cli/index.js';
import { clearConfigCache, loadConfig } from '#platform/index.js';

const roots: string[] = []; const servers: Server[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const bounds = { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
function nativeProfile(id: string, provider: 'codex' | 'claude', cliVersion: string) {
  return structuredClone(prepareNativeCodingProfile({ schemaVersion: 1, template: { id, version: 1, adapter: { id: 'docker', version: 2 }, parameters: { ...bounds, argv: ['unused'] } },
    invocation: { schemaVersion: 2, provider, cliVersion, discovery: { schemaVersion: 1, mode: provider === 'claude' ? 'disabled' : 'repository' }, permissionMode: 'unattended', model: 'fixture-model', prompt: 'fixture task' } }).profile);
}
async function fixture(currency: Record<string, unknown>, versions: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-toolchains-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const profiles = [nativeProfile('codex-old', 'codex', 'codex-cli 0.150.0'), nativeProfile('codex-new', 'codex', 'codex-cli 0.155.1'), nativeProfile('claude', 'claude', '2.1.278 (Claude Code)'),
    { id: 'plain', version: 1, adapter: { id: 'docker', version: 2 }, parameters: { ...bounds, argv: ['true'] } }];
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, toolchains: { currency },
    admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry: { schemaVersion: 1, revision: 'r', profiles,
      kinds: profiles.map(profile => ({ kind: profile.id, profile: { id: profile.id, version: profile.version } })), evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] } } }));
  const requests: string[] = [];
  const server = createServer((request, response) => { requests.push(request.url ?? ''); const name = decodeURIComponent((request.url ?? '').replace(/^\//, '').replace(/\/latest$/, ''));
    const version = versions[name]; if (!version) { response.statusCode = 404; response.end('{}'); return; } response.end(JSON.stringify({ name, version })); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const options = { env: { HOME: join(root, 'home') } };
  return { project, options, endpoint, requests };
}

it('reports per provider from admitted preflight pins with one bounded registry read per package', async () => {
  const f = await fixture({}, { '@openai/codex': '0.155.1', '@anthropic-ai/claude-code': '2.1.300' });
  await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify({ ...JSON.parse(await (await import('node:fs/promises')).readFile(join(f.project, '.deckent/config.json'), 'utf8')), toolchains: { currency: { registryEndpoint: f.endpoint } } }));
  const config = await loadConfig(f.project, f.options);
  expect(admittedToolchains(config).map(item => `${item.provider}:${item.cliVersion}`).sort()).toEqual(['claude:2.1.278 (Claude Code)', 'codex:codex-cli 0.150.0', 'codex:codex-cli 0.155.1']);
  const report = await inspectToolchainCurrency(f.project, f.options);
  expect(report).toMatchObject({ mode: 'report', registryEndpoint: f.endpoint });
  const byProvider = Object.fromEntries(report.providers.map(entry => [entry.provider, entry]));
  expect(byProvider.codex).toMatchObject({ status: 'stale', latest: { version: '0.155.1' }, admitted: [{ profile: { id: 'codex-old' }, version: '0.150.0' }, { profile: { id: 'codex-new' }, version: '0.155.1' }] });
  expect(byProvider.claude).toMatchObject({ status: 'stale', latest: { version: '2.1.300' } });
  expect(byProvider.cursor).toMatchObject({ status: 'not-admitted', mechanism: 'installer-script', latest: null });
  expect(f.requests.sort()).toEqual(['/%40anthropic-ai%2Fclaude-code/latest', '/%40openai%2Fcodex/latest']);
});
it('stays offline-honest: disabled mode makes no request and an unreachable registry reports unknown-offline with a reason code', async () => {
  const off = await fixture({ mode: 'off' }, {});
  const disabled = await inspectToolchainCurrency(off.project, off.options);
  expect(disabled).toMatchObject({ mode: 'off', registryEndpoint: null });
  expect(disabled.providers.find(entry => entry.provider === 'codex')).toMatchObject({ status: 'disabled', latest: null });
  expect(off.requests).toEqual([]);
  const unreachable = await fixture({ registryEndpoint: 'http://127.0.0.1:1', timeoutMs: 500 }, {});
  const report = await inspectToolchainCurrency(unreachable.project, unreachable.options);
  expect(report.providers.find(entry => entry.provider === 'claude')).toMatchObject({ status: 'unknown-offline', reason: 'NPM_REGISTRY_UNAVAILABLE' });
  const injected = await inspectToolchainCurrency(unreachable.project, unreachable.options, async () => { throw new Error('boom'); });
  expect(injected.providers.find(entry => entry.provider === 'codex')).toMatchObject({ status: 'unknown-offline', reason: 'NPM_REGISTRY_UNAVAILABLE' });
});
it('doctor --toolchains is an explicit opt-in that embeds the report; default doctor and other commands never probe', async () => {
  const f = await fixture({}, { '@openai/codex': '0.155.1', '@anthropic-ai/claude-code': '2.1.278' });
  let calls = 0; const lines: string[] = [];
  const context = { root: f.project, env: { HOME: join(f.project, '..', 'home') }, stdout: { write: (text: string) => { lines.push(text); return true; } },
    inspectToolchainCurrency: async (root: string) => { calls++; return inspectToolchainCurrency(root, f.options, async request => ({ version: '0.155.1', source: `fixture/${request.package}`, observedAt: new Date().toISOString() })); } };
  await runKernelCommand(['doctor', '--json'], context);
  expect(calls).toBe(0); expect(JSON.parse(lines.join(''))).not.toHaveProperty('toolchains');
  lines.length = 0;
  await runKernelCommand(['doctor', '--toolchains', '--json'], context);
  const data = JSON.parse(lines.join('')); expect(calls).toBe(1);
  expect(data.toolchains.providers.find((entry: { provider: string }) => entry.provider === 'codex')).toMatchObject({ status: 'stale' });
  expect(data.toolchains.providers.find((entry: { provider: string }) => entry.provider === 'claude')).toMatchObject({ status: 'ahead' });
  lines.length = 0;
  await runKernelCommand(['doctor', '--toolchains', '--lang', 'tr'], context);
  expect(lines.join('')).toMatch(/Toolchain güncelliği/); expect(lines.join('')).toMatch(/codex: stale/);
  await expect(runKernelCommand(['paths', '--toolchains'], context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  await expect(runKernelCommand(['doctor', '--toolchains', '--json'], { ...context, inspectToolchainCurrency: undefined })).rejects.toMatchObject({ code: 'CLI_USAGE' });
});
