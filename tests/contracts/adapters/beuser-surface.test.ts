import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { beuserBindingSchema } from '#domain/core/beuser/index.js';
import { beuserEvaluatorPrincipalRef, verifiedPrincipalSchema } from '#domain/core/principal/index.js';
import { pinBeuserLimits, type BeuserContext } from '#engine/core/beuser-contract/index.js';
import { createBeuserSurface, pinBeuserDriverBoot, type BeuserRealmChannel, type BeuserSurfaceOptions, type HarnessEvent, type RealmDriverIO } from '#adapters/core/beuser-surface/index.js';

const binding = beuserBindingSchema.parse({ schemaVersion: 1,
  identity: { scopeId: 'scope', runId: 'run', taskId: 'task', attemptId: 'attempt', layoutRevision: 'layout', generation: 1 },
  candidate: { adapter: 'fixture', version: 'v1', evidenceRef: 'fixture', stateDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) },
  candidateDigest: 'c'.repeat(64), personaDigest: 'd'.repeat(64), journeyDigest: 'e'.repeat(64), rubricDigest: 'f'.repeat(64),
  realmId: 'realm', nonce: '12345678-1234-4234-8234-123456789abc', transcriptId: 'transcript' });
const principal = verifiedPrincipalSchema.parse({ id: 'evaluator', ...beuserEvaluatorPrincipalRef({ issuer: 'local', subject: 'person' }),
  assurance: 'workload-verified', scopeIds: ['scope'] });
const limits = pinBeuserLimits({ schemaVersion: 1, revision: 'fixture', source: 'test', provisional: true, maxSteps: 40, maxWallMs: 10000,
  maxWaitMs: 1500, maxCalls: 10, maxTokens: 1000, maxCost: 1, currency: 'USD', maxReruns: 1,
  maxTranscriptBytes: 250000, maxArtifactBytes: 50000, cleanupDeadlineMs: 1000, criticalRepetitions: 1 });
const context: BeuserContext = { binding, principal, limits, signal: new AbortController().signal };
const size = { columns: 40, rows: 5, scrollback: 10 }, bounds = { quietMs: 30, inactivityMs: 300, maxInputBytes: 4096 };
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

function fixture(response: (command: Record<string, unknown>) => Record<string, unknown> | null = () => ({})) {
  const output = new PassThrough(), commands: Record<string, unknown>[] = [], events: HarnessEvent[] = [];
  const input = new Writable({ write(chunk: Buffer, _encoding, callback) {
    const command = JSON.parse(chunk.toString()) as Record<string, unknown>;
    commands.push(command);
    const reply = response(command);
    if (reply) queueMicrotask(() => output.write(JSON.stringify({ id: command['id'], data: Buffer.from('Approval [y/N]').toString('base64'),
      state: 'ready', exitCode: null, columns: 40, rows: 5, ...reply }) + '\n'));
    callback();
  } });
  const io: RealmDriverIO = { input, output, cancel: vi.fn(async () => { input.destroy(); output.destroy(); }) };
  const realm: BeuserRealmChannel = { binding, verify: vi.fn(async () => {}), open: vi.fn(async () => io), cancel: vi.fn(async () => {}) };
  const options: BeuserSurfaceOptions = { context, realm, size, bounds, catalog: [{ commandId: 'approval-decide', args: ['allow'] }],
    sink: async (_context, event) => { events.push(event); } };
  const surface = createBeuserSurface(options);
  closers.push(() => surface.close(context));
  return { surface, realm, io, commands, events, options };
}

it('after a synthetic approval, nonce/Attempt/principal changes still fail before any realm effect', async () => {
  const f = fixture();
  expect((await f.surface.look(context)).text).toContain('Approval [y/N]');
  await f.surface.press(context, 'y');
  expect(f.events.some(event => event.entry.kind === 'synthetic-person-decision')).toBe(true);
  const before = f.commands.length;
  for (const changed of [{ ...binding, nonce: '22345678-1234-4234-8234-123456789abc' },
    { ...binding, identity: { ...binding.identity, generation: 2 } }, { ...binding, realmId: 'foreign' }]) {
    await expect(f.surface.press({ ...context, binding: changed }, 'Enter')).rejects.toThrow('BEUSER_TARGET_NOT_SANDBOX');
  }
  await expect(f.surface.argv({ ...context, principal: { ...principal, subject: 'foreign' } },
    { commandId: 'approval-decide', args: ['allow'] })).rejects.toThrow('BEUSER_TARGET_NOT_SANDBOX');
  expect(f.commands).toHaveLength(before);
  expect(f.realm.verify).toHaveBeenCalledTimes(2);
});

it('rechecks sealed admission even after the card was answered and preserves the original dangerous command', async () => {
  const f = fixture();
  await f.surface.look(context);
  await f.surface.press(context, 'y');
  vi.mocked(f.realm.verify).mockRejectedValueOnce(new Error('BEUSER_TARGET_NOT_SANDBOX'));
  await expect(f.surface.argv(context, { commandId: 'approval-decide', args: ['allow'] })).rejects.toThrow('BEUSER_TARGET_NOT_SANDBOX');
  expect(f.commands.map(command => command['op'])).toEqual(['read', 'input']);
  expect(f.realm.cancel).toHaveBeenCalledWith(expect.anything(), 'interrupted');
});

it('rejects multiline text, bundled Enter and executable/shell substitution despite an approved card', async () => {
  const f = fixture();
  await f.surface.look(context); await f.surface.press(context, 'y');
  // Walk18: a refused walker action is retained (kind and reason; typed text withheld) and the session stays open for a correction.
  await expect(f.surface.type(context, 'allow\nallow')).rejects.toThrow('BEUSER_ACTION_INVALID');
  await expect(f.surface.press(context, 'Enter Enter')).rejects.toThrow('BEUSER_ACTION_INVALID');
  expect(f.events.filter(event => event.action?.refused).map(event => [event.entry.kind, event.action])).toEqual([['action', { kind: 'type', refused: 'BEUSER_ACTION_INVALID' }],
    ['action', { kind: 'press', key: 'Enter Enter', refused: 'BEUSER_ACTION_INVALID' }]]);
  expect(JSON.stringify(f.events)).not.toContain('allow\\nallow');
  expect(() => f.surface.argv(context, { commandId: '/bin/sh', args: ['-c', 'approval decide allow'] })).toThrow('BEUSER_SURFACE_INVALID');
  expect(() => f.surface.argv(context, { commandId: 'approval-decide', args: ['allow; approval decide allow'] })).toThrow('BEUSER_SURFACE_INVALID');
  expect(f.commands).toHaveLength(2);
  await f.surface.argv(context, { commandId: 'approval-decide', args: ['allow'] });
  expect(f.commands.at(-1)).toMatchObject({ op: 'argv', commandId: 'approval-decide', args: ['allow'], nonce: binding.nonce });
});

it('refuses concurrent keys instead of queueing an Enter into a later card', async () => {
  let reads = 0;
  const f = fixture(() => ++reads === 1 ? {} : null);
  await f.surface.look(context);
  const first = f.surface.press(context, 'Enter');
  await expect(f.surface.press(context, 'Enter')).rejects.toThrow('BEUSER_SURFACE_BUSY');
  await f.surface.close(context);
  await expect(first).rejects.toThrow();
  expect(f.commands.filter(command => command['op'] === 'input').length).toBeLessThanOrEqual(1);
});

it('secret capture never exports a value/reference/hash and cannot be reopened by a walker', async () => {
  const f = fixture(command => command['op'] === 'secret' ? { state: 'secret', data: '' } : {});
  await f.surface.look(context); await f.surface.press(context, 'y');
  await f.surface.secret(context, 'opaque-secret-ref');
  expect(f.commands.at(-1)).toMatchObject({ op: 'secret', ref: 'opaque-secret-ref' });
  expect(JSON.stringify(f.events)).not.toContain('opaque-secret-ref');
  expect(f.events.at(-1)?.entry.kind).toBe('secret-step');
  await expect(f.surface.look(context)).rejects.toThrow('BEUSER_CAPTURE_BLOCKED');
  expect(f.commands).toHaveLength(3);
});

it('a secret-marked malicious reply is blocked before render or artifact capture', async () => {
  let secret = false;
  const f = fixture(() => secret ? { state: 'secret', data: Buffer.from('MUST-NOT-EXPORT').toString('base64') } : {});
  await f.surface.look(context); await f.surface.press(context, 'y');
  secret = true;
  const before = f.events.length;
  await expect(f.surface.look(context)).rejects.toThrow('BEUSER_CAPTURE_BLOCKED');
  expect(f.events.slice(before).map(event => ({ action: event.action, screen: event.screen, process: event.process }))).toEqual([{ action: { kind: 'look' }, screen: undefined, process: undefined }]);
  expect(JSON.stringify(f.events)).not.toContain('MUST-NOT-EXPORT');
});

it('resumes a secret journey only on a new C2 driver with retained reset evidence', async () => {
  const f = fixture(command => command['op'] === 'secret' ? { state: 'secret', data: '' } : {});
  await f.surface.look(context); await f.surface.press(context, 'y');
  await f.surface.secret(context, 'opaque');
  const replacement = fixture(() => ({ data: Buffer.from('Fresh screen').toString('base64') }));
  f.realm.restartAfterSecret = vi.fn(async () => ({ io: replacement.io, evidenceRef: 'retained-reset-proof' }));
  expect((await f.surface.resumeAfterSecret(context)).text).toBe('Fresh screen');
  expect(f.events.find(event => event.action?.kind === 'capture-reset')?.action?.evidenceRef).toBe('retained-reset-proof');
  expect(vi.mocked(f.io.cancel)).toHaveBeenCalledWith('secret-reset');
  expect(f.events.at(-1)?.entry.sequence).toBeGreaterThan(f.events[0]!.entry.sequence);
});

it('partial VT replies are continued without repeating input or exposing an intermediate screen', async () => {
  let count = 0;
  const f = fixture(() => ({ data: Buffer.from(++count === 1 ? '\x1b[2' : 'J\x1b[HReady').toString('base64') }));
  expect((await f.surface.press(context, 'Enter')).text).toBe('Ready');
  expect(f.commands.map(command => command['op'])).toEqual(['input', 'read']);
  expect(f.events.filter(event => event.entry.kind === 'screen')).toHaveLength(1);
});

it('unavailable realm capabilities and unproven secret resets never open a host fallback', async () => {
  const unavailable = fixture();
  vi.mocked(unavailable.realm.verify).mockRejectedValueOnce(new Error('BEUSER_SURFACE_UNAVAILABLE'));
  await expect(unavailable.surface.look(context)).rejects.toThrow('BEUSER_SURFACE_UNAVAILABLE');
  expect(unavailable.realm.open).not.toHaveBeenCalled();
  const secret = fixture(command => command['op'] === 'secret' ? { state: 'secret', data: '' } : {});
  await secret.surface.look(context); await secret.surface.press(context, 'y'); await secret.surface.secret(context, 'opaque');
  await expect(secret.surface.resumeAfterSecret(context)).rejects.toThrow('BEUSER_SURFACE_UNAVAILABLE');
  expect(secret.realm.open).toHaveBeenCalledTimes(1);
});

it('a synchronous transport cleanup failure still invokes the realm cleanup owner', async () => {
  const f = fixture();
  await f.surface.look(context);
  vi.mocked(f.io.cancel).mockImplementationOnce(() => { throw new Error('transport-lost'); });
  await expect(f.surface.close(context)).rejects.toThrow('BEUSER_SURFACE_UNAVAILABLE');
  expect(f.realm.cancel).toHaveBeenCalledWith(expect.anything(), 'closed');
});

it('bounds hanging transport, floods, steps and cancellation without a hidden retry', async () => {
  const hanging = fixture(() => null);
  const short = { ...context, limits: pinBeuserLimits({ ...limits, maxWaitMs: 40 }) };
  const options = { ...hanging.options, context: short, bounds: { ...bounds, quietMs: 1, inactivityMs: 10 } };
  const surface = createBeuserSurface(options);
  await expect(surface.look(short)).rejects.toThrow('BEUSER_SURFACE_LIMIT');
  expect(hanging.realm.open).toHaveBeenCalledTimes(1);
  const flood = fixture(() => ({ data: Buffer.from('x'.repeat(limits.maxTranscriptBytes + 1)).toString('base64') }));
  await expect(flood.surface.look(context)).rejects.toThrow('BEUSER_SURFACE_LIMIT');
  expect(flood.events.map(event => ({ action: event.action, screen: event.screen, process: event.process }))).toEqual([{ action: { kind: 'look' }, screen: undefined, process: undefined }]);
  const controller = new AbortController(), cancelled = fixture(() => null);
  const cancelledContext = { ...context, signal: controller.signal };
  const active = createBeuserSurface({ ...cancelled.options, context: cancelledContext });
  const pending = active.look(cancelledContext);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(cancelled.realm.open).not.toHaveBeenCalled();
  await active.close(context).catch(() => {});
  const limited = fixture();
  const one = { ...context, limits: pinBeuserLimits({ ...limits, maxSteps: 1 }) };
  const oneSurface = createBeuserSurface({ ...limited.options, context: one });
  await oneSurface.look(one);
  await expect(oneSurface.press(one, 'Enter')).rejects.toThrow('BEUSER_SURFACE_LIMIT');
  expect(limited.commands).toHaveLength(1);
});

async function pythonFixture(mode: 'pty' | 'argv', program: string, secretValue?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'beuser-driver-'));
  const events: HarnessEvent[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  const entry = [process.execPath, '-e', program, directory];
  const realm: BeuserRealmChannel = { binding, verify: async () => {}, cancel: async () => {},
    open: async () => {
      child = spawn('python3', [fileURLToPath(new URL('../../../src/adapters/core/beuser-surface/internal/pty-driver.py', import.meta.url)), '50000'],
        { stdio: ['pipe', 'pipe', 'ignore', 'pipe'], env: { PATH: process.env['PATH'] ?? '' } });
      const processChild = child;
      processChild.stdin!.write(JSON.stringify(pinBeuserDriverBoot({ schemaVersion: 1, nonce: binding.nonce, mode, entry, columns: size.columns, rows: size.rows,
        env: { TERM: 'xterm-256color', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: directory, DECKENT_GLOBAL_HOME: join(directory, '.deckent') }, maxArtifactBytes: limits.maxArtifactBytes,
        limits: { maxSteps: limits.maxSteps, maxWallMs: limits.maxWallMs, maxWaitMs: limits.maxWaitMs,
          maxTranscriptBytes: limits.maxTranscriptBytes, cleanupDeadlineMs: limits.cleanupDeadlineMs, ...bounds },
        commands: { 'approval-decide': { prefix: entry, allowedArgs: [['allow']] } },
        secretFds: secretValue ? { opaque: 3 } : {} })) + '\n');
      if (secretValue) (processChild.stdio[3] as Writable).end(secretValue);
      return { input: processChild.stdin!, output: processChild.stdout!, cancel: async () => {
        const exited = new Promise<void>(resolve => processChild.once('close', () => resolve()));
        if (processChild.exitCode !== null || processChild.signalCode !== null) return;
        processChild.stdin!.end();
        processChild.kill('SIGTERM');
        const timer = setTimeout(() => processChild.kill('SIGKILL'), limits.cleanupDeadlineMs);
        try { await exited; } finally { clearTimeout(timer); }
      } };
    } };
  const surface = createBeuserSurface({ context, realm, size, bounds, catalog: [{ commandId: 'approval-decide', args: ['allow'] }],
    sink: async (_context, event) => { events.push(event); } });
  closers.push(async () => { await surface.close(context); await rm(directory, { recursive: true, force: true }); });
  return { surface, directory, events };
}

it.skipIf(process.platform !== 'linux')('real Python PTY has controlling TTY, physical winsize, approval effect, resize and EOF', async () => {
  const f = await pythonFixture('pty', `
    const fs = require('node:fs'), path = require('node:path');
    if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(31);
    fs.openSync('/dev/tty', 'r');
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdout.write('Approval erase fixture? [y/N] ' + process.stdout.columns + 'x' + process.stdout.rows);
    process.on('SIGWINCH', () => process.stdout.write('\\x1b[2J\\x1b[HResize ' + process.stdout.columns + 'x' + process.stdout.rows));
    process.stdin.on('data', data => {
      if (data.toString() === 'y') { fs.writeFileSync(path.join(process.argv[1], 'approved'), 'applied'); setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[HApproved'), 120); }
      if (data[0] === 4) process.exit(0);
    });`);
  let screen = await f.surface.look(context);
  for (let n = 0; n < 8 && !screen.text.includes('[y/N]'); n++) screen = await f.surface.wait(context, 100);
  expect(screen.text).toContain('Approval erase fixture? [y/N] 40x5');
  // Walk19R: the product redraws after more silence than quietMs; the press still returns that redraw, not the stale card.
  expect((await f.surface.press(context, 'y')).text).toBe('Approved');
  expect(await readFile(join(f.directory, 'approved'), 'utf8')).toBe('applied');
  expect((await f.surface.resize(context, 25, 6)).text).toBe('Resize 25x6');
  await f.surface.press(context, 'Ctrl+D');
  expect(f.events.some(event => event.entry.kind === 'synthetic-person-decision')).toBe(true);
});

it.skipIf(process.platform !== 'linux')('argv twin executes the original approved tuple on a controlling PTY and returns final output', async () => {
  const f = await pythonFixture('argv', `
    if (!process.stdin.isTTY || !process.stdout.isTTY || process.argv.at(-1) !== 'allow') process.exit(32);
    require('node:fs').openSync('/dev/tty', 'r');
    process.stdout.write('Approval allow: ' + process.stdout.columns + 'x' + process.stdout.rows);`);
  expect((await f.surface.argv(context, { commandId: 'approval-decide', args: ['allow'] })).text).toBe('Approval allow: 40x5');
});

it.skipIf(process.platform !== 'linux')('opaque FD injection runs only while capture is closed, including a deliberately echoing target', async () => {
  const f = await pythonFixture('pty', `
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('Approval [y/N]');
    let approved = false;
    process.stdin.on('data', bytes => {
      if (!approved && bytes.toString() === 'y') { approved = true; process.stdout.write('\\x1b[2J\\x1b[HSecret'); }
      else process.stdout.write('ECHO:' + bytes.toString());
    });`, 'fixture-confidential-value');
  let screen = await f.surface.look(context);
  for (let n = 0; n < 8 && !screen.text.includes('[y/N]'); n++) screen = await f.surface.wait(context, 100);
  expect(screen.text).toContain('[y/N]');
  await f.surface.press(context, 'y');
  await f.surface.secret(context, 'opaque');
  await expect(f.surface.look(context)).rejects.toThrow('BEUSER_CAPTURE_BLOCKED');
  expect(JSON.stringify(f.events)).not.toContain('fixture-confidential-value');
  expect(f.events.at(-1)?.entry.kind).toBe('secret-step');
});

it.skipIf(process.platform !== 'linux')('real argv hang and raw byte flood have finite failure and no retained flood screen', async () => {
  const hanging = await pythonFixture('argv', 'setInterval(() => {}, 1000)');
  await expect(hanging.surface.argv(context, { commandId: 'approval-decide', args: ['allow'] })).rejects.toThrow();
  expect(hanging.events.filter(event => event.entry.kind === 'screen')).toHaveLength(0);
  const flood = await pythonFixture('argv', `process.stdout.write('x'.repeat(${limits.maxTranscriptBytes + 1}));`);
  await expect(flood.surface.argv(context, { commandId: 'approval-decide', args: ['allow'] })).rejects.toThrow();
  expect(flood.events.filter(event => event.entry.kind === 'screen')).toHaveLength(0);
});

it('retains each look, wait, type and atomic press in order, with wait duration and no typed plaintext', async () => {
  const f = fixture();
  await f.surface.look(context);
  await f.surface.wait(context, 25);
  await f.surface.type(context, 'private typed value');
  await f.surface.press(context, 'Enter');
  // Walk18: the spellings screens show (`Esc`, `PgDn`, `↓`) press the named key, recorded by its name.
  for (const key of ['Esc', 'PgDn', '↓']) await f.surface.press(context, key);
  const actions = f.events.filter(event => event.action).map(event => event.action);
  expect(actions).toEqual([{ kind: 'look' }, { kind: 'wait', ms: 25 }, { kind: 'type' }, { kind: 'press', key: 'Enter' },
    { kind: 'press', key: 'Escape' }, { kind: 'press', key: 'PageDown' }, { kind: 'press', key: 'ArrowDown' }]);
  expect(JSON.stringify(f.events)).not.toContain('private typed value');
  expect(f.commands.map(command => command['op'])).toEqual(['read', 'read', 'input', 'input', 'input', 'input', 'input']);
  expect(f.commands.slice(-3).map(command => command['text'])).toEqual(['\x1b', '\x1b[6~', '\x1b[B']);
});
