import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareWorkerImageBuildContext, readWorkerImageSources, runWorkerImageBuild, type WorkerImageBuildRunner } from '#adapters/index.js';
import { parseVersionHistory, validateRecipe } from '../../../assets/worker-image/history.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const packageRoot = process.cwd();

describe.skipIf(process.platform !== 'linux')('worker image build context and bounded build run', () => {
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
