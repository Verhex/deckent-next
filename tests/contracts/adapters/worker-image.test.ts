import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readWorkerImageHeldVersion, prepareWorkerImageBuildContext, readWorkerImageSources, resolveWorkerBuildPlan, runWorkerImageBuild, workerImageEstimate, type WorkerImageBuildRunner } from '#adapters/index.js';
import { layeredWorkerRecipeSchema } from '#engine/index.js';
import { parseVersionHistory, validateRecipe, assertVersionAdvances, heldVersion, adoptionProvenance } from '../../../assets/worker-image/history.mjs';
import { baseDockerfile, imageDockerfile } from '../../../assets/worker-image/layers.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const packageRoot = process.cwd();

it('IMGOPT: the image card names the measured base plus exactly the selected CLIs, every recipe CLI is measured, an unmeasured one is not guessed', async () => {
  const ids = layeredWorkerRecipeSchema.parse((await readWorkerImageSources(packageRoot)).recipe).providers.map(provider => provider.id);
  const all = workerImageEstimate(ids), single = ids.map(id => workerImageEstimate([id]));
  expect(single.every(row => row.sizeGigabytes! > 0 && row.sizeGigabytes! < all.sizeGigabytes! && row.referenceMs! < all.referenceMs!)).toBe(true);
  expect(workerImageEstimate(['unmeasured-cli'])).toEqual({ sizeGigabytes: null, referenceMs: null });
});

it('v3 resolves at plan time from the install registry, isolates CLI cache inputs, guards lineage and refuses unknown or credentialed sources', async () => {
  const recipe = layeredWorkerRecipeSchema.parse((await readWorkerImageSources(packageRoot)).recipe);
  const endpoints: string[] = [];
  let version = '0.156.0';
  const input = { selected: ['codex', 'claude'], npmRegistry: 'https://mirror.example.invalid/npm', plannedAt: '2026-10-25T12:00:00.000Z',
    lookup: async (request: { endpoint: string; package: string }) => { endpoints.push(request.endpoint); return { version: request.package === '@openai/codex' ? version : '2.1.278', source: 'fixture', observedAt: '2026-10-25T12:00:00.000Z' }; } };
  const first = await resolveWorkerBuildPlan(recipe, 'r32-20261025', 123456, input);
  const meta = { recipeSha256: 'a'.repeat(64), sourceRevision: 'fixture' };
  version = '0.157.0';
  const next = await resolveWorkerBuildPlan(recipe, 'r33-20261025', 123456, { ...input, previousRefreshKey: first.refreshKey });
  const run = (plan: typeof first, id: string) => imageDockerfile(recipe, plan, [id], meta).split('\n').find((line: string) => line.startsWith('RUN '));
  expect(run(first, 'claude')).toBe(run(next, 'claude'));
  expect(run(first, 'codex')).not.toBe(run(next, 'codex'));
  expect(run(first, 'codex')).toContain('0.156.0');
  expect(run(first, 'codex')).toContain('https://mirror.example.invalid/npm');
  expect(endpoints).toEqual(Array(4).fill(input.npmRegistry));
  expect(baseDockerfile(recipe, first)).toBe(baseDockerfile(recipe, next));
  expect(first.base.pull).toBe(true); expect(next.base.pull).toBe(false);
  expect(imageDockerfile(recipe, first, ['codex'], meta)).not.toMatch(/latest|COPY.*history|COPY.*recipe/u);
  expect(imageDockerfile(recipe, first, ['codex'], { ...meta, secret: true })).toContain('RUN --mount=type=secret,id=worker-npmrc,required=true');
  expect(heldVersion(['r31-20261024', 'r32-20261025-claude', 'latest'])).toBe('r32-20261025');
  expect(() => assertVersionAdvances('r32-20261025', ['r32-20261025-claude'])).toThrow('WORKER_VERSION_COUNTER_TAKEN');
  expect(() => assertVersionAdvances('r33-20261025', ['r32-20261025-claude'])).not.toThrow();
  const lineage = { recipes: [{ sha256: 'a'.repeat(64), version: 'r32-20261025', providers: ['codex'] }] };
  const labels = { 'dev.deckent.worker.recipe.sha256': 'a'.repeat(64), 'org.opencontainers.image.version': 'r32-20261025', 'dev.deckent.worker.provider': 'codex' };
  expect(adoptionProvenance(labels, lineage, ['codex'])).toBe('adopted-label-matched');
  expect(adoptionProvenance({ ...labels, 'org.opencontainers.image.version': 'r33-20261025' }, lineage, ['codex'])).toBe('adopted-lineage-unknown');
  expect(adoptionProvenance({ ...labels, 'dev.deckent.worker.recipe.sha256': 'b'.repeat(64) }, lineage, ['codex'])).toBe('adopted-lineage-unknown');
  expect(adoptionProvenance({ ...labels, 'dev.deckent.worker.provider': 'codex,codex' }, lineage, ['codex'])).toBe('adopted-lineage-unknown');
  await expect(resolveWorkerBuildPlan(recipe, 'r32-20261025', 123456, { ...input, npmRegistry: 'https://user:fixture@mirror.example.invalid' }))
    .rejects.toMatchObject({ code: 'WORKER_IMAGE_SOURCE_CREDENTIALS_REFUSED' });
  await expect(resolveWorkerBuildPlan(recipe, 'r32-20261025', 123456, { ...input, npmRegistry: 'http://mirror.example.invalid' }))
    .rejects.toMatchObject({ code: 'WORKER_IMAGE_SOURCE_INSECURE' });
  await expect(resolveWorkerBuildPlan(recipe, 'r32-20261025', 123456, { ...input, lookup: async () => { throw new Error('offline'); } }))
    .rejects.toMatchObject({ code: 'WORKER_IMAGE_VERSIONS_UNRESOLVABLE' });
  await expect(resolveWorkerBuildPlan(recipe, 'r32-20261025', 123456, { ...input, lookup: async () => ({ version: 'latest', source: 'fixture', observedAt: input.plannedAt }) }))
    .rejects.toMatchObject({ code: 'WORKER_IMAGE_VERSIONS_UNRESOLVABLE' });
});

describe.skipIf(process.platform !== 'linux')('worker image build context and bounded build run', () => {
  it('reads the highest revision the daemon holds through the installed builder before any effect, comparing numeric counters and ignoring unrelated tags', async context => {
    const parent = await mkdtemp(join(tmpdir(), 'deckent-worker-version-check-')); roots.push(parent);
    const bin = join(parent, 'bin'); await mkdir(bin);
    const log = join(parent, 'docker-calls.jsonl');
    const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const fakeDocker = (tags: string, fail = false) => writeFile(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> ${shellQuote(log)}
case "$*" in
  'context inspect --format {{json .Endpoints.docker.Host}}') printf '%s\\n' '"unix:///fixture-daemon"' ;;
  '--host unix:///fixture-daemon image ls deckent/worker-base --format {{.Tag}}') exit 0 ;;
  '--host unix:///fixture-daemon image ls deckent/worker --format {{.Tag}}')
    ${fail ? 'exit 1' : "printf '%s\\n' " + shellQuote(tags)} ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
    const input = { packageRoot, timeoutMs: 5000, outputBytes: 4096,
      env: { PATH: bin, HOME: parent, SECRET_TOKEN: 'never-forward' } };
    await fakeDocker('r3-20260922\nr4-20260930\nlatest\nr4-malformed');
    // The fake docker must be executable where the test writes it. A noexec tmpdir (the verify container's hardened /tmp) is a missing
    // environment capability, not a product defect: assert the real refusal first, then report a typed not-run; never loosen the mount.
    const probePath = join(parent, 'exec-probe'); await writeFile(probePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const probe = spawnSync(probePath, [], { encoding: 'utf8' });
    if (probe.error && (probe.error as NodeJS.ErrnoException).code === 'EACCES') {
      await expect(readWorkerImageHeldVersion(input)).rejects.toMatchObject({ code: 'WORKER_IMAGE_COMMAND_FAILED' });
      context.skip('TEST_TMPDIR_NOEXEC: tmpdir is mounted noexec, so the fake docker cannot run; the product refusal (WORKER_IMAGE_COMMAND_FAILED) was asserted instead');
    }
    await rm(probePath);
    await expect(readWorkerImageHeldVersion(input)).resolves.toBe('r4-20260930');
    let calls = (await readFile(log, 'utf8')).trim().split('\n');
    expect(calls).toEqual(['context inspect --format {{json .Endpoints.docker.Host}}',
      '--host unix:///fixture-daemon image ls deckent/worker --format {{.Tag}}',
      '--host unix:///fixture-daemon image ls deckent/worker-base --format {{.Tag}}']);
    await fakeDocker('r9-20260101\nr10-20251231\nr4-20260930');
    await expect(readWorkerImageHeldVersion(input)).resolves.toBe('r10-20251231');
    await fakeDocker('latest');
    await expect(readWorkerImageHeldVersion(input)).resolves.toBeNull();
    await fakeDocker('', true);
    await expect(readWorkerImageHeldVersion(input)).rejects.toMatchObject({ code: 'WORKER_IMAGE_COMMAND_FAILED' });
    calls = (await readFile(log, 'utf8')).trim().split('\n');
    expect(calls).toHaveLength(11);
    expect(calls.every(args => args.startsWith('context inspect ') || args.startsWith('--host unix:///fixture-daemon image ls '))).toBe(true);
    expect((await readdir(parent)).sort()).toEqual(['bin', 'docker-calls.jsonl']);
  });
  it('retains timeout precedence and refuses arbitrary builder codes, with bounded sanitized diagnostics', async () => {
    const input = { packageRoot, timeoutMs: 1_200_000, outputBytes: 4096, env: { PATH: '/usr/bin', SECRET_TOKEN: 'never' } };
    const seen: Record<string, unknown>[] = [];
    const runner: WorkerImageBuildRunner = async command => {
      seen.push(command as unknown as Record<string, unknown>);
      return { schemaVersion: 1, requestId: command.requestId, started: true, reason: 'timeout', exitCode: null, signal: 'SIGKILL',
        stdoutBase64: '', stderrBase64: Buffer.from('Error: WORKER_VERSION_COUNTER_TAKEN: old evidence').toString('base64'), stdoutTruncated: false, stderrTruncated: false, durationMs: 1 };
    };
    await expect(readWorkerImageHeldVersion(input, runner)).rejects.toMatchObject({ code: 'WORKER_IMAGE_VERSION_CHECK_TIMEOUT' });
    expect(seen[0]).toMatchObject({ timeoutMs: input.timeoutMs, env: { PATH: '/usr/bin' } });
    const unknown: WorkerImageBuildRunner = async command => ({ schemaVersion: 1, requestId: command.requestId, started: true, reason: 'exit', exitCode: 1, signal: null,
      stdoutBase64: '', stderrBase64: Buffer.from('Error: WORKER_NOT_A_REAL_CODE: token=fixture-secret\n    at private-stack').toString('base64'), stdoutTruncated: false, stderrTruncated: false, durationMs: 1 });
    await expect(readWorkerImageHeldVersion(input, unknown)).rejects.toMatchObject({ code: 'WORKER_IMAGE_VERSION_CHECK_FAILED', detail: expect.stringContaining('[REDACTED]') });
    // A successful exit is trusted only with exactly one well-formed answer; anything else is a failed check, never a guessed floor.
    for (const stdout of ['', 'r16-20261016', '{"heldVersion":"latest"}', '{"heldVersion":"r16-20261016","extra":1}']) {
      const answer: WorkerImageBuildRunner = async command => ({ schemaVersion: 1, requestId: command.requestId, started: true, reason: 'exit', exitCode: 0, signal: null,
        stdoutBase64: Buffer.from(stdout).toString('base64'), stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1 });
      await expect(readWorkerImageHeldVersion(input, answer)).rejects.toMatchObject({ code: 'WORKER_IMAGE_VERSION_CHECK_FAILED' });
    }
  });
  // F4 (TEMIZ-KURULUM-2026-10-16): `npm run worker:image` on a taken tag printed a raw stack. A known builder refusal is one typed line
  // (the same `Error: WORKER_…` line the adapter maps to its localized EN/TR error), exit 1, no stack and no image effect.
  it('reports a known builder refusal as one typed line without a stack trace', async context => {
    const parent = await mkdtemp(join(tmpdir(), 'deckent-worker-builder-refusal-')); roots.push(parent);
    const bin = join(parent, 'bin'); await mkdir(bin); const log = join(parent, 'docker-calls.log');
    await writeFile(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$*" in
  'context inspect --format {{json .Endpoints.docker.Host}}') printf '%s\\n' '"unix:///fixture-daemon"' ;;
  '--host unix:///fixture-daemon info --format {{.ID}}') printf '%s\\n' 'fixture-daemon-id' ;;
  '--host unix:///fixture-daemon image inspect deckent/worker-base:'*' --format {{.Id}}') printf '%s\\n' 'sha256:${'c'.repeat(64)}' ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
    if ((spawnSync(join(bin, 'docker'), ['probe'], { encoding: 'utf8' }).error as NodeJS.ErrnoException | undefined)?.code === 'EACCES') context.skip('TEST_TMPDIR_NOEXEC: the fake docker cannot run here');
    const sources = await readWorkerImageSources(packageRoot);
    const prepared = await prepareWorkerImageBuildContext({ packageRoot, parent: join(parent, 'builds'), imageVersion: 'r4-20260930', dockerfile: sources.dockerfile, recipe: sources.recipe, plan: { schemaVersion: 1, imageVersion: 'r4-20260930', previousVersion: 'r3-20260922', base: { image: 'node:24-trixie-slim', pull: false }, buildTimeoutMs: 5000, images: [['codex']], providers: { codex: { kind: 'npm', package: '@openai/codex', version: '0.156.0' } }, npmRegistry: 'https://registry.npmjs.org', proxy: null, refreshKey: '1' } });
    const builder = (args: string[]) => spawnSync(process.execPath, [join(prepared.context, 'build.mjs'), ...args], { encoding: 'utf8', env: { PATH: bin, HOME: parent } });
    for (const [args, code] of [[[join(parent, 'receipt.json')], 'WORKER_VERSION_TAKEN'], [['relative.json'], 'WORKER_RECEIPT_INVALID']] as const) {
      const result = builder([...args]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(new RegExp(`^Error: ${code}: [^\n]+\n$`));
      expect(result.stderr).not.toMatch(/\n\s+at |build\.mjs:\d+/);
    }
    expect((await readFile(log, 'utf8')).split('\n').some(line => / (build|tag|rmi|run) /.test(line))).toBe(false);
    expect((await readdir(parent)).sort()).toEqual(['bin', 'builds', 'docker-calls.log']);
    // IMGOPT: a Docker without buildx (Ubuntu docker.io) keeps the legacy builder for the background path; only the credentialed mirror
    // path needs BuildKit's secret mount, and it is refused before any build call.
    await writeFile(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$*" in
  'context inspect --format {{json .Endpoints.docker.Host}}') printf '%s\\n' '"unix:///fixture-daemon"' ;;
  '--host unix:///fixture-daemon info --format {{.ID}}') printf '%s\\n' 'fixture-daemon-id' ;;
  '--host unix:///fixture-daemon image inspect '*|'--host unix:///fixture-daemon buildx version') exit 1 ;;
  '--host unix:///fixture-daemon image ls '*) exit 0 ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
    const npmrc = join(parent, 'npmrc'), receipts = join(parent, 'receipts'); await writeFile(npmrc, '//registry.invalid/:_authToken=fixture\n', { mode: 0o600 }); await mkdir(receipts, { mode: 0o700 });
    const legacy = builder([join(receipts, 'r4-20260930.json'), '--npmrc-secret', npmrc]);
    expect(legacy.status).toBe(1); expect(legacy.stderr).toMatch(/^Error: WORKER_IMAGE_BUILDKIT_REQUIRED: [^\n]+\n$/);
    expect((await readFile(log, 'utf8')).split('\n').some(line => / build /.test(line))).toBe(false);
  });
  it('copies the shipped builder into a private exclusive context with the edited Dockerfile and recipe, leaving package bytes untouched', async () => {
    const sources = await readWorkerImageSources(packageRoot);
    const before = await readFile(join(packageRoot, 'assets/worker-image/history.log'), 'utf8');
    const recipe = { ...(sources.recipe as Record<string, unknown>), imageVersion: 'r99-20260923', previousVersion: (sources.recipe as { imageVersion: string }).imageVersion };
    const dockerfile = sources.dockerfile.replace(/^# version r/m, `# version r99-20260923 | 2026-09-23 | base node:24-trixie-slim | supersedes ${(sources.recipe as { imageVersion: string }).imageVersion} | test\n# version r`);
    const parent = await mkdtemp(join(tmpdir(), 'deckent-worker-image-')); roots.push(parent);
    const prepared = await prepareWorkerImageBuildContext({ packageRoot, parent: join(parent, 'builds'), imageVersion: 'r99-20260923', dockerfile, recipe });
    expect((await readdir(prepared.context)).sort()).toEqual(['build.mjs', 'history.log', 'history.mjs', 'inspect.mjs', 'install.mjs', 'layers.mjs', 'lineage.json', 'lineage.lock.json', 'receipts.mjs', 'recipe.json', 'recover.mjs']);
    expect((await stat(prepared.context)).mode & 0o077).toBe(0);
    const copied = validateRecipe(JSON.parse(await readFile(join(prepared.context, 'recipe.json'), 'utf8')));
    expect(parseVersionHistory(await readFile(join(prepared.context, 'history.log'), 'utf8'), copied)[0]).toMatchObject({ id: 'r99-20260923', supersedes: copied.previousVersion });
    expect(await readFile(join(packageRoot, 'assets/worker-image/history.log'), 'utf8')).toBe(before);
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

it('canonical tags and retained adoption/failed/archive history keep one daemon counter; unsafe or incomplete receipts refuse', async () => {
  const { retainedWorkerHistory } = await import('../../../assets/worker-image/receipts.mjs');
  const { imageTag } = await import('../../../assets/worker-image/layers.mjs');
  const { symlink } = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'worker-history-')); roots.push(home);
  const archive = join(home, 'archive'); await mkdir(archive);
  const receipt = (n: number, daemonId = 'daemon') => ({ schemaVersion: 3, imageVersion: `r${n}-20261026`, daemonId, history: [{ id: 'r31-20261024' }] });
  await writeFile(join(home, 'adopted-1.json'), JSON.stringify(receipt(32)));
  await writeFile(join(home, 'r33-20261026.json.failed-123'), JSON.stringify(receipt(33)));
  await writeFile(join(archive, 'retained.json'), JSON.stringify(receipt(34)));
  await writeFile(join(home, 'foreign.json'), JSON.stringify(receipt(90, 'foreign')));
  expect(imageTag('deckent/worker', 'r32-20261026', ['codex'])).toBe('deckent/worker:r32-codex');
  expect(imageTag('deckent/worker-base', 'r32-20261026')).toBe('deckent/worker-base:r32');
  expect(heldVersion(['r32-claude', 'r7', 'r31-20261024-codex'])).toBe('r32-00000000');
  expect(() => assertVersionAdvances('r32-20261026', ['r32-claude'])).toThrow('WORKER_VERSION_COUNTER_TAKEN');
  const bounds = { files: 16, bytes: 4096 }, versions = retainedWorkerHistory(home, 'daemon', bounds);
  expect(versions).toContain('r34-20261026'); expect(versions).not.toContain('r90-20261026');
  expect(() => assertVersionAdvances('r34-20261026', versions)).toThrow('WORKER_VERSION_COUNTER_TAKEN');
  expect(() => retainedWorkerHistory(home, 'daemon', { ...bounds, files: 1 })).toThrow('WORKER_HISTORY_IDS');
  await symlink(join(home, 'adopted-1.json'), join(home, 'unsafe.json'));
  expect(() => retainedWorkerHistory(home, 'daemon', bounds)).toThrow('WORKER_HISTORY_IDS');
});

it('U6-S4 choices require shipped lineage, fresh no-network flags and stable daemon custody before ready adoption is offered', async () => {
  const { inspectWorkerImageChoices, readWorkerImageSources } = await import('#adapters/core/worker-image/index.js');
  const { createHash } = await import('node:crypto');
  const { recipe, directory } = await readWorkerImageSources(process.cwd());
  const lineage = JSON.parse(await readFile(join(directory, 'lineage.json'), 'utf8'));
  const latest = lineage.recipes.find((row: { sha256: string }) => row.sha256 === createHash('sha256').update(JSON.stringify(recipe, null, 2) + '\n').digest('hex'));
  const provider = latest.providers[0], image = `sha256:${'a'.repeat(64)}`, unknown = `sha256:${'b'.repeat(64)}`;
  const home = await mkdtemp(join(tmpdir(), 'worker-choices-')); roots.push(home);
  const calls: string[][] = []; let daemonReads = 0, changed = false, flags = true, probeOwner = '';
  const runner: WorkerImageBuildRunner = async command => {
    const args = [...command.args]; calls.push(args);
    expect(command.env['TOKEN']).toBeUndefined(); expect(command.env['HTTPS_PROXY']).toBeUndefined();
    let output: unknown = '';
    if (args[0] === 'context') output = 'unix:///fixture';
    else if (args.includes('info')) output = changed && ++daemonReads % 2 === 0 ? 'changed-daemon' : 'daemon';
    else if (args.includes('ls')) output = [{ Repository: (recipe as { repository: string }).repository, Tag: 'unverified', ID: unknown }, { Repository: (recipe as { repository: string }).repository, Tag: `r32-${provider}`, ID: image }].map(row => JSON.stringify(row)).join('\n');
    else if (args.includes('inspect')) output = [{ Id: args.at(-1), Config: { Labels: args.at(-1) === unknown ? {} : { 'dev.deckent.worker.provider': provider, 'dev.deckent.worker.recipe.sha256': latest.sha256, 'org.opencontainers.image.version': latest.version } } }];
    else if (args.includes('ps')) { expect(args).toContain(`label=${probeOwner}`); output = flags ? '' : 'c'.repeat(64); }
    else if (args.includes('rm')) { expect(args).toEqual(['--host', 'unix:///fixture', 'rm', '--force', 'c'.repeat(64)]); }
    else if (args.includes('run')) {
      probeOwner = args[args.indexOf('--label') + 1]!;
      expect(args).toEqual(expect.arrayContaining(['--network=none', '--read-only', '--pull=never', '--cap-drop=ALL', '--security-opt=no-new-privileges']));
      expect(args).toContain(provider); output = { providers: [{ id: provider, requiredFlagsPresent: flags }] };
    }
    const text = typeof output === 'string' && args[0] !== 'context' ? output : JSON.stringify(output);
    return { schemaVersion: 1 as const, requestId: command.requestId, started: true, reason: 'exit' as const, exitCode: 0, signal: null,
      stdoutBase64: Buffer.from(text).toString('base64'), stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1 };
  };
  const input = { packageRoot: process.cwd(), home, executable: '/fixture/docker', provider, env: { PATH: '/fixture', TOKEN: 'fixture-secret', HTTPS_PROXY: 'http://fixture' } };
  expect(await inspectWorkerImageChoices({ ...input, executable: null }, runner)).toEqual([]); expect(calls).toEqual([]);
  expect(await inspectWorkerImageChoices(input, runner)).toEqual([{ imageId: image, tag: `${(recipe as { repository: string }).repository}:r32-${provider}`, ready: true }, { imageId: unknown, tag: `${(recipe as { repository: string }).repository}:unverified`, ready: false }]);
  expect(calls.filter(args => args.includes('run'))).toHaveLength(1);
  flags = false; expect((await inspectWorkerImageChoices(input, runner))[1]?.ready).toBe(false);
  expect(calls.some(args => args.includes('rm'))).toBe(true);
  changed = true; daemonReads = 0;
  await expect(inspectWorkerImageChoices(input, runner)).rejects.toMatchObject({ code: 'WORKER_DAEMON_CHANGED' });
});

it('worker receipt timing is optional telemetry: measured totals are exposed and invalid timing never invalidates a receipt', async () => {
  const { readNewestWorkerReceipt } = await import('#adapters/core/worker-image/index.js');
  const home = await mkdtemp(join(tmpdir(), 'worker-timing-')); roots.push(home); await mkdir(join(home, 'receipts'));
  const receipt = { schemaVersion: 2, imageId: `sha256:${'a'.repeat(64)}`, imageVersion: 'r31-20261024', measuredAt: '2026-10-26T00:00:00.000Z' };
  const path = join(home, 'receipts/adopted-1.json');
  await writeFile(path, JSON.stringify({ ...receipt, timings: { totalMs: 1234 } }));
  expect(await readNewestWorkerReceipt(home)).toMatchObject({ durationMs: 1234 });
  await writeFile(path, JSON.stringify({ ...receipt, timings: { totalMs: -1 } }));
  expect(await readNewestWorkerReceipt(home)).toEqual({ imageId: receipt.imageId, imageVersion: receipt.imageVersion });
});
