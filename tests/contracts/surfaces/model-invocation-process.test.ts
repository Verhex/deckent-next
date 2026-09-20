import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import type { ModelInvocationResponseContent } from '#domain/index.js';
import { openSqliteModelActivationStore, readLocalOsIdentity } from '#adapters/index.js';
import { ModelActivationApplication, modelInvocationTargetId, type ModelInvocationInspection,
  type ModelInvocationResult, type ModelInvocationPurgeResult } from '#engine/index.js';
import { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';

const execute = promisify(execFile), roots: string[] = [], servers: Server[] = [], runtimeProcesses: ChildProcess[] = [], clientProcesses: ChildProcess[] = [],
  heldReleases: (() => void)[] = [];
const sdk = resolve('dist/index.js'), cli = resolve('dist/composition/core/cli/internal/entry.js'), mcp = resolve('dist/composition/core/mcp/internal/entry.js');
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
afterEach(async () => {
  for (const release of heldReleases.splice(0)) release();
  for (const child of clientProcesses.splice(0)) await terminate(child);
  for (const child of runtimeProcesses.splice(0)) await stopRuntime(child);
  clearConfigCache(); await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await bounded(new Promise<void>(resolve => child.once('exit', () => resolve())), 'CLIENT_EXIT_TIMEOUT');
}
async function stopRuntime(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await bounded(new Promise<void>(resolve => child.once('exit', () => resolve())), 'RUNTIME_STOP_TIMEOUT');
  }
}
async function startRuntime(project: string, env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(process.execPath, [cli, 'runtime', 'serve', '--json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  runtimeProcesses.push(child); let stderr = '', buffer = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  await bounded(new Promise<void>((resolve, reject) => {
    const failed = () => reject(new Error(`RUNTIME_START_FAILED:${stderr.slice(-2048)}`));
    child.once('error', failed); child.once('exit', failed);
    child.stdout!.on('data', chunk => {
      buffer += String(chunk); const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        try { if ((JSON.parse(line) as { event?: string }).event === 'ready') resolve(); } catch { /* Ready output is JSON only. */ }
      }
    });
  }), 'RUNTIME_READY_TIMEOUT');
  return child;
}
async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(label);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const sdkProgram = `
import { readFile } from 'node:fs/promises'; import { pathToFileURL } from 'node:url';
const [entry,operation,project,inputPath]=process.argv.slice(1),api=await import(pathToFileURL(entry).href),input=JSON.parse(await readFile(inputPath,'utf8'));
try { const value=operation==='purge'?await api.purgeModelInvocationContent(project,input,{env:process.env}):operation==='invoke'?await api.invokeModel(project,input,{env:process.env}):await api.inspectModelInvocation(project,input,{env:process.env});
process.stdout.write(JSON.stringify({ok:true,value})); } catch(error){ process.stdout.write(JSON.stringify({ok:false,code:error?.code??'UNKNOWN'})); }
`;
async function callSdk<T>(project: string, env: Record<string, string>, operation: 'invoke' | 'inspect' | 'purge', inputPath: string) {
  const output = await execute(process.execPath, ['--input-type=module', '-e', sdkProgram, sdk, operation, project, inputPath],
    { cwd: project, env, timeout: 10_000, maxBuffer: 1_048_576 });
  return JSON.parse(output.stdout) as { ok: true; value: T } | { ok: false; code: string };
}
async function callMcp(project: string, env: Record<string, string>, name: string, args: Record<string, unknown>, inspectTools = true) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp, '--project', project], env, stderr: 'pipe' });
  const diagnostics: Buffer[] = []; transport.stderr?.on('data', chunk => diagnostics.push(Buffer.from(chunk)));
  const client = new Client({ name: 'model-invocation-process', version: '1' });
  try {
    await bounded(client.connect(transport), 'MCP_CONNECT_TIMEOUT');
    if (inspectTools) {
    const tool = (await bounded(client.listTools(), 'MCP_LIST_TIMEOUT')).tools.find(value => value.name === name);
    expect(tool?.annotations).toMatchObject(name === 'inspect_model_invocation'
      ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      : { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: name === 'invoke_model' });
    }
    return await bounded(client.callTool({ name, arguments: args }), `MCP_CALL_TIMEOUT:${Buffer.concat(diagnostics).toString('utf8').slice(-2048)}`);
  } finally {
    await bounded(client.close(), `MCP_CLOSE_TIMEOUT:${Buffer.concat(diagnostics).toString('utf8').slice(-2048)}`);
    await bounded(transport.close(), 'MCP_TRANSPORT_CLOSE_TIMEOUT'); expect(transport.pid).toBeNull();
  }
}
type A5ProofInput = Readonly<{ root: string; project: string; env: Record<string, string>; reference: Record<string, unknown>;
  command: (commandId: string) => Record<string, unknown>; bodies: string[]; runtime: ChildProcess;
  setResponse: (value: 'malformed' | 'status') => void; setContentPolicy: (allowed: boolean) => Promise<void>;
  large: ModelInvocationResult }>;
async function assertA5RejectedEvidence(input: A5ProofInput): Promise<void> {
  const malformedBody = '{"private":"prompt-malformed\\n\\"echo\\""', statusBody = '{"private":"status-body"}';
  const largeBody = Buffer.from(JSON.stringify({ value: 'x'.repeat(4096) })).subarray(0, 512);
  const expectNoRawBody = (receipt: ModelInvocationResult['receipt'], raw: Uint8Array) => {
    const evidence = receipt.outcome?.state !== 'responded' ? receipt.outcome?.evidence : null;
    if (evidence) expect(Object.hasOwn(evidence.body, 'data')).toBe(false);
    expect(Object.hasOwn(receipt.request, 'nativeRequest')).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain(Buffer.from(raw).toString('base64'));
  };
  const largeEvidence = input.large.receipt.outcome?.state === 'unknown' ? input.large.receipt.outcome.evidence : null;
  expect(largeEvidence?.body.observedBytes).toBeGreaterThanOrEqual(4096);
  expect(largeEvidence?.body.byteLength).toBe(512); expectNoRawBody(input.large.receipt, largeBody);
  expect(input.bodies).toHaveLength(4);
  const largePath = join(input.root, 'large.json');
  const largeReplay = await callSdk<ModelInvocationResult>(input.project, input.env, 'invoke', largePath);
  expect(largeReplay).toEqual({ ok: true, value: { replayed: true, receipt: input.large.receipt, response: null, contentStatus: 'retained', purge: null } });
  if (largeReplay.ok) expectNoRawBody(largeReplay.value.receipt, largeBody);
  expect(input.bodies).toHaveLength(4);

  input.setResponse('malformed'); const malformedPath = join(input.root, 'malformed.json'); await writeFile(malformedPath, JSON.stringify(input.command('malformed')), { mode: 0o600 });
  const malformed = await callSdk<ModelInvocationResult>(input.project, input.env, 'invoke', malformedPath);
  expect(malformed).toMatchObject({ ok: true, value: { replayed: false, receipt: { outcome: { state: 'rejected', evidence: { reason: 'invalid-response', httpStatus: 200, body: { complete: true } } } } } });
  const malformedReceipt = (malformed as { ok: true; value: ModelInvocationResult }).value.receipt;
  expectNoRawBody(malformedReceipt, Buffer.from(malformedBody));
  expect(JSON.stringify(malformedReceipt)).not.toContain('prompt-malformed');
  expect(JSON.stringify(malformedReceipt)).not.toContain('never-evidence'); expect(input.bodies).toHaveLength(5);
  const malformedReplay = await callMcp(input.project, input.env, 'invoke_model', input.command('malformed'));
  expect(malformedReplay.structuredContent).toEqual({ replayed: true, receipt: malformedReceipt, response: null, contentStatus: 'retained', purge: null }); expect(input.bodies).toHaveLength(5);
  expectNoRawBody((malformedReplay.structuredContent as ModelInvocationResult).receipt, Buffer.from(malformedBody));

  input.setResponse('status'); const statusPath = join(input.root, 'status.json'); await writeFile(statusPath, JSON.stringify(input.command('status')), { mode: 0o600 });
  const status = JSON.parse((await execute(process.execPath, [cli, 'models', 'invoke', '--input', statusPath, '--json'],
    { cwd: input.project, env: input.env, timeout: 10_000, maxBuffer: 1_048_576 })).stdout) as ModelInvocationResult;
  expect(status.receipt.outcome).toMatchObject({ state: 'rejected', evidence: { reason: 'http-status', httpStatus: 429, body: { complete: true } } });
  expectNoRawBody(status.receipt, Buffer.from(statusBody));
  expect(JSON.stringify(status.receipt)).not.toContain('never-evidence'); expect(input.bodies).toHaveLength(6);
  const statusReplay = await callSdk<ModelInvocationResult>(input.project, input.env, 'invoke', statusPath);
  expect(statusReplay).toEqual({ ok: true, value: { replayed: true, receipt: status.receipt, response: null, contentStatus: 'retained', purge: null } });
  if (statusReplay.ok) expectNoRawBody(statusReplay.value.receipt, Buffer.from(statusBody));
  expect(input.bodies).toHaveLength(6);

  await stopRuntime(input.runtime); runtimeProcesses.splice(runtimeProcesses.indexOf(input.runtime), 1);
  await startRuntime(input.project, input.env);
  const malformedQuery = { schemaVersion: 2, scopeId: 'scope', invocationId: malformedReceipt.claim.invocationId, reference: input.reference };
  const malformedQueryPath = join(input.root, 'malformed-query.json'); await writeFile(malformedQueryPath, JSON.stringify(malformedQuery), { mode: 0o600 });
  const legacyQueryPath = join(input.root, 'malformed-query-v1.json');
  await writeFile(legacyQueryPath, JSON.stringify({ ...malformedQuery, schemaVersion: 1 }), { mode: 0o600 });
  expect(await callSdk<ModelInvocationInspection>(input.project, input.env, 'inspect', legacyQueryPath)).toEqual({ ok: false, code: 'MODEL_INVOCATION_INVALID' });
  await input.setContentPolicy(false);
  const defaultInspection = await callSdk<ModelInvocationInspection>(input.project, input.env, 'inspect', malformedQueryPath);
  expect(defaultInspection).toEqual({ ok: true, value: { ...malformedQuery, schemaVersion: 4, invocation: malformedReceipt, control: { schemaVersion: 1, claim: malformedReceipt.claim, reference: input.reference,
    send: { state: 'permitted', ownerId: expect.any(String), permittedAtMs: expect.any(Number) }, cancellation: null }, contentStatus: 'retained', purge: null } });
  if (defaultInspection.ok) { expect(Object.hasOwn(defaultInspection.value, 'responseContent')).toBe(false); expectNoRawBody(defaultInspection.value.invocation!, Buffer.from(malformedBody)); }
  const defaultText = (await execute(process.execPath, [cli, 'models', 'invocation', '--input', malformedQueryPath, '--no-color'],
    { cwd: input.project, env: input.env, timeout: 10_000, maxBuffer: 1_048_576 })).stdout;
  expect(defaultText).not.toContain(malformedBody); expect(defaultText).not.toContain(Buffer.from(malformedBody).toString('base64'));
  const rawMalformedQueryPath = join(input.root, 'malformed-raw-query.json');
  await writeFile(rawMalformedQueryPath, JSON.stringify({ ...malformedQuery, includeResponseContent: true }), { mode: 0o600 });
  expect(await callSdk<ModelInvocationInspection>(input.project, input.env, 'inspect', rawMalformedQueryPath)).toEqual({ ok: false, code: 'POLICY_DENIED' });
  await input.setContentPolicy(true);
  const malformedInspection = await callSdk<ModelInvocationInspection>(input.project, input.env, 'inspect', rawMalformedQueryPath);
  expect(malformedInspection).toMatchObject({ ok: true, value: { invocation: malformedReceipt } });
  const malformedRaw = (malformedInspection as { ok: true; value: ModelInvocationInspection }).value.responseContent as ModelInvocationResponseContent;
  expect(Buffer.from(malformedRaw.data, 'base64')).toEqual(Buffer.from(malformedBody));
  const statusQuery = { schemaVersion: 2, scopeId: 'scope', invocationId: status.receipt.claim.invocationId, reference: input.reference };
  const statusQueryPath = join(input.root, 'status-query.json'); await writeFile(statusQueryPath, JSON.stringify({ ...statusQuery, includeResponseContent: true }), { mode: 0o600 });
  const statusInspection = JSON.parse((await execute(process.execPath, [cli, 'models', 'invocation', '--input', statusQueryPath, '--json'],
    { cwd: input.project, env: input.env, timeout: 10_000, maxBuffer: 1_048_576 })).stdout) as ModelInvocationInspection;
  expect(statusInspection.invocation).toEqual(status.receipt);
  expect(Buffer.from(statusInspection.responseContent!.data, 'base64')).toEqual(Buffer.from(statusBody));
  const largeInspection = await callMcp(input.project, input.env, 'inspect_model_invocation', { schemaVersion: 2, scopeId: 'scope',
    invocationId: input.large.receipt.claim.invocationId, reference: input.reference, includeResponseContent: true });
  expect(largeInspection.structuredContent).toMatchObject({ invocation: input.large.receipt });
  expect(Buffer.from((largeInspection.structuredContent as ModelInvocationInspection).responseContent!.data, 'base64')).toEqual(largeBody);
  expect(input.bodies).toHaveLength(6);
}

function nativeFixtureBody(mode: 'normal' | 'oversize', count: number): string {
  return JSON.stringify(mode === 'oversize' ? { value: 'x'.repeat(4096) } : { id: `completion-${count}`, object: 'chat.completion', created: 1,
    model: 'native-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done', refusal: null } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, private_note: 'retained-sensitive-usage' } });
}

async function assertRetainedNativeContent(project: string, root: string, env: Record<string, string>, ledger: string,
  query: Record<string, unknown>, bodies: readonly string[]): Promise<void> {
  const count = bodies.length, inputPath = join(root, 'retained-native-query.json');
  await writeFile(inputPath, JSON.stringify(query), { mode: 0o600 });
  const ordinary = await callSdk<ModelInvocationInspection>(project, env, 'inspect', inputPath);
  expect(ordinary).toMatchObject({ ok: true, value: { contentStatus: 'retained' } });
  expect(JSON.stringify(ordinary)).not.toContain('retained-sensitive-usage');
  if (ordinary.ok) expect(Object.hasOwn(ordinary.value, 'responseContent')).toBe(false);
  await writeFile(inputPath, JSON.stringify({ ...query, includeResponseContent: true }), { mode: 0o600 });
  const explicit = await callSdk<ModelInvocationInspection>(project, env, 'inspect', inputPath);
  expect(explicit).toMatchObject({ ok: true, value: { responseContent: { kind: 'native-response', response: {
    native: { usage: { private_note: 'retained-sensitive-usage' } }, usage: { private_note: 'retained-sensitive-usage' },
  } } } });
  const db = new DatabaseSync(ledger, { readOnly: true });
  try {
    const id = String(query.invocationId);
    const receipt = String(db.prepare('SELECT record FROM model_invocations WHERE scope_id=? AND invocation_id=?').get('scope', id)?.record);
    const content = String(db.prepare('SELECT record FROM model_invocation_contents WHERE scope_id=? AND invocation_id=?').get('scope', id)?.record);
    expect(receipt).not.toContain('retained-sensitive-usage'); expect(content).toContain('retained-sensitive-usage');
    expect(explicit.ok && explicit.value.responseContent).toEqual(JSON.parse(content));
  } finally { db.close(); }
  expect(bodies).toHaveLength(count);
}


function bindingDigest(definition: Parameters<typeof encodeModelBindingDefinition>[0]) {
  return { encodingVersion: 1 as const, algorithm: 'sha256' as const,
    digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
}
function countInvocations(ledger: string, commandId: string) {
  const db = new DatabaseSync(ledger, { readOnly: true });
  try { return db.prepare('SELECT count(*) AS count FROM model_invocations WHERE scope_id=? AND command_id=?').get('scope', commandId)?.count; }
  finally { db.close(); }
}
function invocationId(ledger: string, commandId: string): string {
  const db = new DatabaseSync(ledger, { readOnly: true });
  try { return String(db.prepare('SELECT invocation_id FROM model_invocations WHERE scope_id=? AND command_id=?').get('scope', commandId)?.invocation_id); }
  finally { db.close(); }
}
async function assertPurgedContent(input: { project: string; root: string; env: Record<string, string>; ledger: string;
  reference: Record<string, unknown>; bodies: string[]; allow(): Promise<void> }): Promise<void> {
  const { project, root, env, ledger, reference } = input, count = input.bodies.length;
  const snapshot = () => {
    const db = new DatabaseSync(ledger, { readOnly: true });
    try { return { receipts: db.prepare('SELECT * FROM model_invocations ORDER BY command_id').all(),
      allocations: db.prepare('SELECT * FROM model_invocation_allocations ORDER BY allocation_id').all() }; }
    finally { db.close(); }
  };
  const before = snapshot(), receipts: ModelInvocationPurgeResult['receipt'][] = [];
  for (const [index, commandId] of ['first', 'malformed', 'large'].entries()) {
    const id = invocationId(ledger, commandId), query = { schemaVersion: 2, scopeId: 'scope', invocationId: id, reference, includeResponseContent: true };
    const queryPath = join(root, `purge-query-${index}.json`), commandPath = join(root, `purge-${index}.json`);
    await writeFile(queryPath, JSON.stringify(query), { mode: 0o600 });
    const inspected = await callSdk<ModelInvocationInspection>(project, env, 'inspect', queryPath);
    expect(inspected.ok).toBe(true); if (!inspected.ok) throw new Error('INSPECTION_FAILED');
    const command = { schemaVersion: 1, commandId: `purge-${index}`, scopeId: 'scope', invocationId: id, reference,
      expectedContentDigest: inspected.value.responseContent!.descriptor.digest };
    await writeFile(commandPath, JSON.stringify(command), { mode: 0o600 });
    if (index === 0) {
      expect(await callSdk(project, env, 'purge', commandPath)).toEqual({ ok: false, code: 'POLICY_DENIED' });
      expect(await callSdk(project, env, 'inspect', queryPath)).toEqual(inspected);
      await input.allow();
    }
    let result: ModelInvocationPurgeResult;
    if (index === 0) result = JSON.parse((await execute(process.execPath, [cli, 'models', 'purge-content', '--input', commandPath, '--json'],
      { cwd: project, env, timeout: 10_000 })).stdout);
    else if (index === 1) {
      const response = await callMcp(project, env, 'purge_model_invocation_content', command);
      expect(response.isError).not.toBe(true); result = response.structuredContent as unknown as ModelInvocationPurgeResult;
    } else {
      const response = await callSdk<ModelInvocationPurgeResult>(project, env, 'purge', commandPath);
      expect(response.ok).toBe(true); if (!response.ok) throw new Error('PURGE_FAILED'); result = response.value;
    }
    expect(result.replayed).toBe(false); receipts.push(result.receipt);
    const purged = await callSdk<ModelInvocationInspection>(project, env, 'inspect', queryPath);
    expect(purged).toMatchObject({ ok: true, value: { schemaVersion: 4, invocation: inspected.value.invocation,
      contentStatus: 'purged', responseContent: null, purge: result.receipt } });
    expect(snapshot()).toEqual(before);
  }
  const service = runtimeProcesses.at(-1)!; await stopRuntime(service); runtimeProcesses.splice(runtimeProcesses.indexOf(service), 1);
  await startRuntime(project, env);
  for (let index = 0; index < receipts.length; index++) {
    expect(await callSdk(project, env, 'purge', join(root, `purge-${index}.json`)))
      .toEqual({ ok: true, value: { replayed: true, receipt: receipts[index] } });
    const replay = await callSdk<ModelInvocationResult>(project, env, 'invoke', join(root, ['first.json', 'malformed.json', 'large.json'][index]!));
    expect(replay).toMatchObject({ ok: true, value: { replayed: true, response: null, contentStatus: 'purged', purge: receipts[index] } });
  }
  const human = await execute(process.execPath, [cli, 'models', 'invoke', '--input', join(root, 'first.json'), '--lang', 'en'],
    { cwd: project, env, timeout: 10_000 });
  expect(human.stdout).toMatch(/purged/i); expect(human.stdout).not.toContain('retained-sensitive-usage');
  const db = new DatabaseSync(ledger, { readOnly: true });
  try {
    for (const receipt of receipts) expect(db.prepare('SELECT record,purge_command_id FROM model_invocation_contents WHERE invocation_id=?')
      .get(receipt.command.invocationId)).toEqual({ record: null, purge_command_id: receipt.command.commandId });
  } finally { db.close(); }
  expect(input.bodies).toHaveLength(count); expect(snapshot()).toEqual(before);
}

it('shares one bounded invocation ledger across compiled SDK, CLI and stdio MCP without exposing prompts in argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-invocation-process-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  let proxyRequests = 0; const proxy = createServer((_request, reply) => { proxyRequests++; reply.writeHead(502); reply.end('proxy trap'); });
  servers.push(proxy); await new Promise<void>((done, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', done); });
  const proxyAddress = proxy.address(); if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('PROXY_FIXTURE_ADDRESS');
  const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: `http://127.0.0.1:${proxyAddress.port}`, NO_PROXY: '' }, bodies: string[] = [];
  const malformedBody = '{"private":"prompt-malformed\\n\\"echo\\""', statusBody = '{"private":"status-body"}';
  let response: 'normal' | 'oversize' | 'malformed' | 'status' = 'normal';
  let holdResponse = false, releaseHeld: (() => void) | undefined, observeHeld: (() => void) | undefined;
  const hold = () => {
    holdResponse = true;
    const observed = new Promise<void>(resolve => { observeHeld = resolve; });
    heldReleases.push(() => releaseHeld?.());
    return observed;
  };
  const server = createServer((request, reply) => {
    if (request.url !== '/customer/gateway/native-chat' || request.method !== 'POST') { reply.writeHead(404); reply.end(); return; }
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk))); request.on('end', async () => { bodies.push(Buffer.concat(chunks).toString('utf8'));
      if (holdResponse) {
        observeHeld?.(); await new Promise<void>(resolve => { releaseHeld = resolve; }); holdResponse = false;
      }
      if (response === 'status') { reply.writeHead(429, { 'content-type': 'application/json', 'x-private-header': 'never-evidence' }); reply.end(statusBody); return; }
      if (response === 'malformed') { reply.writeHead(200, { 'content-type': 'application/json', 'x-private-header': 'never-evidence' }); reply.end(malformedBody); return; }
      reply.writeHead(200, { 'content-type': 'application/json' }); reply.end(nativeFixtureBody(response, bodies.length)); }); });
  servers.push(server); await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
  const model = { id: 'model', version: 1, nativeId: 'native-model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog-1', providers: [{ id: 'provider', version: 1, models: [model] }] };
  const definition = { encodingVersion: 1 as const, provider: { id: 'provider', version: 1 }, model };
  const binding = bindingDigest(definition);
  const profile = { schemaVersion: 1 as const, id: 'local', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 2,
      definition: { endpoint: `http://127.0.0.1:${address.port}/customer/gateway/native-chat`, maxOutputTokens: 8 } }, allocation: { id: 'allocation', maxCalls: 8, maxInFlight: 2 },
    limits: { requestMaxBytes: 4096, responseMaxBytes: 512, timeoutMs: 2_000 } };
  const configPath = join(project, '.deckent/config.json'); const config = { mode: 'api', layout: { root: data },
    storage: { driver: 'sqlite', sqlite }, provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 65536, responseMaxBytes: 1_048_576, maxConnections: 8, maxConcurrentRequests: 4,
      maxConcurrentExecutions: 2, headerTimeoutMs: 1000, responseTimeoutMs: 1000, shutdownGraceMs: 2000 } };
  const writeConfig = async (responseMaxBytes = 1_048_576) => writeFile(configPath, JSON.stringify({ ...config,
    mcp: { responseMaxBytes } }), { mode: 0o600 });
  await writeConfig();
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  const identity = readLocalOsIdentity(), principal = { ...identity, scopeIds: ['scope'] };
  const activation = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1);
  await activation.admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference,
    expectedRevision: 0, catalogRevision: catalog.revision, expectedBinding: binding });
  const policyPath = join(data, 'policy.json'), target = modelInvocationTargetId(reference);
  const writePolicy = async (allowed: boolean, evidenceAllowed = allowed, purgeAllowed = false) => writeFile(policyPath, JSON.stringify({ schemaVersion: 1,
    revision: allowed ? (evidenceAllowed ? 'allow-with-evidence' : 'allow-without-evidence') : 'deny', restrictions: [], grants: allowed ? [
      { id: 'invoke-inspect', effect: 'allow', actions: ['invoke', 'inspect'], scopes: ['scope'],
        principals: [{ issuer: identity.issuer, subject: identity.subject }], resource: { kind: 'model-invocation', ids: [target] } },
      ...(purgeAllowed ? [{ id: 'purge-content', effect: 'allow', actions: ['purge-content'], scopes: ['scope'],
        principals: [{ issuer: identity.issuer, subject: identity.subject }], resource: { kind: 'model-invocation', ids: [target] } }] : []),
      ...(evidenceAllowed ? [{ id: 'inspect-content', effect: 'allow', actions: ['inspect-content'], scopes: ['scope'],
        principals: [{ issuer: identity.issuer, subject: identity.subject }], resource: { kind: 'model-invocation', ids: [target] } }] : []),
    ] : [] }), { mode: 0o600 });
  await writePolicy(true);
  const command = (commandId: string, scopeId = 'scope') => ({ schemaVersion: 1, commandId, scopeId, reference,
    catalogRevision: catalog.revision, expectedBinding: binding,
    nativeRequest: { model: 'native-model', messages: [{ role: 'user', content: `prompt-${commandId}` }], max_completion_tokens: 4 } });
  const invocationCount = (commandId: string) => countInvocations(ledger, commandId);
  const firstPath = join(root, 'first.json'); await writeFile(firstPath, JSON.stringify(command('first')), { mode: 0o600 });
  expect(await callSdk(project, env, 'invoke', firstPath)).toEqual({ ok: false, code: 'LOCAL_RUNTIME_ENDPOINT_UNSAFE' });
  expect(bodies).toHaveLength(0);
  const runtime = await startRuntime(project, env);
  const firstObserved = hold();
  const firstClient = spawn(process.execPath, ['--input-type=module', '-e', sdkProgram, sdk, 'invoke', project, firstPath],
    { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  clientProcesses.push(firstClient);
  await firstObserved;
  await terminate(firstClient);
  clientProcesses.splice(clientProcesses.indexOf(firstClient), 1);
  releaseHeld?.();
  await waitFor(() => invocationCount('first') === 1, 'DISCONNECTED_CLIENT_RESULT_MISSING');
  expect(bodies).toHaveLength(1);
  await stopRuntime(runtime); runtimeProcesses.splice(runtimeProcesses.indexOf(runtime), 1);
  const restartedRuntime = await startRuntime(project, env);
  const queryOne = { schemaVersion: 2, scopeId: 'scope', invocationId: invocationId(ledger, 'first'), reference };
  const queryOnePath = join(root, 'query-one.json'); await writeFile(queryOnePath, JSON.stringify(queryOne), { mode: 0o600 });
  const recovered = await callSdk<ModelInvocationInspection>(project, env, 'inspect', queryOnePath);
  expect(recovered).toMatchObject({ ok: true, value: { invocation: { outcome: { state: 'responded' } } } });
  const first = (recovered as { ok: true; value: ModelInvocationInspection }).value.invocation!;
  const cliInspection = JSON.parse((await execute(process.execPath, [cli, 'models', 'invocation', '--input', queryOnePath, '--json'],
    { cwd: project, env, timeout: 10_000, maxBuffer: 1_048_576 })).stdout) as ModelInvocationInspection;
  expect(cliInspection.invocation).toEqual(first);
  const replay = await callMcp(project, env, 'invoke_model', command('first'));
  expect(replay.isError).not.toBe(true); expect(replay.structuredContent).toMatchObject({ replayed: true, receipt: first,
    contentStatus: 'retained', response: { native: { model: 'native-model' } } }); expect(bodies).toHaveLength(1);

  const capCommand = command('mcp-result-cap'); const capPath = join(root, 'mcp-result-cap.json');
  await writeFile(capPath, JSON.stringify(capCommand), { mode: 0o600 });
  // The inner result fits this limit; duplicated text/structured JSON-RPC does not.
  const innerBytes = Buffer.byteLength(JSON.stringify(replay.structuredContent), 'utf8'), outerCap = innerBytes + 16;
  expect(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: replay }) + '\n', 'utf8')).toBeGreaterThan(outerCap);
  await writeConfig(outerCap);
  const rejectedBeforeClaim = await callMcp(project, env, 'invoke_model', capCommand, false);
  expect(rejectedBeforeClaim.isError).toBe(true);
  expect(JSON.parse((rejectedBeforeClaim.content as { text: string }[])[0]!.text)).toMatchObject({ schemaVersion: 1,
    code: 'MODEL_INVOCATION_RESULT_LIMIT', message: expect.stringMatching(/SDK.*CLI/) });
  expect(invocationCount(capCommand.commandId)).toBe(0); expect(bodies).toHaveLength(1);
  await writeConfig();
  const capAccepted = await callMcp(project, env, 'invoke_model', capCommand, false);
  expect(capAccepted.isError).not.toBe(true);
  expect(capAccepted.structuredContent).toMatchObject({ replayed: false }); expect(bodies).toHaveLength(2);
  const capReceipt = (capAccepted.structuredContent as ModelInvocationResult).receipt;
  await writeConfig(1024);
  const cappedReplay = await callMcp(project, env, 'invoke_model', capCommand, false);
  expect(cappedReplay.isError).toBe(true);
  expect(JSON.parse((cappedReplay.content as { text: string }[])[0]!.text)).toMatchObject({ schemaVersion: 1,
    code: 'MODEL_INVOCATION_RESULT_LIMIT', message: expect.stringMatching(/SDK.*CLI/) });
  const cappedInspection = await callMcp(project, env, 'inspect_model_invocation', { schemaVersion: 2, scopeId: 'scope',
    invocationId: capReceipt.claim.invocationId, reference }, false);
  expect(cappedInspection.isError).toBe(true);
  expect(JSON.parse((cappedInspection.content as { text: string }[])[0]!.text)).toMatchObject({ schemaVersion: 1,
    code: 'MODEL_INVOCATION_RESULT_LIMIT', message: expect.stringMatching(/SDK.*CLI/) });
  expect(bodies).toHaveLength(2);
  expect(await callSdk<ModelInvocationResult>(project, env, 'invoke', capPath)).toMatchObject({ ok: true, value: { replayed: true,
    receipt: capReceipt, contentStatus: 'retained', response: { native: { model: 'native-model' } } } });
  expect(bodies).toHaveLength(2);
  await writeConfig();

  const secondPath = join(root, 'second.json'); await writeFile(secondPath, JSON.stringify(command('second')), { mode: 0o600 });
  const cliSecond = JSON.parse((await execute(process.execPath, [cli, 'models', 'invoke', '--input', secondPath, '--json'],
    { cwd: project, env, timeout: 10_000, maxBuffer: 1_048_576 })).stdout) as ModelInvocationResult;
  expect(cliSecond.replayed).toBe(false); expect(bodies).toHaveLength(3);
  const inspectSecond = await callMcp(project, env, 'inspect_model_invocation', { schemaVersion: 2, scopeId: 'scope',
    invocationId: cliSecond.receipt.claim.invocationId, reference });
  expect(inspectSecond.isError).not.toBe(true); expect((inspectSecond.structuredContent as ModelInvocationInspection).invocation).toEqual(cliSecond.receipt);

  await writePolicy(false); const deniedPath = join(root, 'denied.json'); await writeFile(deniedPath, JSON.stringify(command('denied')), { mode: 0o600 });
  expect(await callSdk(project, env, 'invoke', deniedPath)).toEqual({ ok: false, code: 'POLICY_DENIED' }); expect(bodies).toHaveLength(3);
  const wrongPath = join(root, 'wrong.json'); await writeFile(wrongPath, JSON.stringify(command('wrong', 'wrong-scope')), { mode: 0o600 });
  await expect(execute(process.execPath, [cli, 'models', 'invoke', '--input', wrongPath, '--json'],
    { cwd: project, env, timeout: 10_000 })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('POLICY_DENIED') });
  await writePolicy(true); response = 'oversize'; const largePath = join(root, 'large.json'); await writeFile(largePath, JSON.stringify(command('large')), { mode: 0o600 });
  const large = JSON.parse((await execute(process.execPath, [cli, 'models', 'invoke', '--input', largePath, '--json'],
    { cwd: project, env, timeout: 10_000, maxBuffer: 1_048_576 })).stdout) as ModelInvocationResult;
  expect(large.receipt.outcome).toMatchObject({ state: 'unknown', reason: 'transport-error', evidence: { reason: 'response-limit',
    body: { complete: false, byteLength: 512, observedBytes: expect.any(Number) } } });
  await assertA5RejectedEvidence({ root, project, env, reference, command, bodies, runtime: restartedRuntime,
    setResponse(value) { response = value; }, setContentPolicy: allowed => writePolicy(true, allowed), large });
  await assertRetainedNativeContent(project, root, env, ledger, queryOne, bodies);
  await assertPurgedContent({ project, root, env, ledger, reference, bodies, allow: () => writePolicy(true, true, true) });
  expect(proxyRequests).toBe(0);
  // Requests are represented by digests, not separately persisted raw prompts; rejected response evidence may itself echo one.
  expect((await readFile(ledger)).includes(Buffer.from('prompt-first'))).toBe(false);
});
