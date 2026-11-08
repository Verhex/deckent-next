import { readLocalOsOwner } from '#adapters/index.js';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { get, request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { openNativeConnection, readLocalNativeCredential } from '../../../dist/adapters/core/native-connection/index.js';
import { INPUT_VALIDATION_LIMITS } from '#platform/core/common/index.js';
import type { WorkerEvent } from '#domain/index.js';

const roots: string[] = []; const closes: (() => Promise<void>)[] = [];
const capabilities = new Map<string, string>();
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const access = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, secret: 'claude-access' })).toString('base64url') + '.sig-claude-e2e';
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'dn-ev-')); roots.push(root); return root; }
// Owner 2026-11-08: Claude has no Docker gateway; the provider-neutral gateway checks run on Cursor's projected token.
async function gateway(root: string, received: WorkerEvent[][]) {
  const connection = await openNativeConnection({ principal: readLocalOsOwner(), binding: { schemaVersion: 1, provider: 'cursor' }, directory: root, credential: { accessToken: access }, deadlineMs: 20000,
    onEvents: events => { received.push([...events]); } });
  closes.push(connection.close);
  // A real worker presents the per-attempt capability it receives through its private mount (RC-S1).
  capabilities.set(connection.descriptor.socketPath, await readFile(connection.descriptor.capabilityPath, 'utf8'));
  return connection;
}
const call = (socketPath: string, method: 'GET' | 'POST', path: string, body?: string, length?: number) => new Promise<number>((resolve, reject) => {
  const authorization = capabilities.get(socketPath);
  const headers = { ...(authorization ? { authorization } : {}), ...(body === undefined ? {} : { 'content-type': 'application/x-ndjson', 'content-length': length ?? Buffer.byteLength(body) }) };
  const req = (method === 'GET' ? get : request)({ socketPath, path, method, headers },
    response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
  req.on('error', reject); if (method === 'POST') req.end(body); else req.end();
});
const event = (sequence: number, extra: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 1, sequence, atMs: sequence, kind: 'unmapped', nativeType: 'x', count: 1, ...extra });

describe.skipIf(process.platform === 'win32')('requires POSIX private native gateway ownership; NATIVE_CONNECTION_UNAVAILABLE', () => {
it('accepts worker events only after the bootstrap, validates each against the current schema and order, and bounds the request', async () => {
  const received: WorkerEvent[][] = []; const connection = await gateway(await fixture(), received); const socket = connection.descriptor.socketPath;
  expect(await call(socket, 'POST', '/events', event(1) + '\n')).toBe(403);
  expect(await call(socket, 'GET', '/bootstrap')).toBe(200);
  const hostile = JSON.stringify({ kind: 'model.verification', schemaVersion: 2, observed: Array(INPUT_VALIDATION_LIMITS.worker.maxNodes).fill(0) });
  expect(await call(socket, 'POST', '/events', hostile + '\n')).toBe(413);
  expect(received).toEqual([]); expect(connection.statistics()).toMatchObject({ events: 0, rejected: 2 });
  expect(await call(socket, 'POST', '/events', [event(1), event(2)].join('\n') + '\n')).toBe(204);
  expect(await call(socket, 'POST', '/events', [event(2), '{bad json', event(3, { kind: 'forged-kind' }), event(4)].join('\n') + '\n')).toBe(204);
  expect(await call(socket, 'POST', '/events', 'x', 300_000)).toBe(413);
  const flat = received.flat();
  expect(flat.map(item => [item.sequence, item.kind])).toEqual([[1, 'unmapped'], [2, 'unmapped'], [4, 'unmapped'], [5, 'dropped']]);
  expect(flat.at(-1)).toMatchObject({ kind: 'dropped', reason: 'invalid', count: 3 });
  // The loss marker is charged to the same event budget as worker events (3 events + 1 marker).
  expect(connection.statistics()).toMatchObject({ events: 4, eventsDropped: 3, eventsUnreported: 0,
    eventBytes: Buffer.byteLength(flat.map(value => JSON.stringify(value) + '\n').join('')) });
});

it('scrubs credential values and secret shapes from schema-valid events a worker posts directly (host-side guard)', async () => {
  const received: WorkerEvent[][] = []; const connection = await gateway(await fixture(), received); const socket = connection.descriptor.socketPath;
  expect(await call(socket, 'GET', '/bootstrap')).toBe(200);
  const hostile = JSON.stringify({ schemaVersion: 1, sequence: 1, atMs: 1, kind: 'tool.call', toolId: 'x', name: 'Write', toolClass: 'write',
    target: `leak-${access}.txt`, detail: 'Authorization: Bearer abc.def.ghi' });
  expect(await call(socket, 'POST', '/events', hostile + '\n')).toBe(204);
  const serialized = JSON.stringify(received.flat());
  expect(serialized).not.toContain(access); expect(serialized).not.toContain('abc.def.ghi'); expect(serialized).toContain('[REDACTED]');
  // Retention charges exactly the scrubbed NDJSON, including its newline, rather than the untrusted input bytes.
  expect(connection.statistics().eventBytes).toBe(Buffer.byteLength(received.flat().map(value => JSON.stringify(value) + '\n').join('')));
});

it('charges loss markers to the event budget and refuses further batches once it is spent, without growing the sink', async () => {
  const received: WorkerEvent[][] = []; const connection = await gateway(await fixture(), received); const socket = connection.descriptor.socketPath;
  expect(await call(socket, 'GET', '/bootstrap')).toBe(200);
  let sequence = 0;
  const batch = (count: number) => Array.from({ length: count }, () => event(++sequence)).join('\n') + '\n';
  for (let sent = 0; sent < 5_200; sent += 1_000) await call(socket, 'POST', '/events', batch(1_000));
  const statuses: number[] = [];
  for (let i = 0; i < 50; i++) statuses.push(await call(socket, 'POST', '/events', '{bad json\n'));
  expect(statuses.every(status => status === 429)).toBe(true);
  const total = received.flat().length, stats = connection.statistics();
  expect(total).toBeLessThanOrEqual(4_999);
  expect(stats.events).toBe(total);
  expect(stats.eventsUnreported).toBeGreaterThanOrEqual(50);
});

// Owner 2026-11-08: no Claude stream reaches a Docker gateway any more. The floor: the typed refusal comes before any login read, credential projection,
// socket or container (a read would fail NATIVE_CREDENTIAL_UNAVAILABLE on the absent login, a projection of the empty credential likewise).
it('a Claude Docker gateway is refused with NATIVE_DOCKER_SUBSCRIPTION_UNAVAILABLE before any login read, projection, socket or container', async () => {
  const root = await fixture(), refused = { code: 'NATIVE_DOCKER_SUBSCRIPTION_UNAVAILABLE' };
  await expect(readLocalNativeCredential('claude', { HOME: join(root, 'absent-home') })).rejects.toMatchObject(refused);
  await expect(openNativeConnection({ binding: { schemaVersion: 1, provider: 'claude' }, directory: root, credential: {}, deadlineMs: 20000 })).rejects.toMatchObject(refused);
  expect(await readdir(root)).toEqual([]);
});

// Owner 2026-11-08: Claude has no Docker gateway, so the forged-verdict custody is held on Codex (client-reported evidence) with the same rules.
it('refuses a worker-forged model verdict and derives the host verdict from accepted events against the admitted model (WORKER-CURRENCY-1)', async () => {
  const received: WorkerEvent[][] = []; const root = await fixture();
  const connection = await openNativeConnection({ principal: readLocalOsOwner(), binding: { schemaVersion: 2, provider: 'codex', model: { channelId: 'codex-cli-subscription',
    modelId: 'gpt-6.1-sol', auxiliaryModelIds: [] } }, directory: root, credential: { tokens: { access_token: access, id_token: 'fixture-id' } }, deadlineMs: 20000,
  onEvents: events => { received.push([...events]); } });
  closes.push(connection.close); const socket = connection.descriptor.socketPath;
  capabilities.set(socket, await readFile(connection.descriptor.capabilityPath, 'utf8'));
  expect(await call(socket, 'GET', '/bootstrap')).toBe(200);
  expect(connection.modelVerification()).toBeNull();
  const started = JSON.stringify({ schemaVersion: 1, sequence: 1, atMs: 1, kind: 'session.started', provider: 'codex', model: 'gpt-6-luna', cliVersion: '0.167.0' });
  const forged = JSON.stringify({ schemaVersion: 1, sequence: 2, atMs: 2, kind: 'model.verification', status: 'verified', admitted: 'gpt-6.1-sol', observed: [], unexpected: [] });
  const ended = JSON.stringify({ schemaVersion: 1, sequence: 3, atMs: 3, kind: 'session.ended', outcome: 'success', turns: 1, durationMs: 3, apiDurationMs: null,
    costUsd: null, costBasis: null, tokens: null, permissionDenials: 0, models: ['gpt-6-luna', 'gpt-6.1-sol'] });
  expect(await call(socket, 'POST', '/events', [started, forged, ended].join('\n') + '\n')).toBe(204);
  expect(received.flat().map(item => item.kind)).toEqual(['session.started', 'session.ended', 'dropped']);
  expect(connection.modelVerification()).toEqual({ status: 'client-reported-mismatch', admitted: 'gpt-6.1-sol', evidenceCapability: 'client-reported',
    observed: ['gpt-6-luna', 'gpt-6.1-sol'], unexpected: ['gpt-6-luna'] });
});

});
