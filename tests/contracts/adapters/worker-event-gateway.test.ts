import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { get, request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openNativeConnection } from '../../../dist/adapters/core/native-connection/index.js';
import { DockerSupervisor } from '#adapters/index.js';
import type { SandboxRequest } from '#engine/index.js';
import type { WorkerEvent } from '#domain/index.js';

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const roots: string[] = []; const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const access = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, secret: 'claude-access' })).toString('base64url') + '.sig-claude-e2e';
const credential = () => ({ claudeAiOauth: { accessToken: access, refreshToken: 'never-forward', expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'] } });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'dn-ev-')); roots.push(root); return root; }
async function gateway(root: string, received: WorkerEvent[][]) {
  const connection = await openNativeConnection({ binding: { schemaVersion: 1, provider: 'claude' }, directory: root, credential: credential(), deadlineMs: 20000,
    onEvents: events => { received.push([...events]); } });
  closes.push(connection.close); return connection;
}
const call = (socketPath: string, method: 'GET' | 'POST', path: string, body?: string, length?: number) => new Promise<number>((resolve, reject) => {
  const req = (method === 'GET' ? get : request)({ socketPath, path, method, headers: body === undefined ? {} : { 'content-type': 'application/x-ndjson', 'content-length': length ?? Buffer.byteLength(body) } },
    response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
  req.on('error', reject); if (method === 'POST') req.end(body); else req.end();
});
const event = (sequence: number, extra: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 1, sequence, atMs: sequence, kind: 'unmapped', nativeType: 'x', count: 1, ...extra });

it('accepts worker events only after the bootstrap, validates each against the current schema and order, and bounds the request', async () => {
  const received: WorkerEvent[][] = []; const connection = await gateway(await fixture(), received); const socket = connection.descriptor.socketPath;
  expect(await call(socket, 'POST', '/events', event(1) + '\n')).toBe(403);
  expect(await call(socket, 'GET', '/bootstrap')).toBe(200);
  expect(await call(socket, 'POST', '/events', [event(1), event(2)].join('\n') + '\n')).toBe(204);
  expect(await call(socket, 'POST', '/events', [event(2), '{bad json', event(3, { kind: 'forged-kind' }), event(4)].join('\n') + '\n')).toBe(204);
  expect(await call(socket, 'POST', '/events', 'x', 300_000)).toBe(413);
  const flat = received.flat();
  expect(flat.map(item => [item.sequence, item.kind])).toEqual([[1, 'unmapped'], [2, 'unmapped'], [4, 'unmapped'], [5, 'dropped']]);
  expect(flat.at(-1)).toMatchObject({ kind: 'dropped', reason: 'invalid', count: 3 });
  expect(connection.statistics()).toMatchObject({ events: 3, eventsDropped: 3 });
});

describe.skipIf(!imageId)('real container bridge to gateway event stream', () => {
  it('normalizes a native Claude stream inside Docker, redacts the credential and delivers ordered contract events to the host', async () => {
    const root = await fixture(); const workspace = join(root, 'work'); await mkdir(workspace);
    const stream = (await readFile(new URL('../../fixtures/worker-events/claude-stream.jsonl', import.meta.url), 'utf8')).split('\n').filter(Boolean);
    // The native process echoes its own credential into assistant text and a shell command; neither may leave the container.
    stream.splice(8, 0, JSON.stringify({ type: 'assistant', message: { id: 'leak', content: [{ type: 'text', text: `token ${access}` },
      { type: 'tool_use', id: 'leak-tool', name: 'Bash', input: { command: `echo ${access}`, description: `send ${access}` } }] } }));
    await writeFile(join(workspace, 'native.jsonl'), stream.join('\n') + '\n');
    const received: WorkerEvent[][] = []; const connection = await gateway(root, received);
    const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
      logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 536870912, pids: 128, cpus: 1, tmpBytes: 67108864, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536,
      connection: connection.descriptor });
    const sandbox: SandboxRequest = { protocolVersion: 1, identity: { runId: 'run', taskId: 'task', attemptId: randomUUID(), scopeId: 'test', generation: 1, layoutRevision: 'layout' },
      workspace, argv: ['node', '-e', "process.stdout.write(require('node:fs').readFileSync('/workspace/native.jsonl','utf8'))"] };
    closes.push(async () => { await supervisor.cancel(sandbox); await supervisor.release(sandbox); });
    const result = await supervisor.execute(sandbox);
    expect(result.result).toEqual({ kind: 'exited', exitCode: 0 });
    const events = received.flat();
    expect(events.map(item => item.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events[0]).toMatchObject({ kind: 'session.started', provider: 'claude' });
    expect(events.find(item => item.kind === 'session.ended')).toMatchObject({ outcome: 'success', turns: 4 });
    expect(events.filter(item => item.kind === 'tool.call').map(item => item.kind === 'tool.call' && item.name).sort()).toEqual(['Bash', 'Bash', 'Read', 'Write']);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(access); expect(serialized).not.toContain('claude-access'); expect(serialized).toContain('[REDACTED]');
    expect(result.stdout).not.toContain(access);
    expect(connection.statistics()).toMatchObject({ eventsDropped: 0 });
  });
});
