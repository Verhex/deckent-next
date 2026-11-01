import * as processes from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { beuserBindingSchema, beuserEvaluatorPrincipalRef, verifiedPrincipalSchema } from '#domain/index.js';
import { pinBeuserLimits, pinBeuserWalkerSummary, type BeuserContext } from '#engine/core/beuser-contract/index.js';
import { BeuserController, walkBeuser } from '#engine/core/beuser/index.js';
import { BeuserRealmApplication, type BeuserRealmCustody, type BeuserRealmLease } from '#engine/core/beuser-realm/index.js';
import { BEUSER_REALM_RECIPE, createBeuserChannel, readBeuserInstallationSummary, type BeuserRealmCommand, type BeuserRealmOptions } from '#adapters/core/beuser-realm/index.js';
import { createBeuserSurface, pinBeuserDriverBoot, beuserTerminalFixture, type BeuserTerminalFixture, type BeuserDriverBoot } from '#adapters/core/beuser-surface/index.js';
import { beuserJourneyLaunch } from '#composition/core/beuser/index.js';
import theme from '../../../assets/beuser/journeys/theme-light.json' with { type: 'json' };
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

async function producer(mode: 'pty' | 'argv', program: string, corrupt?: (boot: BeuserDriverBoot) => unknown, terminalFixture?: BeuserTerminalFixture) {
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
  const children: processes.ChildProcessWithoutNullStreams[] = [];
  const launch = vi.mocked(processes.spawn).mockReset().mockImplementation(() => {
    const child = realSpawn('python3', [driver, String(context.limits.maxArtifactBytes)],
      { env: { PATH: process.env['PATH'] ?? '', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
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
  const boot = { ...(terminalFixture ? { terminalFixture } : {}), mode, entry: journey.entry, commands: journey.commands,
    maxBootBytes: context.limits.maxArtifactBytes, language: 'C.UTF-8' };
  const options: BeuserRealmOptions = { executable: 'fixture-docker', packageRoot: directory, controllerRoot: directory,
    image: `sha256:${'a'.repeat(64)}`, uid: 1000, gid: 1000, memoryBytes: 1, nanoCpus: 1, pids: 1, filesystemBytes: 1 };
  const channel = createBeuserChannel({ context, realm, custody, options, boot });
  const events: unknown[] = [];
  const surface = createBeuserSurface({ context, realm: channel, size, bounds, ...(terminalFixture ? { terminalFixture } : {}), catalog: journey.catalog,
    sink: async (_ctx, event) => { events.push(event); } });
  closers.push(() => surface.close(context));
  return { surface, channel, boot, boots, directory, events, launch, exits, diagnostics, journey, options, handle, children };
}

it.skipIf(process.platform !== 'linux')('production boot starts the real PTY entry and preserves approval then nonce refusal', async () => {
  const terminalFixture = beuserTerminalFixture(theme.rubric.parameters, ['TL-A'])!;
  const f = await producer('pty', `
    if (!process.stdin.isTTY) process.exit(31);
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('\\x1b]11;?\\x1b\\\\\\x1b[c\\x1b[38;2;58;53;48mApproval erase fixture? [y/N]');
    process.stdin.on('data', bytes => {
      if (bytes.toString() === 'y') {
        require('node:fs').writeFileSync(require('node:path').join(require('node:path').dirname(process.argv[1]), '../../../../../approved'), 'applied');
        process.stdout.write('\\x1b[2J\\x1b[HApproved');
      }
    });`, undefined, terminalFixture);
  let screen = await f.surface.look(context);
  for (let n = 0; n < 8 && !screen.text.includes('[y/N]'); n++) screen = await f.surface.wait(context, 100);
  expect(screen.text).toContain('Approval erase fixture? [y/N]');
  expect(JSON.stringify(f.events)).toContain('terminalExchange');
  expect(JSON.stringify(f.events)).toContain('#f0ece5');
  expect(JSON.stringify(f.events)).not.toContain('rgb:f0f0');
  // Walk20: lifecycle is read (installed, no runtime socket: stopped); fields without an in-realm reader stay unknown.
  realmCommand.mockResolvedValueOnce('"installed"').mockResolvedValueOnce('"absent"');
  await expect(readBeuserInstallationSummary(context, f.handle, f.options)).resolves.toEqual({ installation: 'installed', preservedData: 'unknown', card: 'unknown',
    receiptLocation: 'unknown', forbiddenEffect: 'unknown', lifecycle: 'stopped' });
  expect(realmCommand.mock.lastCall?.[0].slice(0, 8)).toEqual([
    'container', 'exec', '--user', `${f.options.uid}:${f.options.gid}`, f.handle.containerId, BEUSER_REALM_RECIPE.nodeExecutable, '--input-type=module', '--eval']);
  await f.surface.press(context, 'y');
  expect(await readFile(join(f.directory, 'approved'), 'utf8')).toBe('applied');
  await expect(f.surface.press({ ...context, binding: { ...context.binding, nonce: '22345678-1234-4234-8234-123456789abc' } }, 'Enter'))
    .rejects.toThrow('BEUSER_TARGET_NOT_SANDBOX');
  expect(f.boots).toHaveLength(1);
  expect(f.boots[0]).toMatchObject({ schemaVersion: 1, mode: 'pty', nonce: context.binding.nonce, secretFds: {},
    entry: [BEUSER_REALM_RECIPE.nodeExecutable, `${BEUSER_REALM_RECIPE.packageTarget}/dist/composition/core/cli/internal/entry.js`, 'allow'] });
  expect(Object.keys(f.boots[0]!).sort()).toEqual(['columns', 'commands', 'entry', 'env', 'limits', 'maxArtifactBytes', 'mode', 'nonce', 'rows', 'schemaVersion', 'secretFds', 'terminalFixture']);
  // The real packaged input filter consumes the actual delayed realm reply, preserving keys and Ctrl+C.
  const source = new URL('../../../src/surfaces/core/terminal-window/internal/color-reports.ts', import.meta.url);
  const filterCode = ts.transpileModule(await readFile(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  for (const interrupt of [false, true]) {
    const delayed = await producer('pty', `
      const filter = require(require('node:path').join(__dirname, '../../../../../color-reports.cjs'));
      process.stdin.setRawMode(true); process.stdin.resume();
      let typed = '', background = 'pending';
      const input = filter.createAnswerFilter(text => { typed += text; });
      process.stdin.on('data', data => input.push(data.toString()));
      input.probe.ask(query => process.stdout.write(query), 250).then(value => { background = value; });
      process.stdout.write('First frame');
      setTimeout(() => { process.stdout.write('\\x1b[2J\\x1b[H' + JSON.stringify({typed, background})); input.reset(); process.exit(0); }, 750);
    `, undefined, { ...terminalFixture, osc11: { ...terminalFixture.osc11, delayMs: 400 } });
    await writeFile(join(delayed.directory, 'color-reports.cjs'), filterCode);
    await writeFile(join(delayed.directory, 'answer-limits.json'), await readFile(new URL('answer-limits.json', source)));
    let first = await delayed.surface.look(context);
    for (let n = 0; n < 8 && !first.text.includes('First frame'); n++) first = await delayed.surface.wait(context, 100);
    expect(first.text).toContain('First frame');
    await delayed.surface.type(context, 'ab');
    if (interrupt) await delayed.surface.press(context, 'Ctrl+C');
    const final = await delayed.surface.wait(context, 1000);
    expect(JSON.parse(final.text)).toEqual({ typed: interrupt ? 'ab\u0003' : 'ab', background: null });
    expect(final.text).not.toContain('rgb:');
    expect(JSON.stringify(delayed.events)).toContain('terminalExchange');
    await delayed.surface.close(context);
  }
  // EOF before the delayed OSC reply must leave the open control pipe idle, without a late PTY write.
  const early = await producer('pty', `
    require('node:fs').writeSync(1, '\\x1b]11;?\\x1b\\\\'); process.exit(23);
  `, undefined, { ...terminalFixture, osc11: { ...terminalFixture.osc11, delayMs: 400 } });
  await early.surface.look(context);
  await early.surface.wait(context, 300);
  expect(early.events.at(-1)).toMatchObject({ process: { state: 'eof', exitCode: 23 } });
  const child = early.children[0]!;
  const clockTicks = Number(processes.execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
  expect(clockTicks).toBeGreaterThan(0);
  const cpuMs = async () => {
    const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8');
    // Fields 14/15 (utime/stime), after pid and the parenthesized command name.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    return (Number(fields[11]) + Number(fields[12])) * 1000 / clockTicks;
  };
  const before = await cpuMs();
  expect(child.stdin.writableEnded).toBe(false);
  await sleep(800); // No control request until well past the 400 ms reply deadline.
  const used = await cpuMs() - before;
  expect(child.exitCode).toBeNull(); expect(child.stdin.writableEnded).toBe(false);
  expect(used, `idle driver consumed ${used} ms CPU`).toBeLessThan(100);
  await early.surface.look(context);
  expect(early.events.at(-1)).toMatchObject({ process: { state: 'eof', exitCode: 23 } });
  const exchanges = early.events.flatMap(row => (row as { screen?: { terminalExchange?: { query: string; response: string | null }[] } }).screen?.terminalExchange ?? []);
  expect(exchanges).toEqual([expect.objectContaining({ query: 'osc11', response: null })]);
  expect(early.diagnostics).toEqual([]);
  await early.surface.close(context);
  expect(await early.exits[0]).toEqual({ code: null, signal: 'SIGKILL' });
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
  const fixture = beuserTerminalFixture(theme.rubric.parameters, ['TL-A'])!;
  for (const variant of [{ digits: 1, delayMs: 0, reply: true }, { digits: 2, delayMs: 0, reply: true },
    { digits: 3, delayMs: 0, reply: true }, { digits: 4, delayMs: 400, reply: true }, { digits: 4, delayMs: 0, reply: false }]) {
    const terminalFixture = { ...fixture, osc11: variant };
    const queried = await producer('argv', `
      if (!process.stdin.isTTY || process.argv.at(-1) !== 'allow') process.exit(32);
      process.stdin.setRawMode(true); process.stdin.resume();
      let reply = '';
      process.stdin.on('data', data => { reply += data.toString(); });
      process.stdout.write('\\x1b]11;');
      setTimeout(() => process.stdout.write('?\\x1b\\\\\\x1b[c'), 10);
      setTimeout(() => { process.stdout.write('\\x1b[2J\\x1b[H' + (reply.includes('rgb:') ? 'OSC received' : 'OSC absent')); process.exit(0); }, 550);
    `, undefined, terminalFixture);
    expect((await queried.surface.argv(context, { commandId: 'approval-decide', args: ['allow'] })).text).toBe(variant.reply ? 'OSC received' : 'OSC absent');
    const exchanges = queried.events.flatMap(row => (row as { screen?: { terminalExchange?: { query: string; request: string; response: string | null; atMs: number }[] } }).screen?.terminalExchange ?? []);
    const requests = exchanges.filter(row => row.query === 'osc11' && row.response === null), replies = exchanges.filter(row => row.query === 'osc11' && row.response !== null);
    expect(requests).toHaveLength(1); expect(Buffer.from(requests[0]!.request, 'base64').toString()).toBe('\x1b]11;?\x1b\\');
    expect(replies).toHaveLength(variant.reply ? 1 : 0);
    if (variant.reply) {
      expect(Buffer.from(replies[0]!.response!, 'base64').toString()).toMatch(new RegExp('rgb:[a-f0-9]{' + variant.digits + '}/[a-f0-9]{' + variant.digits + '}/[a-f0-9]{' + variant.digits + '}'));
      expect(replies[0]!.atMs - requests[0]!.atMs).toBeGreaterThanOrEqual(variant.delayMs);
    }
    expect(queried.diagnostics).toEqual([]);
    await queried.surface.close(context);
  }
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
