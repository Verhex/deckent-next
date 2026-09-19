import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { openSqliteModelActivationStore, readLocalOsIdentity } from '#adapters/index.js';
import { ModelActivationApplication, modelInvocationTargetId, type ModelInvocationInspection,
  type ModelInvocationResult } from '#engine/index.js';
import { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';

const execute = promisify(execFile), roots: string[] = [], servers: Server[] = [];
const sdk = resolve('dist/index.js'), cli = resolve('dist/composition/core/cli/internal/entry.js'), mcp = resolve('dist/composition/core/mcp/internal/entry.js');
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
afterEach(async () => {
  clearConfigCache(); await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
const sdkProgram = `
import { readFile } from 'node:fs/promises'; import { pathToFileURL } from 'node:url';
const [entry,operation,project,inputPath]=process.argv.slice(1),api=await import(pathToFileURL(entry).href),input=JSON.parse(await readFile(inputPath,'utf8'));
try { const value=operation==='invoke'?await api.invokeModel(project,input,{env:process.env}):await api.inspectModelInvocation(project,input,{env:process.env});
process.stdout.write(JSON.stringify({ok:true,value})); } catch(error){ process.stdout.write(JSON.stringify({ok:false,code:error?.code??'UNKNOWN'})); }
`;
async function callSdk<T>(project: string, env: Record<string, string>, operation: 'invoke' | 'inspect', inputPath: string) {
  const output = await execute(process.execPath, ['--input-type=module', '-e', sdkProgram, sdk, operation, project, inputPath],
    { cwd: project, env, timeout: 10_000, maxBuffer: 1_048_576 });
  return JSON.parse(output.stdout) as { ok: true; value: T } | { ok: false; code: string };
}
async function callMcp(project: string, env: Record<string, string>, name: string, args: Record<string, unknown>) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp, '--project', project], env, stderr: 'pipe' });
  const diagnostics: Buffer[] = []; transport.stderr?.on('data', chunk => diagnostics.push(Buffer.from(chunk)));
  const client = new Client({ name: 'model-invocation-process', version: '1' });
  try {
    await bounded(client.connect(transport), 'MCP_CONNECT_TIMEOUT');
    const tool = (await bounded(client.listTools(), 'MCP_LIST_TIMEOUT')).tools.find(value => value.name === name);
    expect(tool?.annotations).toMatchObject(name === 'inspect_model_invocation'
      ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      : { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    return await bounded(client.callTool({ name, arguments: args }), `MCP_CALL_TIMEOUT:${Buffer.concat(diagnostics).toString('utf8').slice(-2048)}`);
  } finally {
    await bounded(client.close(), `MCP_CLOSE_TIMEOUT:${Buffer.concat(diagnostics).toString('utf8').slice(-2048)}`);
    await bounded(transport.close(), 'MCP_TRANSPORT_CLOSE_TIMEOUT'); expect(transport.pid).toBeNull();
  }
}

it('shares one bounded invocation ledger across compiled SDK, CLI and stdio MCP without exposing prompts in argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-invocation-process-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  let proxyRequests = 0; const proxy = createServer((_request, reply) => { proxyRequests++; reply.writeHead(502); reply.end('proxy trap'); });
  servers.push(proxy); await new Promise<void>((done, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', done); });
  const proxyAddress = proxy.address(); if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('PROXY_FIXTURE_ADDRESS');
  const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: `http://127.0.0.1:${proxyAddress.port}`, NO_PROXY: '' }, bodies: string[] = []; let response: 'normal' | 'oversize' = 'normal';
  const server = createServer((request, reply) => { const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk))); request.on('end', () => { bodies.push(Buffer.concat(chunks).toString('utf8'));
      const native = response === 'oversize' ? { value: 'x'.repeat(4096) } : { id: `completion-${bodies.length}`, object: 'chat.completion', created: 1,
        model: 'native-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done', refusal: null } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      reply.writeHead(200, { 'content-type': 'application/json' }); reply.end(JSON.stringify(native)); }); });
  servers.push(server); await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
  const model = { id: 'model', version: 1, nativeId: 'native-model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog-1', providers: [{ id: 'provider', version: 1, models: [model] }] };
  const definition = { encodingVersion: 1 as const, provider: { id: 'provider', version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
    digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const profile = { schemaVersion: 1 as const, id: 'local', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 1,
      definition: { origin: `http://127.0.0.1:${address.port}`, maxOutputTokens: 8 } }, allocation: { id: 'allocation', maxCalls: 5, maxInFlight: 2 },
    limits: { requestMaxBytes: 4096, responseMaxBytes: 512, timeoutMs: 2_000 } };
  const configPath = join(project, '.deckent/config.json'); await writeFile(configPath, JSON.stringify({ mode: 'api', layout: { root: data },
    storage: { driver: 'sqlite', sqlite }, provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  const identity = readLocalOsIdentity(), principal = { ...identity, scopeIds: ['scope'] };
  const activation = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1);
  await activation.admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference,
    expectedRevision: 0, catalogRevision: catalog.revision, expectedBinding: binding });
  const policyPath = join(data, 'policy.json'), target = modelInvocationTargetId(reference);
  const writePolicy = async (allowed: boolean) => writeFile(policyPath, JSON.stringify({ schemaVersion: 1, revision: allowed ? 'allow' : 'deny', restrictions: [],
    grants: allowed ? [{ id: 'invoke', effect: 'allow', actions: ['invoke', 'inspect'], scopes: ['scope'],
      principals: [{ issuer: identity.issuer, subject: identity.subject }], resource: { kind: 'model-invocation', ids: [target] } }] : [] }), { mode: 0o600 });
  await writePolicy(true);
  const command = (commandId: string, scopeId = 'scope') => ({ schemaVersion: 1, commandId, scopeId, reference,
    catalogRevision: catalog.revision, expectedBinding: binding,
    nativeRequest: { model: 'native-model', messages: [{ role: 'user', content: `prompt-${commandId}` }], max_completion_tokens: 4 } });
  const firstPath = join(root, 'first.json'); await writeFile(firstPath, JSON.stringify(command('first')), { mode: 0o600 });
  const sdkFirst = await callSdk<ModelInvocationResult>(project, env, 'invoke', firstPath);
  expect(sdkFirst).toMatchObject({ ok: true, value: { replayed: false, receipt: { outcome: { state: 'responded' } } } }); expect(bodies).toHaveLength(1);
  const first = (sdkFirst as { ok: true; value: ModelInvocationResult }).value.receipt;
  const queryOne = { schemaVersion: 1, scopeId: 'scope', invocationId: first.claim.invocationId, reference };
  const queryOnePath = join(root, 'query-one.json'); await writeFile(queryOnePath, JSON.stringify(queryOne), { mode: 0o600 });
  const cliInspection = JSON.parse((await execute(process.execPath, [cli, 'models', 'invocation', '--input', queryOnePath, '--json'],
    { cwd: project, env, timeout: 10_000, maxBuffer: 1_048_576 })).stdout) as ModelInvocationInspection;
  expect(cliInspection.invocation).toEqual(first);
  const replay = await callMcp(project, env, 'invoke_model', command('first'));
  expect(replay.isError).not.toBe(true); expect(replay.structuredContent).toEqual({ replayed: true, receipt: first }); expect(bodies).toHaveLength(1);

  const secondPath = join(root, 'second.json'); await writeFile(secondPath, JSON.stringify(command('second')), { mode: 0o600 });
  const cliSecond = JSON.parse((await execute(process.execPath, [cli, 'models', 'invoke', '--input', secondPath, '--json'],
    { cwd: project, env, timeout: 10_000, maxBuffer: 1_048_576 })).stdout) as ModelInvocationResult;
  expect(cliSecond.replayed).toBe(false); expect(bodies).toHaveLength(2);
  const inspectSecond = await callMcp(project, env, 'inspect_model_invocation', { schemaVersion: 1, scopeId: 'scope',
    invocationId: cliSecond.receipt.claim.invocationId, reference });
  expect(inspectSecond.isError).not.toBe(true); expect((inspectSecond.structuredContent as ModelInvocationInspection).invocation).toEqual(cliSecond.receipt);

  await writePolicy(false); const deniedPath = join(root, 'denied.json'); await writeFile(deniedPath, JSON.stringify(command('denied')), { mode: 0o600 });
  expect(await callSdk(project, env, 'invoke', deniedPath)).toEqual({ ok: false, code: 'POLICY_DENIED' }); expect(bodies).toHaveLength(2);
  const wrongPath = join(root, 'wrong.json'); await writeFile(wrongPath, JSON.stringify(command('wrong', 'wrong-scope')), { mode: 0o600 });
  await expect(execute(process.execPath, [cli, 'models', 'invoke', '--input', wrongPath, '--json'],
    { cwd: project, env, timeout: 10_000 })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('POLICY_DENIED') });
  await writePolicy(true); response = 'oversize'; const largePath = join(root, 'large.json'); await writeFile(largePath, JSON.stringify(command('large')), { mode: 0o600 });
  const large = JSON.parse((await execute(process.execPath, [cli, 'models', 'invoke', '--input', largePath, '--json'],
    { cwd: project, env, timeout: 10_000, maxBuffer: 1_048_576 })).stdout) as ModelInvocationResult;
  expect(large.receipt.outcome).toMatchObject({ state: 'unknown' }); expect(bodies).toHaveLength(3);
  expect(proxyRequests).toBe(0);
  expect((await readFile(ledger)).includes(Buffer.from('prompt-first'))).toBe(false);
});
