import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareNativeCodingProfile, updateToolchains } from '../../../src/index.js';
import { main as cliMain, toolchainsCommand } from '#surfaces/core/cli/index.js';
import { clearConfigCache } from '#platform/index.js';
import type { WorkerImageBuildRunner } from '#adapters/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const imageId = 'sha256:' + 'a'.repeat(64);
const bounds = { imageId, memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
function nativeProfile(id: string, provider: 'codex' | 'claude', cliVersion: string) {
  return structuredClone(prepareNativeCodingProfile({ schemaVersion: 1, template: { id, version: 1, adapter: { id: 'docker', version: 2 }, parameters: { ...bounds, argv: ['unused'] } },
    invocation: { schemaVersion: 2, provider, cliVersion, discovery: { schemaVersion: 1, mode: provider === 'claude' ? 'disabled' : 'repository' }, permissionMode: 'unattended', model: 'fixture-model', prompt: 'fixture task' } }).profile);
}
async function fixture(update: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-toolchain-update-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const profiles = [nativeProfile('codex-pinned', 'codex', 'codex-cli 0.155.1'), nativeProfile('claude-pinned', 'claude', '2.1.278 (Claude Code)')];
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, toolchains: { currency: { registryEndpoint: 'http://127.0.0.1:1' }, update },
    admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry: { schemaVersion: 1, revision: 'r', profiles,
      kinds: profiles.map(profile => ({ kind: profile.id, profile: { id: profile.id, version: profile.version } })), evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] } } }));
  const latest: Record<string, string> = { '@openai/codex': '0.156.0', '@anthropic-ai/claude-code': '2.1.278' };
  const fetcher = async (request: { package: string }) => ({ version: latest[request.package]!, source: `fixture/${request.package}`, observedAt: new Date().toISOString() });
  const options = { env: { HOME: join(root, 'home'), PATH: process.env.PATH ?? '/usr/bin' } };
  const runs: string[] = []; const checks: string[][] = [];
  const runner: WorkerImageBuildRunner = async command => {
    if (command.args[1] === '--check-version') {
      checks.push([...command.args]);
      return { schemaVersion: 1, requestId: command.requestId, started: true, reason: 'exit', exitCode: 0, signal: null, stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1 };
    }
    runs.push(command.args.join(' '));
    const recipe = JSON.parse(await readFile(join(command.cwd, 'recipe.json'), 'utf8')) as { imageVersion: string; repository: string };
    await writeFile(command.args[1]!, JSON.stringify({ schemaVersion: 2, imageId: 'sha256:' + 'b'.repeat(64), imageVersion: recipe.imageVersion, tag: `${recipe.repository}:${recipe.imageVersion}`,
      manifest: { providers: [{ id: 'codex', version: 'codex-cli 0.156.0' }, { id: 'claude', version: '2.1.278 (Claude Code)' }, { id: 'cursor', version: '2026.09.18-9a7762b' }] } }));
    return { schemaVersion: 1, requestId: command.requestId, started: true, reason: 'exit', exitCode: 0, signal: null, stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 5 };
  };
  return { project, options, fetcher, runner, runs, checks, latest, home: join(root, 'data/workspaces/toolchains') };
}

describe.skipIf(process.platform !== 'linux')('policy-driven toolchain update', () => {
  it('refuses a lagging recipe against daemon r4 before writing a plan or creating a build context', async () => {
    const f = await fixture({});
    const packageRoot = join(f.project, 'package');
    await cp(join(process.cwd(), 'assets/worker-image'), join(packageRoot, 'assets/worker-image'), { recursive: true });
    const recipePath = join(packageRoot, 'assets/worker-image/recipe.json');
    const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
    await writeFile(recipePath, JSON.stringify({ ...recipe, imageVersion: 'r3-20260922', previousVersion: 'r2-20260922' }));
    const dockerfilePath = join(packageRoot, 'assets/worker-image/Dockerfile');
    await writeFile(dockerfilePath, (await readFile(dockerfilePath, 'utf8')).replace(/^# version r4[^\n]*\n/m, ''));
    const seen: string[][] = [];
    const runner: WorkerImageBuildRunner = async command => {
      seen.push([...command.args]);
      if (command.args[1] !== '--check-version') return f.runner(command);
      return { schemaVersion: 1, requestId: command.requestId, started: true, reason: 'exit', exitCode: 1, signal: null,
        stdoutBase64: '', stderrBase64: Buffer.from('Error: WORKER_VERSION_COUNTER_TAKEN: r4-20261003 does not advance past r4-20260930 already held by the daemon.').toString('base64'),
        stdoutTruncated: false, stderrTruncated: false, durationMs: 1 };
    };
    await expect(updateToolchains(f.project, { apply: true }, f.options, { fetcher: f.fetcher, runner, packageRoot, now: () => '2026-10-03T12:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'WORKER_VERSION_COUNTER_TAKEN', params: { detail: expect.stringContaining('r4-20260930') } });
    expect(seen).toEqual([[join(packageRoot, 'assets/worker-image/build.mjs'), '--check-version', 'r4-20261003']]);
    expect(f.runs).toEqual([]); expect(f.checks).toEqual([]);
    await expect(readdir(f.home)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['en', 'tr'])('surfaces the builder typed counter reason and a bounded redacted excerpt in CLI JSON (%s)', async language => {
    const f = await fixture({});
    const runner: WorkerImageBuildRunner = async command => ({ schemaVersion: 1, requestId: command.requestId, started: true, reason: 'exit',
      exitCode: command.args[1] === '--check-version' ? 0 : 1, signal: null, stdoutBase64: '',
      stderrBase64: command.args[1] === '--check-version' ? '' : Buffer.from('Error: WORKER_VERSION_COUNTER_TAKEN: r5-20261003 blocked; token=fixture-secret Bearer fixture-bearer sk-ant-fixturekey ' + 'x'.repeat(2000) + '\n    at builder (/private/path:1:1)').toString('base64'),
      stdoutTruncated: false, stderrTruncated: false, durationMs: 1 });
    const errors: string[] = [];
    const exitCode = await cliMain(['toolchains', 'update', '--apply', '--json', '--lang', language], { root: f.project, env: f.options.env,
      stderr: { write: (text: string) => { errors.push(text); return true; } },
      updateToolchains: (root, input, options) => updateToolchains(root, input, options, { fetcher: f.fetcher, runner, now: () => '2026-10-03T12:00:00.000Z' }) });
    expect(exitCode).toBe(1);
    const error = JSON.parse(errors.join(''));
    expect(error.code).toBe('WORKER_VERSION_COUNTER_TAKEN');
    expect(error.message).toMatch(language === 'tr' ? /sayacı/ : /counter/);
    expect(error.params.detail).toContain('[REDACTED]');
    expect(Buffer.byteLength(error.params.detail)).toBeLessThanOrEqual(512);
    expect(errors.join('')).not.toMatch(/fixture-secret|fixture-bearer|sk-ant-fixturekey|private\/path|UNKNOWN/);
  });
  it('off is disabled; propose writes only a plan; apply builds in a product-owned context and proposes exact profile revisions', async () => {
    const off = await fixture({ mode: 'off' });
    expect(await updateToolchains(off.project, {}, off.options, { fetcher: off.fetcher, runner: off.runner })).toMatchObject({ decision: 'disabled', plan: null });
    const f = await fixture({ mode: 'propose' });
    const planned = await updateToolchains(f.project, {}, f.options, { fetcher: f.fetcher, runner: f.runner, now: () => '2026-09-23T08:00:00.000Z' });
    expect(planned).toMatchObject({ mode: 'propose', decision: 'planned', build: null, proposal: null, plan: { decision: 'build', staleProviders: ['codex'], next: { imageVersion: 'r5-20260923' } } });
    // The packaged recipe carries the r4-20260930 lineage, so the product path plans r4 (never a second r3).
    expect(planned.plan).toMatchObject({ current: { imageVersion: 'r4-20260930' }, next: { previousVersion: 'r4-20260930' } });
    expect(planned.plan!.next!.historyLine).toMatch(/^# version r5-20260923 \| 2026-09-23 \| base node:24-trixie-slim \| supersedes r4-20260930 \| /);
    expect(planned.plan!.affectedProfiles).toEqual([{ profile: { id: 'codex-pinned', version: 1 }, provider: 'codex', cliVersion: 'codex-cli 0.155.1', imageId }]);
    expect(await readdir(join(f.home, 'plans'))).toHaveLength(1); expect(f.runs).toEqual([]); expect(f.checks).toEqual([]);
    const built = await updateToolchains(f.project, { apply: true }, f.options, { fetcher: f.fetcher, runner: f.runner, now: () => '2026-09-23T08:05:00.000Z' });
    expect(built).toMatchObject({ decision: 'built', build: { imageId: 'sha256:' + 'b'.repeat(64), tag: 'deckent/worker:r5-20260923' },
      proposal: { imageVersion: 'r5-20260923', application: 'not-applied', profiles: [{ profile: { id: 'codex-pinned' }, changes: { cliVersion: { from: 'codex-cli 0.155.1', to: 'codex-cli 0.156.0' }, imageId: { from: imageId, to: 'sha256:' + 'b'.repeat(64) } } }] } });
    expect(f.checks).toEqual([[join(process.cwd(), 'assets/worker-image/build.mjs'), '--check-version', 'r5-20260923']]);
    expect(f.runs).toHaveLength(1); expect(f.runs[0]).toMatch(/builds\/r5-20260923\/build\.mjs .*receipts\/r5-20260923\.json$/);
    expect((await readdir(join(f.home, 'builds', 'r5-20260923'))).sort()).toEqual(['Dockerfile', 'build.mjs', 'history.mjs', 'inspect.mjs', 'install.mjs', 'recipe.json']);
    expect(JSON.parse(await readFile(built.proposalPath!, 'utf8'))).toEqual(built.proposal);
    // Installed config is never rewritten by the update operation.
    expect(JSON.parse(await readFile(join(f.project, '.deckent/config.json'), 'utf8')).admission.registry.profiles[0].parameters.nativeSubscription.preflight.cliVersion).toBe('codex-cli 0.155.1');
    // The built r5 continues the lineage (WORKER-AUTO-REFRESH): a second apply, still stale because manual update never rewrites config, plans r6 from r5
    // and never reuses r5's taken context; the next counter is what the builder's guard demands.
    const second = await updateToolchains(f.project, { apply: true }, f.options, { fetcher: f.fetcher, runner: f.runner, now: () => '2026-09-23T08:10:00.000Z' });
    expect(second.plan).toMatchObject({ current: { imageVersion: 'r5-20260923' }, next: { imageVersion: 'r6-20260923', previousVersion: 'r5-20260923' } });
  });
  it('auto without a flag only plans (manual command), fresh toolchains yield no-change, and the CLI command renders the decision', async () => {
    const f = await fixture({ mode: 'auto' });
    f.latest['@openai/codex'] = '0.155.1';
    expect(await updateToolchains(f.project, {}, f.options, { fetcher: f.fetcher, runner: f.runner })).toMatchObject({ decision: 'no-change', planPath: null });
    f.latest['@openai/codex'] = '0.157.0';
    const built = await updateToolchains(f.project, {}, f.options, { fetcher: f.fetcher, runner: f.runner, now: () => '2026-09-24T08:00:00.000Z' });
    expect(built).toMatchObject({ mode: 'auto', decision: 'planned', build: null, proposal: null, plan: { next: { imageVersion: 'r5-20260924' } } });
    expect(f.runs).toEqual([]); // the default config + no flag never builds
    const applied = await updateToolchains(f.project, { apply: true }, f.options, { fetcher: f.fetcher, runner: f.runner, now: () => '2026-09-24T08:05:00.000Z' });
    expect(applied).toMatchObject({ decision: 'built' }); expect(f.runs).toHaveLength(1);
    const lines: string[] = [];
    await toolchainsCommand(['toolchains', 'update', '--json'], { root: f.project, env: f.options.env, stdout: { write: (text: string) => { lines.push(text); return true; } },
      updateToolchains: async () => ({ decision: 'planned', plan: { next: { imageVersion: 'r5-20260924' } }, build: null, proposalPath: null }) });
    expect(JSON.parse(lines.join(''))).toMatchObject({ decision: 'planned' });
    lines.length = 0;
    await toolchainsCommand(['toolchains', 'update', '--lang', 'tr'], { root: f.project, env: f.options.env, stdout: { write: (text: string) => { lines.push(text); return true; } },
      updateToolchains: async () => ({ decision: 'built', plan: { next: { imageVersion: 'r5-20260924' } }, build: { imageId: 'sha256:' + 'b'.repeat(64), tag: 'deckent/worker:r5-20260924' }, proposalPath: '/p.json' }) });
    expect(lines.join('')).toMatch(/Toolchain güncelleme: built; sonraki sürüm r5-20260924; imaj deckent\/worker:r5-20260924/);
    await expect(toolchainsCommand(['toolchains', 'rebuild'], { root: f.project })).rejects.toMatchObject({ code: 'CLI_USAGE' });
    await expect(toolchainsCommand(['toolchains', 'update', '--force'], { root: f.project })).rejects.toMatchObject({ code: 'CLI_USAGE' });
  });
});
