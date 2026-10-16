import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { eventsCommand, type EventsCommandContext } from '#surfaces/core/cli-events/index.js';
import { clearConfigCache } from '#platform/index.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const flags = ['events', '--follow', '--json', '--input', '-'];
async function fixture(scopeId = 'scope') {
  const root = await mkdtemp(join(tmpdir(), 'dk-events-cli-')); roots.push(root); await mkdir(join(root, '.deckent'));
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') } }));
  const env = { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: join(root, 'global') };
  const input = Buffer.from(JSON.stringify({ schemaVersion: 1, scopeId, topics: ['run'], resume: null }));
  let stdout = '', stderr = '';
  const context: EventsCommandContext = { root, env, stdin: Readable.from([...input].map(byte => Buffer.from([byte]))),
    stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } } };
  return { context, get stdout() { return stdout; }, get stderr() { return stderr; } };
}
it('accepts chunked UTF-8 stdin and EOF and writes exactly one complete JSON object per line without diagnostics on stdout', async () => {
  const f = await fixture('proje-ş'); const serviceEpoch = randomUUID(), viewId = randomUUID();
  f.context.subscribeEvents = async (_root, query, _options, observer) => {
    expect(query.scopeId).toBe('proje-ş'); await observer.onEvent({ type: 'ready', scopeId: query.scopeId, topics: ['run'], serviceEpoch, viewId, mode: 'observation-order' });
    await observer.onEvent({ type: 'close', reason: 'service-shutdown', resume: { serviceEpoch, viewId, sequence: 0 } });
  };
  await eventsCommand(flags, f.context);
  expect(f.stdout.trim().split('\n').map(line => JSON.parse(line) as unknown)).toMatchObject([{ type: 'ready' }, { type: 'close' }]); expect(f.stderr).toBe('');
});
it('requires the fixed follow/json/stdin route and never falls back to polling', async () => {
  const f = await fixture(); let called = false; f.context.subscribeEvents = async () => { called = true; };
  for (const argv of [['events', '--json'], ['events', '--follow', '--input', '-'], ['events', '--follow', '--json', '--input', 'file'], [...flags, '--actor', 'owner']]) {
    await expect(eventsCommand(argv, f.context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  }
  expect(called).toBe(false); expect(f.stdout).toBe('');
});
it('refuses unknown fields or invalid UTF-8 before calling the runtime', async () => {
  const f = await fixture(); let called = false; f.context.subscribeEvents = async () => { called = true; };
  for (const bytes of [Buffer.from('{"schemaVersion":1,"scopeId":"scope","topics":["run"],"principal":"owner"}'), Buffer.from([0xff])]) {
    f.context.stdin = Readable.from([bytes]); await expect(eventsCommand(flags, f.context)).rejects.toMatchObject({ code: 'RUNTIME_EVENTS_INVALID' });
  }
  expect(called).toBe(false);
});
it('stdout backpressure waits for drain before applying another item', async () => {
  const f = await fixture(), sink = new EventEmitter() as EventEmitter & { write(text: string): boolean }; let lines = 0;
  sink.write = () => { lines++; return false; }; f.context.stdout = sink;
  let callbackStarted!: () => void; const started = new Promise<void>(resolve => { callbackStarted = resolve; }); let applied = false;
  f.context.subscribeEvents = async (_root, _query, _options, observer) => {
    const work = observer.onEvent({ type: 'close', reason: 'service-shutdown', resume: { serviceEpoch: randomUUID(), viewId: randomUUID(), sequence: 0 } }); callbackStarted(); await work; applied = true;
  };
  const pending = eventsCommand(flags, f.context); await started; expect(applied).toBe(false); expect(lines).toBe(1); sink.emit('drain'); await pending; expect(applied).toBe(true);
});
it('EPIPE and caller cancellation detach only the subscription', async () => {
  for (const reason of ['EPIPE', 'signal']) {
    const f = await fixture(), controller = new AbortController(), sink = new EventEmitter() as EventEmitter & { write(text: string): boolean };
    f.context.signal = controller.signal; sink.write = () => true; f.context.stdout = sink;
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); let detached = false;
    f.context.subscribeEvents = async (_root, _query, _options, observer) => {
      entered(); await new Promise<void>(resolve => { observer.signal.addEventListener('abort', () => { detached = true; resolve(); }, { once: true }); });
    };
    const pending = eventsCommand(flags, f.context); await started;
    if (reason === 'EPIPE') sink.emit('error', Object.assign(new Error('pipe'), { code: 'EPIPE' })); else controller.abort();
    await pending; expect(detached).toBe(true); expect(sink.listenerCount('error')).toBe(0);
  }
});
it('cancels a pending stdin read before EOF without starting any subscription', async () => {
  const f = await fixture(), controller = new AbortController();
  f.context.signal = controller.signal; f.context.stdin = new Readable({ read() { /* intentionally awaiting input */ } });
  let subscribed = false; f.context.subscribeEvents = async () => { subscribed = true; };
  const pending = eventsCommand(flags, f.context);
  await new Promise<void>(resolve => setImmediate(resolve)); controller.abort(); await pending;
  expect(subscribed).toBe(false);
});
