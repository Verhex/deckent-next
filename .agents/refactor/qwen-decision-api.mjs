// Optional authenticated loopback API. No product server/daemon registration.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ensure } from './jev-context.mjs';
import { errorCode } from './qwen-decision-store.mjs';

function authorized(value, token) {
  const actual = Buffer.from(value ?? ''); const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readBody(req, limit) {
  const length = req.headers['content-length'];
  ensure(length === undefined || (/^\d+$/.test(length) && Number(length) <= limit), 'QWEN_REQUEST_TOO_LARGE');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; ensure(size <= limit, 'QWEN_REQUEST_TOO_LARGE'); chunks.push(chunk); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new Error('QWEN_REQUEST_INVALID'); }
}
export function createDecisionServer({ engine, token, maxRequestBytes, timeoutMs }) {
  ensure(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token), 'QWEN_API_TOKEN'); let busy = false;
  const respond = (res, code, body) => {
    if (res.destroyed) return;
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
    res.end(JSON.stringify(body) + '\n');
  };
  const server = createServer(async (req, res) => {
    if (req.headers.origin || !authorized(req.headers.authorization, token)) {
      respond(res, 401, { error: 'QWEN_API_UNAUTHORIZED' }); return;
    }
    if (req.url === '/health' && req.method === 'GET') {
      respond(res, 200, { scope: 'development-host', busy, calibration: 'not-measured' }); return;
    }
    if (req.url !== '/v1/decide' || req.method !== 'POST') {
      respond(res, 404, { error: 'QWEN_API_ROUTE' }); return;
    }
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      respond(res, 415, { error: 'QWEN_REQUEST_INVALID' }); return;
    }
    if (busy) { respond(res, 429, { error: 'QWEN_API_BUSY', retry: 'caller-controlled' }); return; }
    busy = true; const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    // Bound upload as well as inference; a slow body cannot hold the only slot forever.
    const timer = setTimeout(() => { controller.abort(); req.destroy(); }, timeoutMs);
    try {
      const body = await readBody(req, maxRequestBytes);
      ensure(body && !Array.isArray(body) && Object.keys(body).length === 2
        && Object.hasOwn(body, 'case') && Object.hasOwn(body, 'commandId'), 'QWEN_REQUEST_INVALID');
      ensure(typeof body.commandId === 'string', 'QWEN_REQUEST_INVALID');
      const result = await engine.ask(body.case, { id: body.commandId, signal: controller.signal });
      // Do not expose journal filesystem paths on the wire.
      const { directory, ...wire } = result; void directory;
      respond(res, result.status === 'advice' ? 200 : 503, wire);
    } catch (e) {
      const error = errorCode(e); respond(res, error === 'QWEN_COMMAND_CONFLICT' ? 409
        : ['QWEN_SERVER_BUSY', 'QWEN_ACTIVITY_UNKNOWN'].includes(error) ? 503 : 400, { error });
    } finally { clearTimeout(timer); req.off('aborted', abort); res.off('close', abort); busy = false; }
  });
  server.requestTimeout = timeoutMs; server.headersTimeout = Math.min(timeoutMs, 5000);
  server.maxConnections = 16; server.keepAliveTimeout = 1000;
  server.on('clientError', (_e, socket) => socket.destroy());
  return server;
}
