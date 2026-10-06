import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertWorkerImageVersionAvailable, prepareWorkerImageBuildContext, readWorkerImageSources, runWorkerImageBuild, type WorkerImageBuildRunner } from '#adapters/index.js';
import { parseVersionHistory, validateRecipe } from '../../../assets/worker-image/history.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const packageRoot = process.cwd();

describe.skipIf(process.platform !== 'linux')('worker image build context and bounded build run', () => {
  it('uses the installed builder shared guard before any effect, comparing numeric counters and ignoring unrelated tags', async context => {
    const parent = await mkdtemp(join(tmpdir(), 'deckent-worker-version-check-')); roots.push(parent);
    const bin = join(parent, 'bin'); await mkdir(bin);
    const log = join(parent, 'docker-calls.jsonl');
    const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const fakeDocker = (tags: string, fail = false) => writeFile(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> ${shellQuote(log)}
case "$*" in
  'context inspect --format {{json .Endpoints.docker.Host}}') printf '%s\\n' '"unix:///fixture-daemon"' ;;
  '--host unix:///fixture-daemon image ls deckent/worker --format {{.Tag}}')
    ${fail ? 'exit 1' : "printf '%s\\n' " + shellQuote(tags)} ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
    const input = { packageRoot, imageVersion: 'r5-20261003', timeoutMs: 5000, outputBytes: 4096,
      env: { PATH: bin, HOME: parent, SECRET_TOKEN: 'never-forward' } };
    await fakeDocker('r3-20260922\nr4-20260930\nlatest\nr4-malformed');
    // The fake docker must be executable where the test writes it. A noexec tmpdir (the verify container's hardened /tmp) is a missing
    // environment capability, not a product defect: assert the real refusal first, then report a typed not-run; never loosen the mount.
    const probePath = join(parent, 'exec-probe'); await writeFile(probePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const probe = spawnSync(probePath, [], { encoding: 'utf8' });
    if (probe.error && (probe.error as NodeJS.ErrnoException).code === 'EACCES') {
      await expect(assertWorkerImageVersionAvailable(input)).rejects.toMatchObject({ code: 'WORKER_IMAGE_COMMAND_FAILED' });
      context.skip('TEST_TMPDIR_NOEXEC: tmpdir is mounted noexec, so the fake docker cannot run; the product refusal (WORKER_IMAGE_COMMAND_FAILED) was asserted instead');
    }
    await rm(probePath);
    await expect(assertWorkerImageVersionAvailable(input)).resolves.toBeUndefined();
    let calls = (await readFile(log, 'utf8')).trim().split('\n');
    expect(calls).toEqual(['context inspect --format {{json .Endpoints.docker.Host}}',
      '--host unix:///fixture-daemon image ls deckent/worker --format {{.Tag}}']);
    await expect(assertWorkerImageVersionAvailable({ ...input, imageVersion: 'r4-20261003' })).rejects.toMatchObject({ code: 'WORKER_VERSION_COUNTER_TAKEN', detail: expect.stringContaining('r4-20260930') });
    await fakeDocker('r9-20260101\nr10-20251231\nr4-20260930');
    await expect(assertWorkerImageVersionAvailable(input)).rejects.toMatchObject({ code: 'WORKER_VERSION_COUNTER_TAKEN', detail: expect.stringContaining('r10-20251231') });
    await fakeDocker('');
    await expect(assertWorkerImageVersionAvailable(input)).resolves.toBeUndefined();
    await fakeDocker('', true);
    await expect(assertWorkerImageVersionAvailable(input)).rejects.toMatchObject({ code: 'WORKER_IMAGE_COMMAND_FAILED' });
    calls = (await readFile(log, 'utf8')).trim().split('\n');
    expect(calls).toHaveLength(10);
    expect(calls.every(args => args.startsWith('context inspect ') || args.startsWith('--host unix:///fixture-daemon image ls '))).toBe(true);
    expect((await readdir(parent)).sort()).toEqual(['bin', 'docker-calls.jsonl']);
  });
  it('retains timeout precedence and refuses arbitrary builder codes, with bounded sanitized diagnostics', async () => {
    const input = { packageRoot, imageVersion: 'r5-20261003', timeoutMs: 1_200_000, outputBytes: 4096, env: { PATH: '/usr/bin', SECRET_TOKEN: 'never' } };
    const seen: Record<string, unknown>[] = [];
    const runner: WorkerImageBuildRunner = async command => {
      seen.push(command as unknown as Record<string, unknown>);
      return { schemaVersion: 1, requestId: command.requestId, started: true, reason: 'timeout', exitCode: null, signal: 'SIGKILL',
        stdoutBase64: '', stderrBase64: Buffer.from('Error: WORKER_VERSION_COUNTER_TAKEN: old evidence').toString('base64'), stdoutTruncated: false, stderrTruncated: false, durationMs: 1 };
    };
    await expect(assertWorkerImageVersionAvailable(input, runner)).rejects.toMatchObject({ code: 'WORKER_IMAGE_VERSION_CHECK_TIMEOUT' });
    expect(seen[0]).toMatchObject({ timeoutMs: input.timeoutMs, env: { PATH: '/usr/bin' } });
    const unknown: WorkerImageBuildRunner = async command => ({ schemaVersion: 1, requestId: command.requestId, started: true, reason: 'exit', exitCode: 1, signal: null,
      stdoutBase64: '', stderrBase64: Buffer.from('Error: WORKER_NOT_A_REAL_CODE: token=fixture-secret\n    at private-stack').toString('base64'), stdoutTruncated: false, stderrTruncated: false, durationMs: 1 });
    await expect(assertWorkerImageVersionAvailable(input, unknown)).rejects.toMatchObject({ code: 'WORKER_IMAGE_VERSION_CHECK_FAILED', detail: expect.stringContaining('[REDACTED]') });
  });
  it('copies the shipped builder into a private exclusive context with the edited Dockerfile and recipe, leaving package bytes untouched', async () => {
    const sources = await readWorkerImageSources(packageRoot);
    const before = await readFile(join(packageRoot, 'assets/worker-image/Dockerfile'), 'utf8');
    const recipe = { ...(sources.recipe as Record<string, unknown>), imageVersion: 'r99-20260923', previousVersion: (sources.recipe as { imageVersion: string }).imageVersion };
    const dockerfile = sources.dockerfile.replace(/^# version r/m, `# version r99-20260923 | 2026-09-23 | base node:24-trixie-slim | supersedes ${(sources.recipe as { imageVersion: string }).imageVersion} | test\n# version r`);
    const parent = await mkdtemp(join(tmpdir(), 'deckent-worker-image-')); roots.push(parent);
    const prepared = await prepareWorkerImageBuildContext({ packageRoot, parent: join(parent, 'builds'), imageVersion: 'r99-20260923', dockerfile, recipe });
    expect((await readdir(prepared.context)).sort()).toEqual(['Dockerfile', 'build.mjs', 'history.mjs', 'inspect.mjs', 'install.mjs', 'recipe.json']);
    expect((await stat(prepared.context)).mode & 0o077).toBe(0);
    const copied = validateRecipe(JSON.parse(await readFile(join(prepared.context, 'recipe.json'), 'utf8')));
    expect(parseVersionHistory(await readFile(join(prepared.context, 'Dockerfile'), 'utf8'), copied)[0]).toMatchObject({ id: 'r99-20260923', supersedes: copied.previousVersion });
    expect(await readFile(join(packageRoot, 'assets/worker-image/Dockerfile'), 'utf8')).toBe(before);
    await expect(prepareWorkerImageBuildContext({ packageRoot, parent: join(parent, 'builds'), imageVersion: 'r99-20260923', dockerfile, recipe })).rejects.toMatchObject({ code: 'WORKER_IMAGE_CONTEXT_EXISTS' });
    await expect(prepareWorkerImageBuildContext({ packageRoot: join(parent, 'missing'), parent: join(parent, 'builds'), imageVersion: 'r98-20260923', dockerfile, recipe })).rejects.toMatchObject({ code: 'WORKER_IMAGE_SOURCE_INVALID' });
  });
  it('runs the copied builder through the bounded runner with an environment allowlist and trusts only the written receipt', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'deckent-worker-image-run-')); roots.push(parent);
    const sources = await readWorkerImageSources(packageRoot);
    const prepared = await prepareWorkerImageBuildContext({ packageRoot, parent: join(parent, 'builds'), imageVersion: 'r99-20260923', dockerfile: sources.dockerfile, recipe: sources.recipe });
    const receiptPath = join(parent, 'receipt.json'); const seen: Record<string, unknown>[] = [];
    const evidence = (over: Record<string, unknown>) => ({ schemaVersion: 1, requestId: 'x', started: true, reason: 'exit', exitCode: 0, signal: null, stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1, ...over });
    const runner: WorkerImageBuildRunner = async command => { seen.push(command as unknown as Record<string, unknown>); await writeFile(receiptPath, JSON.stringify({ schemaVersion: 2, imageId: 'sha256:' + 'c'.repeat(64) })); return evidence({ requestId: command.requestId }) as never; };
    const built = await runWorkerImageBuild({ context: prepared.context, receiptPath, timeoutMs: 5000, outputBytes: 4096, env: { PATH: '/usr/bin', HOME: '/tmp/h', SECRET_TOKEN: 'never', DOCKER_HOST: 'unix:///x' } }, runner);
    expect(built.receipt).toMatchObject({ imageId: 'sha256:' + 'c'.repeat(64) });
    expect(seen[0]).toMatchObject({ executable: process.execPath, args: [join(prepared.context, 'build.mjs'), receiptPath], cwd: prepared.context, env: { PATH: '/usr/bin', HOME: '/tmp/h', DOCKER_HOST: 'unix:///x' } });
    expect((seen[0]!.env as Record<string, string>).SECRET_TOKEN).toBeUndefined();
    const failing: WorkerImageBuildRunner = async command => evidence({ requestId: command.requestId, exitCode: 1 }) as never;
    await expect(runWorkerImageBuild({ context: prepared.context, receiptPath: join(parent, 'r2.json'), timeoutMs: 5000, outputBytes: 4096 }, failing)).rejects.toMatchObject({ code: 'WORKER_IMAGE_BUILD_FAILED' });
    const timing: WorkerImageBuildRunner = async command => evidence({ requestId: command.requestId, reason: 'timeout', exitCode: null, signal: 'SIGTERM' }) as never;
    await expect(runWorkerImageBuild({ context: prepared.context, receiptPath: join(parent, 'r3.json'), timeoutMs: 5000, outputBytes: 4096 }, timing)).rejects.toMatchObject({ code: 'WORKER_IMAGE_BUILD_TIMEOUT' });
    const silent: WorkerImageBuildRunner = async command => evidence({ requestId: command.requestId }) as never;
    await expect(runWorkerImageBuild({ context: prepared.context, receiptPath: join(parent, 'r4.json'), timeoutMs: 5000, outputBytes: 4096 }, silent)).rejects.toMatchObject({ code: 'WORKER_IMAGE_RECEIPT_MISSING' });
  });
});
