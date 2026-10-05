import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecisionServer } from './qwen-decision-api.mjs';
import { readPrivateToken } from './qwen-decision.mjs';
import { callId } from './jev-journal.mjs';

const token = 'a'.repeat(64);
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function withServer(engine, fn, limit = 8192) {
  const server = createDecisionServer({ engine, token, maxRequestBytes: limit, timeoutMs: 1000 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
test('API authentication, origin, route, input limits and content type fail before engine invocation', async () => {
  let calls = 0; const engine = { ask: async () => { calls++; } };
  await withServer(engine, async base => {
    const send = (path, options) => fetch(base + path, options);
    assert.equal((await send('/v1/decide', { method: 'POST' })).status, 401);
    assert.equal((await send('/v1/decide', { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' } })).status, 401);
    assert.equal((await send('/other', { headers })).status, 404);
    assert.equal((await send('/v1/decide', { method: 'POST', headers: { Authorization: headers.Authorization }, body: '{}' })).status, 415);
    assert.equal((await send('/v1/decide', { method: 'POST', headers, body: 'invalid' })).status, 400);
    assert.equal((await send('/v1/decide', { method: 'POST', headers, body: JSON.stringify({ case: {} }) })).status, 400);
    const tooLarge = await send('/v1/decide', { method: 'POST', headers, body: 'x'.repeat(1000) });
    assert.equal(tooLarge.status, 400); assert.equal((await tooLarge.json()).error, 'QWEN_REQUEST_TOO_LARGE');
    assert.equal((await send('/health', { headers })).status, 200);
    assert.equal(calls, 0);
  }, 512);
});
test('API carries explicit command id, hides filesystem path and refuses concurrent inference', async () => {
  let started; let release; let calls = 0;
  const start = new Promise(r => { started = r; }); const pending = new Promise(r => { release = r; });
  const id = callId();
  const engine = { ask: async (c, opts) => {
    calls++; assert.equal(opts.id, id); assert.deepEqual(c, { fixture: true });
    started(); await pending; return { callId: id, status: 'advice', directory: '/private/journal', calibration: 'not-measured' };
  } };
  await withServer(engine, async base => {
    const options = { method: 'POST', headers, body: JSON.stringify({ commandId: id, case: { fixture: true } }) };
    const first = fetch(base + '/v1/decide', options); await start;
    const busy = await fetch(base + '/v1/decide', options); assert.equal(busy.status, 429);
    assert.equal(calls, 1); release(); const response = await first;
    assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.calibration, 'not-measured'); assert.equal('directory' in body, false);
    assert.equal(JSON.stringify(body).includes(token), false);
  });
});
test('API preserves unknown and conflicting replay without raw transport details', async () => {
  const engine = { ask: async c => {
    if (c.conflict) throw new Error('QWEN_COMMAND_CONFLICT');
    return { status: 'unknown', error: 'QWEN_RESULT_UNKNOWN', directory: '/private/journal', replayed: true };
  } };
  await withServer(engine, async base => {
    const unknown = await fetch(base + '/v1/decide', { method: 'POST', headers, body: JSON.stringify({ commandId: callId(), case: {} }) });
    assert.equal(unknown.status, 503); assert.equal((await unknown.json()).status, 'unknown');
    const conflict = await fetch(base + '/v1/decide', { method: 'POST', headers, body: JSON.stringify({ commandId: callId(), case: { conflict: true } }) });
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error, 'QWEN_COMMAND_CONFLICT');
  });
});
test('API disconnect cancels inference and releases the only slot', async () => {
  let started; let canceled;
  const start = new Promise(r => { started = r; }); const cancel = new Promise(r => { canceled = r; });
  const engine = { ask: async (_case, { signal }) => {
    started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    canceled(); return { status: 'unknown' };
  } };
  await withServer(engine, async base => {
    const controller = new AbortController();
    const request = fetch(base + '/v1/decide', { method: 'POST', headers, body: JSON.stringify({ commandId: callId(), case: {} }), signal: controller.signal });
    const rejected = assert.rejects(request); await start; controller.abort(); await rejected; await cancel;
    // Health proves service remains available; no second inference is sent.
    const health = await fetch(base + '/health', { headers }); assert.equal(health.status, 200);
    assert.equal((await health.json()).busy, false);
  });
});
test('token custody refuses permissive files and symlinks and never prints the key', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'qwen-api-token-test-')); const file = join(root, 'token');
  try {
    await writeFile(file, token, { mode: 0o600 }); assert.equal(await readPrivateToken(file), token);
    await chmod(file, 0o644); await assert.rejects(readPrivateToken(file), /QWEN_API_TOKEN/);
    await chmod(file, 0o600); await symlink(file, join(root, 'alias')); await assert.rejects(readPrivateToken(join(root, 'alias')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
