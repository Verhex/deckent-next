import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { processReady } from '../../fixtures/process-readiness.js';

const roots: string[] = [], children: ChildProcessWithoutNullStreams[] = [];
const mcp = resolve('dist/composition/core/mcp/internal/entry.js');

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); await new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
    }
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function within<T>(work: Promise<T>, label: string, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}

async function fixture(responseMaxBytes: number) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-mcp-envelope-')); roots.push(root);
  const home = join(root, 'home'); await mkdir(home, { mode: 0o700 }); await mkdir(join(root, '.deckent'), { mode: 0o700 });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ mcp: { responseMaxBytes, inputMaxBytes: 65_536, maxConcurrentCalls: 2 } }), { mode: 0o600 });
  return { root, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
}

async function launch(root: string, env: Record<string, string>) {
  const preload = pathToFileURL(resolve('tests/fixtures/stdio-ready.mjs')).href;
  const child = spawn(process.execPath, ['--import', preload, mcp, '--project', root],
    { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }) as ChildProcessWithoutNullStreams;
  children.push(child); let buffer = Buffer.alloc(0), stderr = '', failure: Error | undefined;
  const frames: Buffer[] = [], waiters: Array<{ resolve: (value: Buffer) => void; reject: (error: Error) => void }> = [];
  const failed = (error: Error) => { failure = error; for (const waiter of waiters.splice(0)) waiter.reject(error); };
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2048); });
  child.on('error', failed); child.stdin.on('error', failed);
  const closed = new Promise<number | null>(done => {
    child.once('close', (code, signal) => { failed(new Error(`MCP_CLOSED:${code}:${signal}:${stderr}`)); done(code); });
  });
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    for (;;) {
      const newline = buffer.indexOf(0x0a); if (newline < 0) return;
      const frame = buffer.subarray(0, newline + 1); buffer = buffer.subarray(newline + 1);
      const waiter = waiters.shift(); if (waiter) waiter.resolve(frame); else frames.push(frame);
    }
  });
  const next = async (label: string) => {
    const frame = frames.shift(); if (frame) return frame;
    if (failure) throw failure;
    let waiter: (typeof waiters)[number] | undefined;
    try {
      return await within(new Promise<Buffer>((resolveFrame, reject) => { waiter = { resolve: resolveFrame, reject }; waiters.push(waiter); }), label);
    } finally { if (waiter) { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); } }
  };
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  // The existing 15s test bound covers startup. The unchanged 5s frame bound starts only after
  // the compiled entry's real transport is consuming stdin, not while its module graph is loading.
  await processReady(child, 'stdio-ready');
  return { child, next, send, closed };
}

const initialize = (id: string | number) => ({ jsonrpc: '2.0' as const, id, method: 'initialize', params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-envelope-process', version: '1' },
} });
const initialized = { jsonrpc: '2.0' as const, method: 'notifications/initialized', params: {} };
const modernEnvelope = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
function decode(frame: Buffer, cap: number) {
  expect(frame.at(-1)).toBe(0x0a); expect(frame.byteLength).toBeLessThanOrEqual(cap);
  return JSON.parse(frame.subarray(0, -1).toString('utf8')) as { readonly id?: string | number | null; readonly result?: unknown;
    readonly error?: { readonly code: number; readonly message: string } };
}
function assertVocabularyResult(value: unknown) {
  const result = value as { readonly resultType?: unknown; readonly _meta?: { readonly ['io.modelcontextprotocol/serverInfo']?: unknown };
    readonly content?: readonly { readonly type?: unknown; readonly text?: unknown }[]; readonly structuredContent?: unknown };
  expect(result).toMatchObject({ resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'deckent' } },
    content: [{ type: 'text' }], structuredContent: expect.any(Object) });
  expect(JSON.parse(String(result.content?.[0]?.text))).toEqual(result.structuredContent);
}

it('caps actual compiled stdio JSON-RPC lines for initialize, tools list, protocol errors, and surface tool errors', async () => {
  const cap = 65_536, f = await fixture(cap), raw = await launch(f.root, f.env);
  raw.send(initialize('initialize-id'));
  expect(decode(await raw.next('MCP_INITIALIZE_TIMEOUT'), cap)).toMatchObject({ id: 'initialize-id', result: expect.any(Object) });
  raw.send(initialized);

  raw.send({ jsonrpc: '2.0', id: 'legacy-vocabulary-id', method: 'tools/call', params: { name: 'policy_vocabulary', arguments: {} } });
  const legacyVocabulary = decode(await raw.next('MCP_LEGACY_VOCABULARY_TIMEOUT'), cap);
  expect(legacyVocabulary.id).toBe('legacy-vocabulary-id'); assertVocabularyResult(legacyVocabulary.result);

  raw.send({ jsonrpc: '2.0', id: 'tools-list-id', method: 'tools/list', params: {} });
  expect(decode(await raw.next('MCP_TOOLS_LIST_TIMEOUT'), cap)).toMatchObject({ id: 'tools-list-id', result: { tools: expect.any(Array) } });

  raw.send({ jsonrpc: '2.0', id: 'unknown-method-id', method: 'unknown/method', params: {} });
  expect(decode(await raw.next('MCP_UNKNOWN_METHOD_TIMEOUT'), cap)).toMatchObject({ id: 'unknown-method-id', error: { code: -32601 } });

  raw.send({ jsonrpc: '2.0', id: 'unknown-tool-id', method: 'tools/call', params: { name: 'missing_tool', arguments: {} } });
  expect(decode(await raw.next('MCP_UNKNOWN_TOOL_TIMEOUT'), cap)).toMatchObject({ id: 'unknown-tool-id', result: { isError: true } });

  raw.send({ jsonrpc: '2.0', id: 'invalid-tool-input-id', method: 'tools/call', params: { name: 'policy_vocabulary', arguments: { forged: true } } });
  expect(decode(await raw.next('MCP_TOOL_ERROR_TIMEOUT'), cap)).toMatchObject({ id: 'invalid-tool-input-id', result: { isError: true } });
}, 15_000);

it('caps the supported 2026 envelope codec for discovery and an enveloped tools-list request', async () => {
  const cap = 65_536, f = await fixture(cap), raw = await launch(f.root, f.env);
  raw.send({ jsonrpc: '2.0', id: 'modern-discover-id', method: 'server/discover', params: { _meta: modernEnvelope } });
  expect(decode(await raw.next('MCP_MODERN_DISCOVER_TIMEOUT'), cap)).toMatchObject({ id: 'modern-discover-id', result: expect.any(Object) });
  raw.send({ jsonrpc: '2.0', id: 'modern-tools-list-id', method: 'tools/list', params: { _meta: modernEnvelope } });
  expect(decode(await raw.next('MCP_MODERN_TOOLS_LIST_TIMEOUT'), cap)).toMatchObject({ id: 'modern-tools-list-id', result: { tools: expect.any(Array) } });
  raw.send({ jsonrpc: '2.0', id: 'modern-vocabulary-id', method: 'tools/call', params: { name: 'policy_vocabulary', arguments: {}, _meta: modernEnvelope } });
  const modernVocabulary = decode(await raw.next('MCP_MODERN_VOCABULARY_TIMEOUT'), cap);
  expect(modernVocabulary.id).toBe('modern-vocabulary-id'); assertVocabularyResult(modernVocabulary.result);
}, 15_000);

it('falls back to a correlated bounded error when compiled tools-list output exceeds the configured wire cap', async () => {
  const cap = 512, f = await fixture(cap), raw = await launch(f.root, f.env);
  raw.send(initialize('small-initialize-id'));
  expect(decode(await raw.next('MCP_SMALL_INITIALIZE_TIMEOUT'), cap)).toMatchObject({ id: 'small-initialize-id', result: expect.any(Object) });
  raw.send(initialized);
  raw.send({ jsonrpc: '2.0', id: 'small-tools-list-id', method: 'tools/list', params: {} });
  expect(decode(await raw.next('MCP_SMALL_TOOLS_LIST_TIMEOUT'), cap)).toEqual({ jsonrpc: '2.0', id: 'small-tools-list-id',
    error: { code: -32603, message: 'MCP_RESPONSE_LIMIT' } });
}, 15_000);

it('closes before dispatch when a request id cannot carry the correlated fallback error', async () => {
  const cap = 512, f = await fixture(cap), raw = await launch(f.root, f.env);
  raw.send(initialize('request-id-too-large-'.repeat(100)));
  raw.child.stdin.end();
  const code = await within(raw.closed, 'MCP_LONG_ID_CLOSE_TIMEOUT');
  expect(code).toBe(0);
}, 15_000);
