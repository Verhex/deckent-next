import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import type { RequestOptions, RequestListener } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openNativeConnection } from '#adapters/core/native-connection/index.js';
import { FileArtifactStore } from '#adapters/core/file-artifacts/index.js';
import { openWorkerEventSink, sealAttemptWorkerEvents, WORKER_EVENT_SEAL_RESERVE_BYTES } from '#adapters/core/worker-observation/index.js';
import { attemptIdentitySchema, workerEventSchema, type WorkerEvent } from '#domain/index.js';
import { fillOrdinaryBytes, ndjson, observation, unmapped } from './n0-preflight-fixture.js';

const handlers = new Map<string, RequestListener>();

// AF_UNIX listen returns EPERM in this sandbox. Run the real gateway request handler
// with an in-memory HTTP transport. The gateway still creates and checks its fixture key.
vi.mock(import('node:http'), async importOriginal => {
  const http = await importOriginal();
  return { ...http, createServer: (_options: unknown, handler: RequestListener) => {
    let path: string;
    return Object.assign(new EventEmitter(), {
      listen: async (socketPath: string, ready: () => void) => {
        path = socketPath;
        await writeFile(path, '');
        handlers.set(path, handler);
        ready();
      },
      close: (done: () => void) => { handlers.delete(path); done(); },
    });
  } };
});

vi.mock(import('../../../src/adapters/core/native-connection/internal/egress.js'), async importOriginal => ({
  ...await importOriginal(), privateSocketDirectory: () => mkdtemp('/tmp/card-n0pre/gateway-ipc-'),
}));

vi.mock(import('node:fs/promises'), async importOriginal => {
  const fs = await importOriginal();
  const bootstrap = new URL('../../../src/adapters/core/native-connection/internal/worker.ts', import.meta.url);
  // The mounted build is never executed here. Hash the same-revision fixture source at the bootstrap read seam.
  return { ...fs, readFile: (path: string | URL, options?: never) =>
    fs.readFile(path === bootstrap.pathname.replace(/\.ts$/, '.js') ? bootstrap : path, options) };
});

function request(options: RequestOptions, receive: (response: EventEmitter & { statusCode: number }) => void, fault?: (body: string) => 'request' | 'response' | undefined) {
  const request = Object.assign(new EventEmitter(), { destroy() {} });
  return Object.assign(request, { end(body = '') {
    queueMicrotask(() => {
      const loss = fault?.(body);
      if (loss === 'request') { request.emit('error', new Error('Fixture request never arrived')); return; }
      const handler = handlers.get(String(options.socketPath));
      if (!handler) { request.emit('error', new Error('Fixture transport disconnected')); return; }
      const incoming = Object.assign(new EventEmitter(), {
        headers: options.headers, method: options.method, url: options.path, resume() {}, setEncoding() {}, destroy() {},
      });
      const outgoing = Object.assign(new EventEmitter(), { statusCode: 200, resume() {} });
      const response = {
        writeHead(status: number) { outgoing.statusCode = status; return response; },
        setHeader() {},
        end() {
          if (loss === 'response') request.emit('error', new Error('Fixture lost response'));
          else { receive(outgoing); outgoing.emit('end'); }
        },
      };
      handler(...[incoming, response] as unknown as Parameters<RequestListener>);
      incoming.emit('data', body);
      incoming.emit('end');
    });
  } });
}

type Sender = {
  push(events: readonly WorkerEvent[]): void;
  close(state: { sequence: number; startMs: number }): Promise<'held' | 'unconfirmed' | 'none'>;
};
type SenderModule = typeof import('../../../src/adapters/core/native-connection/internal/worker.js') & {
  eventChannel(socket: string, capability: string): Sender;
  useFixtureRequest(transport: typeof request): void;
};

async function senderModule(): Promise<SenderModule> {
  const source = await readFile(new URL('../../../src/adapters/core/native-connection/internal/worker.ts', import.meta.url), 'utf8');
  expect(source).toContain('request as httpRequest');
  // Expose the private sender and replace only the imported transport for this module instance.
  const js = stripTypeScriptTypes(source.replace('request as httpRequest', 'request as nodeRequest') +
    '\nlet httpRequest = nodeRequest; export { eventChannel }; export function useFixtureRequest(request) { httpRequest = request; }');
  const url = 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
  return import(/* @vite-ignore */ url);
}

function call(socketPath: string, capability: string, body?: string) {
  return new Promise<number>((resolve, reject) => {
    const req = request({ socketPath, path: body === undefined ? '/bootstrap' : '/events', method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: capability, ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }) } },
    response => response.on('end', () => resolve(response.statusCode)));
    req.on('error', reject);
    req.end(body);
  });
}


it.each(['queue', 'count', 'bytes', 'lost-response', 'unreached', 'no-record', 'legacy-204'] as const)('seals the first gateway observation once at %s', async scenario => {
  const root = await mkdtemp('/tmp/card-n0pre/gateway-'), sink = await openWorkerEventSink(root);
  const token = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url') + '.n0-test';
  const connection = await openNativeConnection({ binding: { schemaVersion: 1, provider: 'cursor' }, directory: root,
    credential: { accessToken: token }, deadlineMs: 20_000, retainObservation: scenario !== 'legacy-204', onEvents: batch => sink.accept(batch) });
  const { socketPath } = connection.descriptor;
  const key = await readFile(connection.descriptor.capabilityPath, 'utf8');
  const module = await senderModule();
  const { eventChannel, createNativeLineObserver, createNormalizerState, createCodexState } = module;
  const statuses: number[] = [], offeredBodies: string[] = [];
  module.useFixtureRequest((options, receive) => request(options, response => { statuses.push(response.statusCode); receive(response); }, body => {
    if (!body.includes('"kind":"cli.observation"')) return undefined;
    offeredBodies.push(body);
    if (scenario === 'unreached') return 'request';
    if (scenario === 'lost-response' && offeredBodies.length === 1) return 'response';
    return undefined;
  }));
  const { default: registry } = await import('../../../src/adapters/core/native-connection/internal/providers.json', { with: { type: 'json' } });
  const { maxEvents, maxEventBytes, eventBatchBytes } = registry.limits;
  const countCap = maxEvents - 1, byteCap = maxEventBytes - 256;
  const sender = eventChannel(socketPath, key), state = createNormalizerState([], Date.now());
  try {
    expect(await call(socketPath, key, ndjson(observation(1)))).toBe(403);
    expect(await call(socketPath, key)).toBe(200);
    expect(await call(socketPath, 'wrong-fixture-capability', ndjson(observation(1)))).toBe(403);
    expect(await call(socketPath, key, 'x'.repeat(eventBatchBytes + 1))).toBe(413);
    const observer = createNativeLineObserver('cursor-agent-stream-json', state, createCodexState(), events => sender.push(events as WorkerEvent[]));
    observer.observe(Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', model: 'fixture-model' })));
    expect(state.sequence).toBe(0);
    observer.flush();
    expect(state.sequence).toBe(1);

    if (scenario === 'queue' || scenario === 'lost-response') {
      sender.push(Array.from({ length: scenario === 'queue' ? 4000 : 12 }, () => unmapped(++state.sequence)));
    }
    if (scenario === 'count' || scenario === 'bytes') {
      await sender.close(state);
      const fill = scenario === 'count' ? Array.from({ length: countCap - 1 }, () => unmapped(++state.sequence))
        : fillOrdinaryBytes(byteCap - connection.statistics().eventBytes, state.sequence + 1);
      state.sequence = fill.at(-1)!.sequence;
      for (let i = 0; i < fill.length; i += 64) expect(await call(socketPath, key, fill.slice(i, i + 64).map(ndjson).join(''))).toBe(204);
      expect(scenario === 'count' ? connection.statistics().events : connection.statistics().eventBytes).toBe(scenario === 'count' ? countCap : byteCap);
      expect(await call(socketPath, key, ndjson(unmapped(state.sequence + 1)))).toBe(429);
      expect(await call(socketPath, key, ndjson(observation(state.sequence)))).toBe(422);
    }
    const liveSender = scenario === 'count' || scenario === 'bytes' ? eventChannel(socketPath, key) : sender;
    if (scenario === 'lost-response') {
      // Bootstrap alone does not establish the producer's start.
      expect(await call(socketPath, key, ndjson(observation(state.sequence + 1)))).toBe(422);
    }
    const usage = observation(++state.sequence);
    if (scenario !== 'no-record') {
      // A schema-invalid offer must leave the sender slot available for the first valid row.
      liveSender.push([{ ...usage, atMs: -1 }, usage]);
    }
    const disposition = await liveSender.close(state);
    const held = connection.protectedObservation?.();
    if (scenario === 'unreached' || scenario === 'no-record' || scenario === 'legacy-204') {
      expect(disposition).toBe(scenario === 'no-record' ? 'none' : 'unconfirmed');
      expect(held).toBeUndefined();
      if (scenario === 'legacy-204') expect(statuses).toEqual([204, 204]);
      else expect(connection.statistics()).toMatchObject({ events: 1, eventsDropped: 0, eventsUnreported: 0, rejected: 3 });
      const closed = await sink.close();
      expect(closed.events.map(row => row.kind)).toEqual(scenario === 'legacy-204' ? ['session.started', 'dropped'] : ['session.started']);
      return;
    }
    if (scenario === 'queue') {
      expect(connection.statistics().events).toBe(4001);
    }
    const forged = workerEventSchema.parse({ schemaVersion: 1, sequence: ++state.sequence, atMs: 0, kind: 'model.verification',
      status: 'verified', admitted: null, observed: [], unexpected: [] });
    const changed = observation(++state.sequence);
    const heldEvent = held!;
    const heldAtMs = heldEvent.atMs;
    const invalid = [ndjson(observation(1)), JSON.stringify({ ...changed, foreignAttempt: 'fixture-other' }) + '\n', ndjson(forged), '{bad json\n'];
    for (const body of invalid) expect(await call(socketPath, key, body)).not.toBe(201);
    expect(await call(socketPath, key, ndjson(changed))).not.toBe(201);
    expect(disposition).toBe('held');
    expect(statuses.filter(status => status === 201)).toEqual([201]);
    expect(held).toMatchObject({ ...usage, observation: { builtinPlugins: { names: [], omitted: 3 } } });
    expect(offeredBodies).toHaveLength(scenario === 'lost-response' ? 2 : 1);
    if (scenario === 'lost-response') expect(offeredBodies[1]).toBe(offeredBodies[0]);
    expect(await call(socketPath, key, offeredBodies[0]!)).toBe(201);
    if (scenario === 'count') expect(connection.statistics().events).toBe(countCap);
    if (scenario === 'bytes') expect(connection.statistics().eventBytes).toBe(byteCap);
    await connection.close();
    const closed = await sink.close();
    if (scenario === 'queue') expect(closed.events.find(row => row.kind === 'dropped' && row.reason === 'event-cap')).toMatchObject({ count: 1 });
    for (const trimmed of [false, true]) {
      // The low ceiling forces the same sealer to trim its prefix.
      const maxBytes = trimmed ? 620 : maxEventBytes + WORKER_EVENT_SEAL_RESERVE_BYTES;
      const artifacts = new FileArtifactStore({ root, maxBytes });
      const identity = attemptIdentitySchema.parse({ scopeId: 'n0-scope', runId: 'n0-run', taskId: 'n0-task', attemptId: scenario, generation: 1, layoutRevision: 'n0-layout' });
      const save = vi.fn(async (row: Parameters<Parameters<typeof sealAttemptWorkerEvents>[2]['saveWorkerEventLog']>[0]) => row);
      expect(await sealAttemptWorkerEvents(identity, artifacts, { saveWorkerEventLog: save }, {
        ...closed, observation: held, maxBytes, verification: null, unreported: connection.statistics().eventsUnreported,
      })).toMatchObject({ status: 'sealed' });
      const receipt = save.mock.calls[0]![0];
      const rows = Buffer.from(await artifacts.read(identity.scopeId, receipt.events)).toString().trimEnd().split('\n')
        .map(line => workerEventSchema.parse(JSON.parse(line)));
      expect(rows.filter(row => row.kind === 'cli.observation')).toEqual([expect.objectContaining({ atMs: heldAtMs, observation: heldEvent.observation })]);
      expect(rows.some(row => row.kind === 'dropped' && row.reason === 'byte-cap')).toBe(trimmed);
    }
  } finally {
    await connection.close();
    await sink.close();
    await unlink(join(root, 'worker.events'));
  }
}, 30_000);
