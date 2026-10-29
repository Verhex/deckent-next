import * as processes from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { beuserBindingSchema, beuserEvaluatorPrincipalRef, verifiedPrincipalSchema } from '#domain/index.js';
import { pinBeuserLimits, pinBeuserWalkerSummary, type BeuserContext } from '#engine/core/beuser-contract/index.js';
import { BeuserController, walkBeuser } from '#engine/core/beuser/index.js';
import { BeuserRealmApplication, type BeuserRealmCustody, type BeuserRealmLease } from '#engine/core/beuser-realm/index.js';
import { BEUSER_REALM_RECIPE, createBeuserChannel, readBeuserInstallationSummary, type BeuserRealmCommand, type BeuserRealmOptions } from '#adapters/core/beuser-realm/index.js';
import { createBeuserSurface, pinBeuserDriverBoot, type BeuserDriverBoot } from '#adapters/core/beuser-surface/index.js';
import { beuserJourneyLaunch } from '#composition/core/beuser/index.js';
import personas from '../../../assets/beuser/personas.json' with { type: 'json' };

const realmCommand = vi.hoisted(() => vi.fn<BeuserRealmCommand>(async () => 'fixture-container'));
// Only Docker transport is replaced. The production producer, validation, binding and Python are real.
vi.mock('../../../src/adapters/core/beuser-realm/internal/realm.js', async importOriginal => ({
  ...await importOriginal<object>(), dockerRealmCommand: () => realmCommand,
}));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const realSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
const driver = fileURLToPath(new URL('../../../src/adapters/core/beuser-surface/internal/pty-driver.py', import.meta.url));
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const close of closers.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); realmCommand.mockClear(); }
});
const context: BeuserContext = {
  binding: beuserBindingSchema.parse({ schemaVersion: 1,
    identity: { scopeId: 'scope', runId: 'run', taskId: 'task', attemptId: 'attempt', layoutRevision: 'layout', generation: 1 },
    candidate: { adapter: 'fixture', version: 'v1', evidenceRef: 'fixture', stateDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) },
    candidateDigest: 'c'.repeat(64), personaDigest: 'd'.repeat(64), journeyDigest: 'e'.repeat(64), rubricDigest: 'f'.repeat(64),
    realmId: 'realm', nonce: '12345678-1234-4234-8234-123456789abc', transcriptId: 'transcript' }),
  principal: verifiedPrincipalSchema.parse({ id: 'evaluator', ...beuserEvaluatorPrincipalRef({ issuer: 'fixture', subject: 'owner' }),
    assurance: 'workload-verified', scopeIds: ['scope'] }),
  limits: pinBeuserLimits({ schemaVersion: 1, revision: 'fixture', source: 'test', provisional: true,
    maxSteps: 40, maxWallMs: 10000, maxWaitMs: 1500, maxCalls: 2, maxTokens: 100, maxCost: 1, currency: 'USD', maxReruns: 1,
    maxTranscriptBytes: 250000, maxArtifactBytes: 50000, cleanupDeadlineMs: 1000, criticalRepetitions: 1 }),
  signal: new AbortController().signal,
};
const size = { columns: 40, rows: 5, scrollback: 10 }, bounds = { quietMs: 30, inactivityMs: 300, maxInputBytes: 4096 };

async function producer(mode: 'pty' | 'argv', program: string, corrupt?: (boot: BeuserDriverBoot) => unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'beuser-boot-'));
  closers.push(() => rm(directory, { recursive: true, force: true }));
  const cliDirectory = join(directory, 'dist/composition/core/cli/internal');
  await mkdir(cliDirectory, { recursive: true });
  await writeFile(join(cliDirectory, 'entry.js'), program);
  const handle = { binding: context.binding, containerId: 'a'.repeat(64), incarnation: '22345678-1234-4234-8234-123456789abc',
    controlDirectory: directory, controlIdentity: 'fixture' };
  let lease: BeuserRealmLease = { handle, observation: { binding: context.binding, state: 'admitted', evidenceRefs: ['fixture-readback'] } };
  const custody: BeuserRealmCustody = { reserve: async () => {}, publish: async () => {}, load: async () => lease,
    settle: async (_ctx, observation) => { lease = { handle, observation }; } };
  const realm = new BeuserRealmApplication({ create: async () => handle, inspect: async () => ({ valid: true, evidenceRefs: ['fixture-readback'] }),
    remove: async () => ({ processesAbsent: true, cgroupAbsent: true, filesystemAbsent: true, evidenceRefs: ['fixture-removal'] }) }, custody);
  const boots: BeuserDriverBoot[] = [], exits: Promise<{ code: number | null; signal: NodeJS.Signals | null }>[] = [], diagnostics: string[] = [];
  const launch = vi.mocked(processes.spawn).mockReset().mockImplementation(() => {
    const child = realSpawn('python3', [driver, String(context.limits.maxArtifactBytes)],
      { env: { PATH: process.env['PATH'] ?? '', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    exits.push(new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))));
    child.stderr.on('data', (bytes: Buffer) => diagnostics.push(bytes.toString()));
    const write = child.stdin.write.bind(child.stdin);
    let first = true;
    vi.spyOn(child.stdin, 'write').mockImplementation((chunk, ...args) => {
      if (first) {
        first = false;
        const boot = JSON.parse(String(chunk)) as BeuserDriverBoot;
        boots.push(boot);
        // Map the recipe's container runtime and package mount to this host-only transport fixture.
        const wire = JSON.stringify(corrupt ? corrupt(boot) : boot).replaceAll(BEUSER_REALM_RECIPE.packageTarget, directory).replaceAll(BEUSER_REALM_RECIPE.nodeExecutable, process.execPath);
        return write(wire + '\n', ...args);
      }
      return write(chunk, ...args);
    });
    return child;
  });
  const declared = { entry: { mode, nodeExecutable: BEUSER_REALM_RECIPE.nodeExecutable, args: ['allow'] }, summary: { journeyId: 'approval-decide' } };
  const journey = beuserJourneyLaunch(declared);
  const boot = { mode, entry: journey.entry, commands: journey.commands,
    maxBootBytes: context.limits.maxArtifactBytes, language: 'C.UTF-8' };
  const options: BeuserRealmOptions = { executable: 'fixture-docker', packageRoot: directory, controllerRoot: directory,
    image: `sha256:${'a'.repeat(64)}`, uid: 1000, gid: 1000, memoryBytes: 1, nanoCpus: 1, pids: 1, filesystemBytes: 1 };
  const channel = createBeuserChannel({ context, realm, custody, options, boot });
  const events: unknown[] = [];
  const surface = createBeuserSurface({ context, realm: channel, size, bounds, catalog: journey.catalog,
    sink: async (_ctx, event) => { events.push(event); } });
  closers.push(() => surface.close(context));
  return { surface, channel, boot, boots, directory, events, launch, exits, diagnostics, journey, options, handle };
}

it.skipIf(process.platform !== 'linux')('production boot starts the real PTY entry and preserves approval then nonce refusal', async () => {
  const f = await producer('pty', `
    if (!process.stdin.isTTY) process.exit(31);
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('Approval erase fixture? [y/N]');
    process.stdin.on('data', bytes => {
      if (bytes.toString() === 'y') {
        require('node:fs').writeFileSync(require('node:path').join(require('node:path').dirname(process.argv[1]), '../../../../../approved'), 'applied');
        process.stdout.write('\\x1b[2J\\x1b[HApproved');
      }
    });`);
  let screen = await f.surface.look(context);
  for (let n = 0; n < 8 && !screen.text.includes('[y/N]'); n++) screen = await f.surface.wait(context, 100);
  expect(screen.text).toContain('Approval erase fixture? [y/N]');
  realmCommand.mockResolvedValueOnce('{"installation":"unknown"}');
  await expect(readBeuserInstallationSummary(context, f.handle, f.options)).resolves.toEqual({ installation: 'unknown' });
  expect(realmCommand.mock.lastCall?.[0].slice(0, 8)).toEqual([
    'container', 'exec', '--user', `${f.options.uid}:${f.options.gid}`, f.handle.containerId, BEUSER_REALM_RECIPE.nodeExecutable, '--input-type=module', '--eval']);
  await f.surface.press(context, 'y');
  expect(await readFile(join(f.directory, 'approved'), 'utf8')).toBe('applied');
  await expect(f.surface.press({ ...context, binding: { ...context.binding, nonce: '22345678-1234-4234-8234-123456789abc' } }, 'Enter'))
    .rejects.toThrow('BEUSER_TARGET_NOT_SANDBOX');
  expect(f.boots).toHaveLength(1);
  expect(f.boots[0]).toMatchObject({ schemaVersion: 1, mode: 'pty', nonce: context.binding.nonce, secretFds: {},
    entry: [BEUSER_REALM_RECIPE.nodeExecutable, `${BEUSER_REALM_RECIPE.packageTarget}/dist/composition/core/cli/internal/entry.js`, 'allow'] });
  expect(Object.keys(f.boots[0]!).sort()).toEqual(['columns', 'commands', 'entry', 'env', 'limits', 'maxArtifactBytes', 'mode', 'nonce', 'rows', 'schemaVersion', 'secretFds']);
});

it.skipIf(process.platform !== 'linux')('production boot argv twin launches the exact command tuple on the real driver', async () => {
  const f = await producer('argv', `
    if (!process.stdin.isTTY || process.argv.at(-1) !== 'allow') process.exit(32);
    process.stdout.write('Original approval allow: ' + process.stdout.columns + 'x' + process.stdout.rows);`);
  const look = vi.spyOn(f.surface, 'look'), controller = new BeuserController(context, pinBeuserWalkerSummary(personas.personas[0]));
  const finished = vi.fn(async (screen: { text: string }) => {
    expect(screen.text).toBe('Original approval allow: 40x5'); return true;
  });
  const models = { walker: vi.fn(), evaluate: vi.fn(), cancel: vi.fn() };
  try { await walkBeuser(controller, { surface: f.surface, initialCommand: f.journey.initialCommand, finished, models, decode: vi.fn(), record: vi.fn() }); }
  finally { controller.close(); }
  expect(finished).toHaveBeenCalledOnce();
  expect(look).not.toHaveBeenCalled(); expect(models.walker).not.toHaveBeenCalled();
  expect(() => f.surface.argv(context, { commandId: 'undeclared', args: ['allow'] })).toThrow(expect.objectContaining({ code: 'BEUSER_SURFACE_INVALID' }));
  expect(() => f.surface.argv(context, { commandId: 'approval-decide', args: ['allow; rm fixture'] })).toThrow('BEUSER_SURFACE_INVALID');
  expect(f.boots).toHaveLength(1);
  expect(f.boots[0]!.commands).toEqual({ 'approval-decide': {
    prefix: [BEUSER_REALM_RECIPE.nodeExecutable, `${BEUSER_REALM_RECIPE.packageTarget}/dist/composition/core/cli/internal/entry.js`], allowedArgs: [['allow']],
  } });
  expect(JSON.stringify(f.boots[0])).not.toContain(f.directory);
  expect(f.diagnostics).toEqual([]);
});

it.skipIf(process.platform !== 'linux')('argv twin whose PTY closes before the child is waitable settles as exit, not timeout', async () => {
  // Closing stdio first makes the driver see EOF before the exit status: the order a loaded runner produced by chance.
  const f = await producer('argv', `
    const fs = require('node:fs');
    if (!require('node:tty').isatty(0) || process.argv.at(-1) !== 'allow') process.exit(32);
    fs.writeSync(1, 'Closed early allow'); fs.closeSync(0); fs.closeSync(1); fs.closeSync(2);
    setTimeout(() => process.exit(0), 200);`);
  const controller = new BeuserController(context, pinBeuserWalkerSummary(personas.personas[0]));
  const finished = vi.fn(async (screen: { text: string }) => { expect(screen.text).toBe('Closed early allow'); return true; });
  const models = { walker: vi.fn(), evaluate: vi.fn(), cancel: vi.fn() };
  try { await walkBeuser(controller, { surface: f.surface, initialCommand: f.journey.initialCommand, finished, models, decode: vi.fn(), record: vi.fn() }); }
  finally { controller.close(); }
  expect(finished).toHaveBeenCalledOnce();
  expect(f.diagnostics).toEqual([]);
});

it.skipIf(process.platform !== 'linux')('production rejects malformed boot before driver spawn', async () => {
  const f = await producer('pty', 'process.stdout.write("MUST-NOT-START")');
  f.boot.entry.splice(0);
  await expect(f.channel.open(context, size, bounds)).rejects.toMatchObject({ code: 'BEUSER_SURFACE_INVALID' });
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
});

it.skipIf(process.platform !== 'linux')('both real driver modes refuse missing or unknown boot fields with the typed code before target launch', async () => {
  for (const mode of ['pty', 'argv'] as const) {
    const f = await producer(mode, 'process.stdout.write("MUST-NOT-START")', boot => mode === 'pty'
      ? { ...boot, entry: undefined } : { ...boot, commands: { 'approval-decide': { ...boot.commands['approval-decide'], hostPath: '/forbidden' } } });
    const io = await f.channel.open(context, size, bounds);
    let output = '';
    for await (const bytes of io.output) output += String(bytes);
    expect(output).toBe('{"code":"BEUSER_SURFACE_INVALID"}\n');
    expect(await f.exits[0]).toEqual({ code: 2, signal: null });
    expect(f.diagnostics).toEqual([]);
    expect(f.events).toEqual([]);
    // The same canonical schema refuses both mutations on the producing side too.
    const bad = mode === 'pty' ? { ...f.boots[0], entry: undefined }
      : { ...f.boots[0], commands: { 'approval-decide': { ...f.boots[0]!.commands['approval-decide'], hostPath: '/forbidden' } } };
    expect(() => pinBeuserDriverBoot(bad)).toThrow('BEUSER_SURFACE_INVALID');
    await io.cancel('test-complete');
    f.launch.mockRestore();
  }
});

it.skipIf(process.platform !== 'linux')('unsupported boot versions reach the surface as a typed refusal without captured target output', async () => {
  for (const mode of ['pty', 'argv'] as const) {
    const f = await producer(mode, 'process.stdout.write("MUST-NOT-START")', boot => ({ ...boot, schemaVersion: 2 }));
    const action = mode === 'pty' ? f.surface.look(context) : f.surface.argv(context, { commandId: 'approval-decide', args: ['allow'] });
    await expect(action).rejects.toMatchObject({ code: 'BEUSER_SURFACE_INVALID' });
    // The surface's bounded cleanup can kill the driver after it publishes the refusal.
    expect([{ code: 2, signal: null }, { code: null, signal: 'SIGKILL' }]).toContainEqual(await f.exits[0]);
    expect(f.diagnostics).toEqual([]);
    expect(JSON.stringify(f.events)).not.toContain('MUST-NOT-START');
    f.launch.mockReset();
  }
});
