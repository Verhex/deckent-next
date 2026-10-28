import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
  const req = get({ socketPath, path: '/bootstrap', headers: { authorization: readFileSync(join(dirname(socketPath), 'bootstrap.key'), 'utf8') } }, response => { let body = ''; response.setEncoding('utf8'); response.on('data', part => { body += part; }); response.on('end', () => resolve(JSON.parse(body))); });
  req.on('error', reject);
});
const ended = JSON.stringify({ schemaVersion: 1, sequence: 2, atMs: 2, kind: 'session.ended', outcome: 'success', turns: 1, durationMs: 1,
  apiDurationMs: null, costUsd: null, costBasis: null, tokens: null, permissionDenials: 0, models: ['fixture-model'] });
const post = (socketPath: string, provider: string) => new Promise<void>((resolve, reject) => {
  const body = JSON.stringify({ schemaVersion: 1, sequence: 1, atMs: 1, kind: 'session.started', provider, model: 'fixture-model', cliVersion: null }) + '\n' + ended;
  const req = request({ socketPath, path: '/events', method: 'POST', headers: { authorization: readFileSync(join(dirname(socketPath), 'bootstrap.key'), 'utf8'), 'content-length': Buffer.byteLength(body) } }, response => { response.resume(); response.on('end', resolve); });
  req.on('error', reject); req.end(body);
});

const access = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.fixture-signature';
it.for([
  ['claude', { claudeAiOauth: { accessToken: access, expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'] } }, 'session-events', 'verified'],
  // Codex: the client's own session log names the model (owner Q4 2026-10-23); the name equals the admitted exact id.
  ['codex', { auth_mode: 'chatgpt', tokens: { access_token: access, refresh_token: 'fixture-refresh', id_token: 'fixture-id' }, last_refresh: new Date().toISOString() }, 'client-reported', 'client-reported'],
  // Cursor reports only a start name; this pin carries no catalog names, so the reported name is unrecorded: unverified (owner K1 2026-10-22).
  ['cursor', { accessToken: access }, 'session-start-name', 'unverified'],
] as const)('projects bound %s registry capabilities and host model-evidence custody through the real UNIX gateway', async ([provider, credential, evidenceCapability, status], context) => {
  const root = await mkdtemp(join(tmpdir(), 'dn-cap-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const input = { binding: { schemaVersion: 2 as const, provider,
    model: { channelId: `${provider}-cli-subscription`, modelId: 'fixture-model', auxiliaryModelIds: [] } }, directory: root, credential, deadlineMs: 10000 };
  if (process.platform === 'win32') {
    await expect(openNativeConnection(input)).rejects.toMatchObject({ code: 'NATIVE_CONNECTION_UNAVAILABLE' });
    expect(await readdir(root)).toEqual([]);
    context.skip('NATIVE_CONNECTION_UNAVAILABLE: private UNIX gateway requires POSIX ownership and socket permissions');
  }
  const connection = await openNativeConnection(input);
  cleanups.push(connection.close);
  const bootstrap = await fetchBootstrap(connection.descriptor.socketPath);
  expect(bootstrap.capabilities).toEqual(nativeCliCommand(provider).capabilities);
  expect((bootstrap.capabilities as Record<string, unknown>).modelUsageEvidence).toBe(evidenceCapability);
  await post(connection.descriptor.socketPath, provider);
  expect(connection.modelVerification()).toEqual({ status, admitted: 'fixture-model', observed: ['fixture-model'], unexpected: [], evidenceCapability });
});
it.for([
  [{ reportedNames: ['fixture-model'] }, 'start-name-matched', []],
  [{ otherReportedNames: ['fixture-model'] }, 'substituted', ['fixture-model']],
  [{ reportedNames: ['Auto'], providerChosen: true }, 'provider-chosen', []],
] as const)('seals the frozen pin catalog start-name evidence %j through the real UNIX gateway (owner K1/K2 2026-10-22)', async ([evidence, status, unexpected], context) => {
  if (process.platform === 'win32') context.skip('NATIVE_CONNECTION_UNAVAILABLE: private UNIX gateway requires POSIX ownership and socket permissions');
  const root = await mkdtemp(join(tmpdir(), 'dn-cap-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const connection = await openNativeConnection({ binding: { schemaVersion: 2 as const, provider: 'cursor',
    model: { channelId: 'cursor-cli-subscription', modelId: 'fixture-model', auxiliaryModelIds: [], ...evidence } }, directory: root, credential: { accessToken: access }, deadlineMs: 10000 });
  cleanups.push(connection.close);
  await fetchBootstrap(connection.descriptor.socketPath);
  await post(connection.descriptor.socketPath, 'cursor');
  expect(connection.modelVerification()).toEqual({ status, admitted: 'fixture-model', observed: ['fixture-model'], unexpected, evidenceCapability: 'session-start-name' });
});

it('keeps the first session start for the host verdict: a later start cannot replace the reported model (alpha.54 CX)', async context => {
  if (process.platform === 'win32') context.skip('NATIVE_CONNECTION_UNAVAILABLE: private UNIX gateway requires POSIX ownership and socket permissions');
  const root = await mkdtemp(join(tmpdir(), 'dn-cap-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const connection = await openNativeConnection({ binding: { schemaVersion: 2 as const, provider: 'codex',
    model: { channelId: 'codex-cli-subscription', modelId: 'fixture-model', auxiliaryModelIds: [] } }, directory: root,
    credential: { tokens: { access_token: access, id_token: 'fixture-id' } }, deadlineMs: 10000 });
  cleanups.push(connection.close);
  await fetchBootstrap(connection.descriptor.socketPath);
  const start = (sequence: number, model: string) => JSON.stringify({ schemaVersion: 1, sequence, atMs: sequence, kind: 'session.started', provider: 'codex', model, cliVersion: null });
  const body = [start(1, 'other-model'), start(2, 'fixture-model'), ended.replace('"sequence":2', '"sequence":3')].join('\n') + '\n';
  await new Promise<void>((resolve, reject) => {
    const req = request({ socketPath: connection.descriptor.socketPath, path: '/events', method: 'POST', headers: { authorization: readFileSync(join(dirname(connection.descriptor.socketPath), 'bootstrap.key'), 'utf8'), 'content-length': Buffer.byteLength(body) } }, response => { response.resume(); response.on('end', resolve); });
    req.on('error', reject); req.end(body);
  });
  expect(connection.modelVerification()).toMatchObject({ status: 'client-reported-mismatch', unexpected: ['other-model'], evidenceCapability: 'client-reported' });
});

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
describe('candidate standalone bootstrap through the real pinned Docker worker', () => {
  it.for([
    ['claude', { claudeAiOauth: { accessToken: access, expiresAt: Date.now() + 3_600_000 } }],
    ['codex', { tokens: { access_token: access, id_token: 'fixture-id' } }],
    ['cursor', { accessToken: access }],
  ] as const)('%s receives the registry prompt channel, preflight, turn probe and structured-report flag', async ([provider, credential], context) => {
    if (process.platform === 'win32') context.skip('NATIVE_CONNECTION_UNAVAILABLE: Docker bootstrap requires the POSIX private UNIX gateway');
    if (!imageId) context.skip('DOCKER_TEST_IMAGE_UNAVAILABLE: pinned DECKENT_TEST_DOCKER_IMAGE fixture is not configured');
    const root = await mkdtemp(join(tmpdir(), 'dn-main-cap-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'work'); await mkdir(workspace);
    // Test-only transpilation of this exact candidate; no product build or dist artifact is used.
    const source = await readFile(new URL('../../../src/adapters/core/native-connection/internal/worker.ts', import.meta.url), 'utf8');
    const artifact = await transform(source, { loader: 'ts', format: 'esm', target: 'node24' });
    const bootstrapPath = join(root, 'bootstrap.mjs'); await writeFile(bootstrapPath, artifact.code, { mode: 0o600 });
    const command = nativeCliCommand(provider), capabilities = command.capabilities;
    const requiredFlags = [...command.args.filter(flag => flag.startsWith('--')), ...command.coreArgs.filter(flag => flag.startsWith('--')), command.modelFlag,
      ...(capabilities.maxTurns ? [capabilities.maxTurns.flag] : [])];
    const help = [...requiredFlags.filter(flag => flag !== capabilities.maxTurns?.flag), ...(capabilities.structuredReport?.flag ? [capabilities.structuredReport.flag] : [])].join(' ');
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
    const prompt = capabilities.promptChannel === 'inline' ? body.core + '\n\n' + body.task : body.task;
    // The flagless final-text-json channel appends its instruction and one-line schema to the prompt; flag channels leave it exact.
    const instruction = capabilities.structuredReport?.channel === 'final-text-json' ? capture.argv.at(-1)!.slice(prompt.length) : '';
    expect(capture.argv.at(-1)).toBe(prompt + instruction);
    if (instruction) {
      expect(instruction.startsWith('\n\n### report:final-text-json@1\n')).toBe(true);
      expect(JSON.parse(instruction.split('\n').at(-1)!)).toMatchObject({ type: 'object', properties: { schemaVersion: { const: 1 } } });
    }
    if (capabilities.promptChannel === 'claude-system-prompt') expect(capture.argv[capture.argv.indexOf('--system-prompt') + 1]).toBe(body.core);
    if (capabilities.structuredReport?.flag) {
      const value = capture.argv[capture.argv.indexOf(capabilities.structuredReport.flag) + 1];
      expect(value).toEqual(capabilities.structuredReport.channel === 'schema-file' ? '/tmp/deckent-report-schema.json' : expect.any(String));
      expect(JSON.parse(capture.reportFile ?? value!)).toMatchObject({ type: 'object', properties: { schemaVersion: { const: 1 } } });
    } else expect(capture.argv).toEqual([...argv.slice(1, -1), body.core + '\n\n' + body.task + instruction]);
    expect(result.stdout).toContain('native-prompt-delivery');
  });
  // C1 (owner 2026-10-23 Q2): disabled discovery runs every registered hidden probe in the real bootstrap before credentials or the task;
  // a CLI that accepts the probe value (it would silently ignore the suppression key) stops at preflight (78) and never runs the task.
  it.for([['codex', true], ['codex', false]] as const)('%s disabled discovery: hidden probes refused as registered = %s', async ([provider, refuses], context) => {
    if (process.platform === 'win32') context.skip('NATIVE_CONNECTION_UNAVAILABLE: Docker bootstrap requires the POSIX private UNIX gateway');
    if (!imageId) context.skip('DOCKER_TEST_IMAGE_UNAVAILABLE: pinned DECKENT_TEST_DOCKER_IMAGE fixture is not configured');
    const root = await mkdtemp(join(tmpdir(), 'dn-disc-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'work'); await mkdir(workspace);
    const source = await readFile(new URL('../../../src/adapters/core/native-connection/internal/worker.ts', import.meta.url), 'utf8');
    const artifact = await transform(source, { loader: 'ts', format: 'esm', target: 'node24' });
    const bootstrapPath = join(root, 'bootstrap.mjs'); await writeFile(bootstrapPath, artifact.code, { mode: 0o600 });
    const command = nativeCliCommand(provider), capabilities = command.capabilities, discovery = capabilities.discovery!;
    const requiredFlags = [...command.args.filter(flag => flag.startsWith('--')), ...discovery.requiredFlags, ...command.coreArgs.filter(flag => flag.startsWith('--')), command.modelFlag];
    const help = [...requiredFlags, ...(capabilities.structuredReport?.flag ? [capabilities.structuredReport.flag] : [])].join(' ');
    const probes = Object.fromEntries(discovery.hiddenProbes.map(probe => [JSON.stringify(probe.args), probe.refusal]));
    const fake = `#!/usr/bin/env node
import { writeFileSync, appendFileSync } from 'node:fs';
const argv = process.argv.slice(2), probes = ${JSON.stringify(probes)}, key = JSON.stringify(argv);
if (argv.includes('--version')) process.stdout.write('fixture-1');
else if (argv.includes('--help')) process.stdout.write(${JSON.stringify(help)});
else if (key in probes) { appendFileSync('/workspace/probes.log', key + '\\n'); if (${refuses}) { process.stderr.write('Error loading config.toml: invalid type: string, ' + probes[key] + '\\n'); process.exitCode = 1; } }
else writeFileSync('/workspace/capture.json', JSON.stringify({ argv }));
`;
    await writeFile(join(workspace, 'native-cli'), fake); await chmod(join(workspace, 'native-cli'), 0o700);
    const argv = ['/workspace/native-cli', ...command.args, ...command.disabledArgs!, ...command.coreArgs, command.modelFlag, 'fixture-model', '--', '__DECKENT_TASK_PROMPT__'];
    const body = { schemaVersion: 1 as const, channel: capabilities.promptChannel, core: 'Fixture core', task: 'Fixture task',
      segments: (['core', 'persona', 'task', 'scope'] as const).map(kind => ({ kind, id: kind, version: 1, sha256: hash(kind) })) };
    const connection = await openNativeConnection({ binding: { schemaVersion: 1, provider, preflight: { schemaVersion: 1, cliVersion: 'fixture-1', discovery: 'disabled', helpArgs: command.helpArgs, requiredFlags },
      promptDelivery: { ...body, sha256: hash(JSON.stringify(body)), argvSha256: hash(JSON.stringify(argv)) } }, directory: root, credential: { tokens: { access_token: access, id_token: 'fixture-id' } }, deadlineMs: 20000 });
    cleanups.push(connection.close);
    const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
      logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 536870912, pids: 128, cpus: 1, tmpBytes: 67108864, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536,
      connection: { ...connection.descriptor, bootstrapPath, bootstrapSha256: hash(artifact.code) } });
    const sandbox: SandboxRequest = { protocolVersion: 1, identity: { runId: 'run', taskId: 'task', attemptId: randomUUID(), scopeId: 'test', generation: 1, layoutRevision: 'layout' }, workspace, argv };
    cleanups.push(async () => { await supervisor.cancel(sandbox); await supervisor.release(sandbox); });
    const result = await supervisor.execute(sandbox);
    const probed = (await readFile(join(workspace, 'probes.log'), 'utf8')).trim().split('\n');
    if (refuses) {
      expect(result.result).toEqual({ kind: 'exited', exitCode: 0 });
      expect(probed).toEqual(discovery.hiddenProbes.map(probe => JSON.stringify(probe.args)));
      const capture = JSON.parse(await readFile(join(workspace, 'capture.json'), 'utf8')) as { argv: string[] };
      const at = capture.argv.indexOf(command.disabledArgs![0]!);
      expect(capture.argv.slice(at, at + command.disabledArgs!.length)).toEqual(command.disabledArgs);
    } else {
      expect(result.result).toEqual({ kind: 'exited', exitCode: 78 });
      expect(result.stdout).toContain('"failure":"preflight"');
      expect(probed).toEqual([JSON.stringify(discovery.hiddenProbes[0]!.args)]);
      await expect(readFile(join(workspace, 'capture.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
  // Owner Q4 2026-10-23: inside the real container the bootstrap reads the Codex client's own session log under the worker HOME and the host
  // seals a client-reported verdict; only the model and client version leave the container.
  it.for([['fixture-model', 'client-reported', []], ['other-model', 'client-reported-mismatch', ['other-model']]] as const)(
    'codex session log naming %s seals %s through the real pinned Docker worker', async ([logged, status, unexpected], context) => {
    if (process.platform === 'win32') context.skip('NATIVE_CONNECTION_UNAVAILABLE: Docker bootstrap requires the POSIX private UNIX gateway');
    if (!imageId) context.skip('DOCKER_TEST_IMAGE_UNAVAILABLE: pinned DECKENT_TEST_DOCKER_IMAGE fixture is not configured');
    const root = await mkdtemp(join(tmpdir(), 'dn-codex-log-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'work'); await mkdir(workspace);
    const source = await readFile(new URL('../../../src/adapters/core/native-connection/internal/worker.ts', import.meta.url), 'utf8');
    const artifact = await transform(source, { loader: 'ts', format: 'esm', target: 'node24' });
    const bootstrapPath = join(root, 'bootstrap.mjs'); await writeFile(bootstrapPath, artifact.code, { mode: 0o600 });
    const thread = '00000000-0000-4000-8000-000000000001';
    const fake = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
const day = process.env.HOME + '/.codex/sessions/2026/10/23'; mkdirSync(day, { recursive: true });
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: '${thread}' }) + '\\n');
writeFileSync(day + '/rollout-2026-10-23T04-17-57-${thread}.jsonl', [JSON.stringify({ type: 'session_meta', payload: { cli_version: '0.163.0', base_instructions: { text: 'secret-free' } } }),
  JSON.stringify({ type: 'turn_context', payload: { model: '${logged}', cwd: '/workspace', approval_policy: 'never' } })].join('\\n') + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');
setTimeout(() => process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 60, output_tokens: 10 } }) + '\\n'), 300);
`;
    await writeFile(join(workspace, 'native-cli'), fake); await chmod(join(workspace, 'native-cli'), 0o700);
    const events: Record<string, unknown>[] = [];
    const connection = await openNativeConnection({ binding: { schemaVersion: 2 as const, provider: 'codex',
      model: { channelId: 'codex-cli-subscription', modelId: 'fixture-model', auxiliaryModelIds: [] } }, directory: root,
      credential: { tokens: { access_token: access, id_token: 'fixture-id' } }, deadlineMs: 20000, onEvents: batch => events.push(...batch) });
    cleanups.push(connection.close);
    const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
      logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 536870912, pids: 128, cpus: 1, tmpBytes: 67108864, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536,
      connection: { ...connection.descriptor, bootstrapPath, bootstrapSha256: hash(artifact.code) } });
    const sandbox: SandboxRequest = { protocolVersion: 1, identity: { runId: 'run', taskId: 'task', attemptId: randomUUID(), scopeId: 'test', generation: 1, layoutRevision: 'layout' },
      workspace, argv: ['/workspace/native-cli', 'exec', '--json', '--model', 'fixture-model', '--', 'Fixture task'] };
    cleanups.push(async () => { await supervisor.cancel(sandbox); await supervisor.release(sandbox); });
    expect((await supervisor.execute(sandbox)).result).toEqual({ kind: 'exited', exitCode: 0 });
    expect(events.filter(event => event.kind === 'session.started')).toEqual([{ schemaVersion: 1, sequence: expect.any(Number), atMs: expect.any(Number),
      kind: 'session.started', provider: 'codex', model: logged, cliVersion: '0.163.0' }]);
    expect(events.find(event => event.kind === 'session.ended')).toMatchObject({ tokens: { input: 0, cacheRead: 40, cacheWrite: 60, output: 10 } });
    expect(connection.modelVerification()).toEqual({ status, admitted: 'fixture-model', observed: [logged], unexpected, evidenceCapability: 'client-reported' });
  });
});
