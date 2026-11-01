// Packaged BeUser realm asset, independent of the repository's test directory.
import { createServer } from 'node:http';
import { fork, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, writeFileSync, readFileSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fixture from './model-fixture.json' with { type: 'json' };

Object.freeze(fixture);
const fail = () => { throw new Error('BEUSER_MODEL_FIXTURE_UNAVAILABLE'); };
const endpoint = new URL(fixture.endpoint);
// Literal loopback only: a registry edit can never turn this asset into an external client or listener.
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.pathname !== '/') fail();

function cli(entry, args, timeoutMs, maxBuffer) {
  const run = spawnSync(process.execPath, [entry, ...args], { cwd: process.cwd(), env: process.env,
    stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, maxBuffer, killSignal: 'SIGKILL' });
  if (run.error || run.status !== 0) return fail();
  return JSON.parse(run.stdout.toString());
}
function readConnected(entry, timeoutMs, maxBuffer) {
  const deadline = Date.now() + timeoutMs;
  const declared = cli(entry, ['models', '--json'], Math.max(1, deadline - Date.now()), maxBuffer);
  const provider = declared.catalog?.providers?.find(row => row.models?.some(model => model.nativeId === fixture.modelId));
  if (!provider) return fail();
  const model = provider.models.find(row => row.nativeId === fixture.modelId);
  const activation = cli(entry, ['models', 'activation', '--scope', fixture.scopeId, '--provider', provider.id,
    '--provider-version', String(provider.version), '--model', model.id, '--model-version', String(model.version), '--json'], Math.max(1, deadline - Date.now()), maxBuffer);
  if (activation.activation?.state !== 'active') return fail();
  return provider;
}
export function observeModelFixture(entry, work, timeoutMs, maxBuffer) {
  readConnected(entry, timeoutMs, maxBuffer);
  const file = join(work, fixture.receiptPath), fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd), expected = JSON.stringify(fixture.receipt);
    if (!info.isFile() || info.nlink !== 1 || info.size !== Buffer.byteLength(expected)) return fail();
    const bytes = readFileSync(fd);
    if (bytes.toString() !== expected) return fail();
    return { state: 'file', mode: '0' + (info.mode & 0o777).toString(8).padStart(3, '0'), sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { closeSync(fd); }
}
export async function arrangeModelFixture(entry, work, step, maxBuffer, maxWallMs) {
  if (step.kind !== 'cli' || step.id !== fixture.stepId || JSON.stringify(step.args) !== JSON.stringify([
    'models', 'connect', '--scope', fixture.scopeId, '--connection', fixture.connection, '--endpoint', fixture.endpoint, '--model', fixture.modelId, '--json'])) return fail();
  const deadline = Date.now() + step.timeoutMs;
  const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) return fail(); return ms; };
  const child = fork(fileURLToPath(import.meta.url), ['serve', String(Math.min(maxWallMs, fixture.maxLifetimeMs))], {
    cwd: work, env: process.env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error('BEUSER_MODEL_FIXTURE_UNAVAILABLE')), remaining());
      const done = error => { clearTimeout(timer); child.removeAllListeners('message'); child.removeAllListeners('error'); child.removeAllListeners('exit'); if (error) reject(error); else resolve(); };
      child.once('message', ready => done(ready?.revision === fixture.revision && ready.port === Number(endpoint.port) ? undefined : new Error('BEUSER_MODEL_FIXTURE_UNAVAILABLE')));
      child.once('error', done); child.once('exit', () => done(new Error('BEUSER_MODEL_FIXTURE_UNAVAILABLE')));
    });
    const connected = cli(entry, step.args, remaining(), maxBuffer);
    if (connected.status !== 'connected' || !connected.reference) return fail();
    readConnected(entry, remaining(), maxBuffer);
    const fd = openSync(join(work, fixture.receiptPath), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(fixture.receipt)); } finally { closeSync(fd); }
    child.disconnect(); child.unref();
    return JSON.stringify(fixture.receipt);
  } catch (error) { child.kill('SIGKILL'); throw error; }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'serve') {
  if (!process.send) fail();
  const lifetimeMs = Number(process.argv[3]);
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > fixture.maxLifetimeMs) fail();
  let calls = 0;
  const server = createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (++calls > fixture.maxRequests || req.headers.authorization) return json(403, { error: { code: 'fixture-bound' } });
    if (req.method === 'GET' && req.url === '/v1/models') return json(200, { object: 'list', data: [{ id: fixture.modelId, object: 'model', created: 0, owned_by: fixture.revision }] });
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(404, { error: { code: 'fixture-route' } });
    try {
      const chunks = []; let bytes = 0;
      for await (const part of req) { bytes += part.length; if (bytes > fixture.maxRequestBytes) { req.destroy(); return; } chunks.push(part); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.model !== fixture.modelId || !Array.isArray(body.messages)) return json(400, { error: { code: 'fixture-request' } });
      if (!body.stream) return json(200, fixture.response);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: fixture.response.id, object: 'chat.completion.chunk', created: fixture.response.created, model: fixture.modelId };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: fixture.response.choices[0].message, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: fixture.response.usage })}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch { if (!res.headersSent) json(400, { error: { code: 'fixture-request' } }); else res.destroy(); }
  });
  server.requestTimeout = fixture.requestTimeoutMs; server.headersTimeout = fixture.requestTimeoutMs;
  server.setTimeout(fixture.requestTimeoutMs, socket => socket.destroy());
  server.on('error', () => process.exit(1));
  server.listen(Number(endpoint.port), endpoint.hostname, () => process.send?.({ revision: fixture.revision, port: server.address().port }));
  setTimeout(() => { server.closeAllConnections(); server.close(); }, lifetimeMs);
}
