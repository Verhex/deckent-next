import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { scanWorkerTree, workerTreeViews } from '#adapters/index.js';
import { enforceAdmittedWorkerTreeGate, WorkerTreeScanAdmission, type AttemptStore, type WorkerTreeScan } from '#engine/index.js';
import { DECKENT_VERSION, pathsShareTree } from '#platform/index.js';
import { CORE_SCHEMA } from '#platform/core/config/index.js';

// R2 (owner/lead D3a 2026-10-18) measurement lane: `VITEST_MAX_FORKS=1 npx vitest run --config tests/perf/vitest.config.ts tests/perf/secret-gate-admission.perf.ts`.
// Workload (measurement inputs, not product config): DECKENT_PERF_GATE_DISPATCHES (13), DECKENT_PERF_GATE_FILES (14060), DECKENT_PERF_GATE_MIB (150) —
// the N1 pilot's node_modules shape. Compares 13 concurrent full scans (alpha.46 path) with 13 concurrent admitted gates on the default bounds.
const dispatches = Number(process.env['DECKENT_PERF_GATE_DISPATCHES'] ?? 13), fileCount = Number(process.env['DECKENT_PERF_GATE_FILES'] ?? 14_060);
const totalBytes = Number(process.env['DECKENT_PERF_GATE_MIB'] ?? 150) * 1024 * 1024;
const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('13 concurrent dispatches over a 150 MB / 14k-file dependency bind: one shared scan, no time refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-admission-perf-')); roots.push(root);
  const checkout = join(root, 'checkout'), deps = join(root, 'deps'), cache = join(root, 'cache'), sourceRoot = join(root, 'source');
  await mkdir(checkout, { recursive: true }); await mkdir(cache); await mkdir(sourceRoot);
  await writeFile(join(checkout, 'README.md'), '# project\n'); await writeFile(join(checkout, 'index.ts'), 'export const answer = 42;\n');
  await mkdir(deps); await writeFile(join(deps, '.package-lock.json'), '{"lockfileVersion":3}\n');
  const line = 'export function value(input) { return typeof input === "string" ? input.trim() : String(input); }\n', perFile = Math.floor(totalBytes / fileCount);
  const body = line.repeat(Math.ceil(perFile / line.length)).slice(0, perFile);
  for (let index = 0; index < fileCount; index++) {
    const directory = join(deps, `pkg-${Math.floor(index / 100)}`, 'dist'); if (index % 100 === 0) await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `file-${index}.js`), body);
  }
  // The product defaults of `execution.secretGate` (bounds, admission), read from the config schema itself.
  const docker = { executable: 'docker', imageId: `sha256:${'a'.repeat(64)}`, memoryBytes: 1, pids: 1, cpus: 1, logMaxSizeKiB: 1, logMaxFiles: 1, tmpBytes: 1, deadlineMs: 1, controlTimeoutMs: 1, outputBytes: 1 };
  const settings = (CORE_SCHEMA.parse({ execution: { docker, git: { gitExecutable: 'git', timeoutMs: 1 } } }) as { execution: { secretGate: { maxConcurrentScans: number; admissionTimeoutMs: number; maxTimeRefusals: number; timeoutMs: number;
    allowPatternPaths: string[]; acknowledgedDenyPaths: string[]; maxFiles: number; maxFileBytes: number; maxTotalBytes: number } } }).execution.secretGate;
  const mounts = [{ source: deps, target: '/deps', dependencyTree: { lockfile: '.package-lock.json' } }];
  const views = workerTreeViews(checkout, mounts, { inputs: [], handoffInputs: [] }, ['node', 'index.js']);
  const options = { ...settings, cacheDirectory: cache, checkoutRoot: sourceRoot };
  // Steady state: the dependency pattern cache already holds this tree (the alpha.46 class still reads and hashes every byte per dispatch).
  expect((await scanWorkerTree(views, options)).status).toBe('clean');

  const before = performance.now();
  const old = await Promise.all(Array.from({ length: dispatches }, () => scanWorkerTree(views, options)));
  const oldMs = Math.round(performance.now() - before), oldTime = old.filter(scan => scan.status === 'incomplete' && scan.limit === 'time').length;

  const admission = new WorkerTreeScanAdmission(), journal = {} as AttemptStore, scans: string[][] = [];
  const started = performance.now();
  const outcomes = await Promise.all(Array.from({ length: dispatches }, (_, index) => enforceAdmittedWorkerTreeGate({ views, settings, fingerprint: [options, DECKENT_VERSION],
    scan: async (part): Promise<WorkerTreeScan> => { scans.push(part.map(view => view.label)); return scanWorkerTree(part, options); },
    lockfile: path => readFile(path), sharesTree: pathsShareTree,
    refusals: () => ({ read: async () => ({ kind: 'absent' as const }), write: async () => undefined, remove: async () => undefined }), admission },
  { identity: { scopeId: 's', runId: 'r', taskId: `t${index}`, attemptId: `a${index}`, generation: 1, layoutRevision: 'l' }, principal: { issuer: 'i', subject: 'p' }, policyRevision: 'r', now: Date.now, journal },
  async () => undefined, async () => undefined).then(() => 'passed', (error: { code?: string }) => error.code ?? 'error')));
  const newMs = Math.round(performance.now() - started), statistics = admission.statistics();
  console.info(JSON.stringify({ measurement: 'R2 secret-gate admission', version: DECKENT_VERSION, node: process.version, platform: process.platform, cpus: cpus().length,
    uvThreadpool: process.env['UV_THREADPOOL_SIZE'] ?? 'default(4)', workload: { dispatches, files: fileCount, bytes: totalBytes, timeoutMs: settings.timeoutMs, maxConcurrentScans: settings.maxConcurrentScans },
    alpha46: { elapsedMs: oldMs, timeRefusals: oldTime, statuses: old.map(scan => scan.status) }, admitted: { elapsedMs: newMs, outcomes, dependencyScans: scans.filter(part => part.includes('/deps')).length, statistics } }));
  expect(outcomes).toEqual(Array(dispatches).fill('passed'));
  expect(scans.filter(part => part.includes('/deps'))).toHaveLength(1); expect(statistics).toMatchObject({ started: 1, joined: dispatches - 1 });
}, 900_000);
