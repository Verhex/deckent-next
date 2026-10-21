import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { expect } from 'vitest';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { productResourcePath } from '#platform/index.js';
import { fixtureDockerRegistry } from './execution-registry.js';
import { DRIVER, type Step } from './pty-steps.js';

export const exec = promisify(execFile);
export const git = async (cwd: string, ...args: string[]) => (await exec('/usr/bin/git', ['-C', cwd, ...args])).stdout.trim();
export const TARGET = 'refs/heads/dogfood/adopted', SCOPE = 's';
export const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
export const attemptActions = ['execute', 'read-output', 'recover-output', 'prepare-integration', 'deliver-integration', 'evaluate', 'adopt-integration', 'rollback-integration'];
export const criterion = { id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } };
export const graph = (kind: string) => ({ schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind, dependencies: [], acceptanceCriteria: ['exit'] }], criterionDefinitions: [criterion] });

export async function queueProject(input: {
  roots: string[];
  prefix: string;
  workers: Readonly<Record<string, string>>;
  revision: string;
  config?: Record<string, unknown>;
  targetQueue?: Record<string, unknown>;
}) {
  const root = await mkdtemp(join(tmpdir(), input.prefix)); input.roots.push(root);
  const project = join(root, 'project'), target = join(root, 'target'), data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await git(project, 'init', '-q'); await git(project, 'config', 'user.email', 'live@example.invalid'); await git(project, 'config', 'user.name', 'Live');
  await writeFile(join(project, 'note.txt'), 'before\n'); await git(project, 'add', 'note.txt'); await git(project, 'commit', '-q', '-m', 'base');
  const base = await git(project, 'rev-parse', 'HEAD');
  await exec('/usr/bin/git', ['clone', '-q', project, target]);
  await git(target, 'config', 'user.email', 'target@example.invalid'); await git(target, 'config', 'user.name', 'Target');
  await git(target, 'branch', 'dogfood/adopted', base); await git(target, 'checkout', '-q', '--detach', base);
  const template = fixtureDockerRegistry(['x']).profiles[0]!;
  const parameters = { ...template.parameters, imageId: process.env.DECKENT_TEST_DOCKER_IMAGE! };
  const profiles = Object.entries(input.workers).map(([kind, script]) => ({ ...template, id: `fixture-${kind}`, parameters: { ...parameters, argv: ['node', '-e', script] } }));
  const registry = { ...fixtureDockerRegistry([]), profiles, kinds: Object.keys(input.workers).map(kind => ({ kind, profile: { id: `fixture-${kind}`, version: 1 } })) };
  const { argv: _argv, ...bounds } = parameters; void _argv;
  const options = { env: { HOME: join(root, 'home') } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, artifacts: { maxBytes: 16_777_216 },
    admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry },
    execution: { docker: { executable: '/usr/bin/docker', ...bounds }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 },
      // The installation's adoption bar (a `verify` Run on the exact candidate) is added to each Task's own criterion.
      adoption: { targets: [TARGET], verification: { kind: 'verify', required: true, criteria: [{ evaluator: criterion.evaluator, parameters: criterion.parameters }] } },
      workTargets: { schemaVersion: 1, targets: [{ id: 'n1', kind: 'git', path: target, baseRef: TARGET }] } },
    // Three enqueues land inside one collection window, so they form one FIFO prefix of one epoch.
    targetQueue: input.targetQueue ?? { batchWindowMs: 4000 },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
    cancellationRuntime: { scopeIds: [SCOPE], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 65536, responseMaxBytes: 1_048_576, maxConnections: 8, maxConcurrentRequests: 4, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 },
    ...input.config }));
  const opened = await openConfiguredAttemptStore(project, options);
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); opened.store.close();
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: input.revision, restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: [SCOPE], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: [SCOPE], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: attemptActions, scopes: [SCOPE], principals, resource: { kind: 'attempt', ids: 'all' } },
    { id: 'target', effect: 'allow', actions: ['use', 'adopt'], scopes: [SCOPE], principals, resource: { kind: 'work-target', ids: ['n1'] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: [SCOPE], principals, resource: { kind: 'scope', ids: [SCOPE] } },
  ] }), { mode: 0o600 });
  return { root, project, target, data, base, options, layout: opened.layout };
}

/** The shared PTY driver, except that a step whose text arrived together with the program's exit is met (the CLI prints its result and ends). */
export const CLI_DRIVER = DRIVER.replace('if time.time() > deadline or not read_for(0.1):', 'if time.time() > deadline or (not read_for(0.1) and wait.encode() not in out[since:]):');
/** The shipped CLI on its own controlling PTY (python `pty`), typing each step's keys once its text is shown. */
export async function cliInPty(project: string, env: NodeJS.ProcessEnv, args: readonly string[], steps: readonly Step[]) {
  const argv = [process.execPath, resolve('dist/composition/core/cli/internal/entry.js'), ...args];
  const { stdout } = await exec('python3', ['-c', CLI_DRIVER, JSON.stringify(argv), JSON.stringify(steps), 'tty'],
    { cwd: project, env: { ...process.env, ...env }, timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  const result = JSON.parse(stdout) as { status?: number | string; timeout?: string; output: string };
  if (result.timeout) throw new Error(`waited for ${JSON.stringify(result.timeout)}\n${result.output.slice(-6000)}`);
  expect(CLI_DRIVER).not.toBe(DRIVER);
  return { ...result, output: stripVTControlCharacters(result.output) };
}
