import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { get, request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openNativeConnection } from '#adapters/core/native-connection/index.js';
import { createHash, randomUUID } from 'node:crypto';
import { transform } from 'esbuild';
import { DockerSupervisor } from '#adapters/core/docker-supervisor/index.js';
import type { SandboxRequest } from '#engine/index.js';
import { nativeCliCommand } from '#adapters/core/native-coding/index.js';

// Source integration: the gateway hashes the mounted artifact; no build/dist candidate is used.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: (path: Parameters<typeof actual.readFile>[0], ...args: unknown[]) => actual.readFile(typeof path === 'string' && path.endsWith('/native-connection/internal/worker.js') ? path.slice(0, -3) + '.ts' : path, ...args as []) };
});
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const fetchBootstrap = (socketPath: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
  const req = get({ socketPath, path: '/bootstrap' }, response => { let body = ''; response.setEncoding('utf8'); response.on('data', part => { body += part; }); response.on('end', () => resolve(JSON.parse(body))); });
  req.on('error', reject);
});
const ended = JSON.stringify({ schemaVersion: 1, sequence: 2, atMs: 2, kind: 'session.ended', outcome: 'success', turns: 1, durationMs: 1,
  apiDurationMs: null, costUsd: null, costBasis: null, tokens: null, permissionDenials: 0, models: ['fixture-model'] });
const post = (socketPath: string, provider: string) => new Promise<void>((resolve, reject) => {
  const body = JSON.stringify({ schemaVersion: 1, sequence: 1, atMs: 1, kind: 'session.started', provider, model: 'fixture-model', cliVersion: null }) + '\n' + ended;
  const req = request({ socketPath, path: '/events', method: 'POST', headers: { 'content-length': Buffer.byteLength(body) } }, response => { response.resume(); response.on('end', resolve); });
  req.on('error', reject); req.end(body);
});

const access = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.fixture-signature';
it.each([
  ['claude', { claudeAiOauth: { accessToken: access, expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'] } }, 'session-events', 'verified'],
  ['codex', { auth_mode: 'chatgpt', tokens: { access_token: access, refresh_token: 'fixture-refresh', id_token: 'fixture-id' }, last_refresh: new Date().toISOString() }, 'none', 'unverified'],
  ['cursor', { accessToken: access }, 'none', 'unverified'],
] as const)('projects bound %s registry capabilities and host model-evidence custody through the real UNIX gateway', async (provider, credential, evidenceCapability, status) => {
  const root = await mkdtemp(join(tmpdir(), 'dn-cap-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const connection = await openNativeConnection({ binding: { schemaVersion: 2, provider,
    model: { channelId: `${provider}-cli-subscription`, modelId: 'fixture-model', auxiliaryModelIds: [] } }, directory: root, credential, deadlineMs: 10000 });
  cleanups.push(connection.close);
  const bootstrap = await fetchBootstrap(connection.descriptor.socketPath);
  expect(bootstrap.capabilities).toEqual(nativeCliCommand(provider).capabilities);
  expect((bootstrap.capabilities as Record<string, unknown>).modelUsageEvidence).toBe(evidenceCapability);
  await post(connection.descriptor.socketPath, provider);
  expect(connection.modelVerification()).toEqual({ status, admitted: 'fixture-model', observed: ['fixture-model'], unexpected: [], evidenceCapability });
});


const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
describe.skipIf(!imageId)('candidate standalone bootstrap through the real pinned Docker worker', () => {
  it.each([
    ['claude', { claudeAiOauth: { accessToken: access, expiresAt: Date.now() + 3_600_000 } }],
    ['codex', { tokens: { access_token: access, id_token: 'fixture-id' } }],
    ['cursor', { accessToken: access }],
  ] as const)('%s receives the registry prompt channel, preflight, turn probe and structured-report flag', async (provider, credential) => {
    const root = await mkdtemp(join(tmpdir(), 'dn-main-cap-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'work'); await mkdir(workspace);
    // Test-only transpilation of this exact candidate; no product build or dist artifact is used.
    const source = await readFile(new URL('../../../src/adapters/core/native-connection/internal/worker.ts', import.meta.url), 'utf8');
    const artifact = await transform(source, { loader: 'ts', format: 'esm', target: 'node24' });
    const bootstrapPath = join(root, 'bootstrap.mjs'); await writeFile(bootstrapPath, artifact.code, { mode: 0o600 });
    const command = nativeCliCommand(provider), capabilities = command.capabilities;
    const requiredFlags = [...command.args.filter(flag => flag.startsWith('--')), ...command.coreArgs.filter(flag => flag.startsWith('--')), command.modelFlag,
      ...(capabilities.maxTurns ? [capabilities.maxTurns.flag] : [])];
    const help = [...requiredFlags.filter(flag => flag !== capabilities.maxTurns?.flag), ...(capabilities.structuredReport ? [capabilities.structuredReport.flag] : [])].join(' ');
    const fake = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
if (argv.includes('--version')) process.stdout.write('fixture-1');
else if (argv.includes('--help')) process.stdout.write(${JSON.stringify(help)});
else if (argv.includes('invalid')) { process.stderr.write(${JSON.stringify(capabilities.maxTurns?.hiddenHelpProbe?.refusal ?? '')}); process.exitCode = 1; }
else writeFileSync('/workspace/capture.json', JSON.stringify({ argv, core: readFileSync('/tmp/deckent-prompt/core.txt','utf8'),
  reportFile: ${capabilities.structuredReport?.channel === 'schema-file' ? "readFileSync('/tmp/deckent-report-schema.json','utf8')" : 'null'} }));
`;
    const executable = join(workspace, 'native-cli'); await writeFile(executable, fake); await chmod(executable, 0o700);
    const argv = ['/workspace/native-cli', ...command.args, ...command.coreArgs, command.modelFlag, 'fixture-model',
      ...(capabilities.maxTurns ? [capabilities.maxTurns.flag, '7'] : []), '--', '__DECKENT_TASK_PROMPT__'];
    const segments = (['core', 'persona', 'task', 'scope'] as const).map(kind => ({ kind, id: kind, version: 1, sha256: hash(kind) }));
    const body = { schemaVersion: 1 as const, channel: capabilities.promptChannel, core: 'Fixture core', task: 'Fixture task', segments };
    const connection = await openNativeConnection({ binding: { schemaVersion: 1, provider, finalReport: { schemaVersion: 1 },
      preflight: { schemaVersion: 1, cliVersion: 'fixture-1', discovery: 'repository', helpArgs: command.helpArgs, requiredFlags },
      promptDelivery: { ...body, sha256: hash(JSON.stringify(body)), argvSha256: hash(JSON.stringify(argv)) } },
    directory: root, credential, deadlineMs: 20000 });
    cleanups.push(connection.close);
    const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
      logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 536870912, pids: 128, cpus: 1, tmpBytes: 67108864, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536,
      connection: { ...connection.descriptor, bootstrapPath, bootstrapSha256: hash(artifact.code) } });
    const sandbox: SandboxRequest = { protocolVersion: 1, identity: { runId: 'run', taskId: 'task', attemptId: randomUUID(), scopeId: 'test', generation: 1, layoutRevision: 'layout' }, workspace, argv };
    cleanups.push(async () => { await supervisor.cancel(sandbox); await supervisor.release(sandbox); });
    const result = await supervisor.execute(sandbox);
    expect(result.result).toEqual({ kind: 'exited', exitCode: 0 });
    const capture = JSON.parse(await readFile(join(workspace, 'capture.json'), 'utf8')) as { argv: string[]; core: string; reportFile: string | null };
    expect(capture.core).toBe(body.core);
    expect(capture.argv.at(-1)).toBe(capabilities.promptChannel === 'inline' ? body.core + '\n\n' + body.task : body.task);
    if (capabilities.promptChannel === 'claude-system-prompt') expect(capture.argv[capture.argv.indexOf('--system-prompt') + 1]).toBe(body.core);
    if (capabilities.structuredReport) {
      const value = capture.argv[capture.argv.indexOf(capabilities.structuredReport.flag) + 1];
      expect(value).toEqual(capabilities.structuredReport.channel === 'schema-file' ? '/tmp/deckent-report-schema.json' : expect.any(String));
      expect(JSON.parse(capture.reportFile ?? value!)).toMatchObject({ type: 'object', properties: { schemaVersion: { const: 1 } } });
    } else expect(capture.argv).toEqual([...argv.slice(1, -1), body.core + '\n\n' + body.task]);
    expect(result.stdout).toContain('native-prompt-delivery');
  });
});
