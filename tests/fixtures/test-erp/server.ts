import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import config from './config.json' with { type: 'json' };
import { FixtureUnavailableError, fixtureAvailability, loopbackAvailability } from './availability.js';

/** Test data and HTTP protocol only. No adapter registration or alternate effect/approval owner. */
export async function startTestErp() {
  const availability = fixtureAvailability();
  if (availability.status !== 'available') throw new FixtureUnavailableError(availability);
  let record = { version: config.initialVersion, status: config.initialStatus };
  const etag = (version: number) => `"${config.versionPrefix}${version}"`;
  const idempotency = new Map<string, string>();
  const writes: { operation: string; key: string; before: typeof record; after: typeof record; input: unknown }[] = [];
  const requests: { method: string; path: string; key: string | null; ifMatch: string | null }[] = [];
  // replyLate (BETA-RAKIP-3): the next operation request is held after its body arrives, past the client deadline, until releaseLate();
  // it is then processed as usual (replay check, If-Match, write) and its reply goes to a client that already gave up.
  const faults = { advanceBeforeWrite: false, loseResponseAfterWrite: false, lookupUnavailable: false, replyLate: false };
  type LateReply = { key: string; status: number; clientGone: boolean };
  let late: { res: ServerResponse; key: string; release: () => void; replied: Promise<LateReply>; resolve: (reply: LateReply) => void } | null = null;
  const send = (res: ServerResponse, status: number, version?: string, body: unknown = {}) => {
    if (late?.res === res) { const reply = { key: late.key, status, clientGone: res.socket?.destroyed ?? true }; late.resolve(reply); late = null; }
    res.writeHead(status, { 'content-type': 'application/json', ...(version ? { etag: version } : {}) }); res.end(JSON.stringify(body));
  };
  const hold = async (res: ServerResponse, key: string) => {
    let release!: () => void, resolve!: (reply: LateReply) => void;
    const gate = new Promise<void>(done => { release = done; }), replied = new Promise<LateReply>(done => { resolve = done; });
    late = { res, key, release, replied, resolve }; await gate;
  };
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const raw of req) {
      const chunk = Buffer.from(raw); bytes += chunk.length;
      if (bytes > config.http.inputMaxBytes) throw new Error('fixture request limit');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as { operation: { id: string; version: number }; input: unknown };
  };
  const server = createServer((req, res) => {
    void (async () => {
      const parts = (req.url ?? '').split('/').filter(Boolean).map(decodeURIComponent);
      const key = String(req.headers['idempotency-key'] ?? '');
      requests.push({ method: req.method ?? '', path: req.url ?? '', key: key || null, ifMatch: String(req.headers['if-match'] ?? '') || null });
      if (req.method === 'GET' && parts[0] === 'idempotency' && parts.length === 2) {
        if (faults.lookupUnavailable) return send(res, 503);
        const version = idempotency.get(parts[1]!);
        return version ? send(res, 200, undefined, { status: 'applied', version }) : send(res, 404);
      }
      if (req.method === 'GET' && parts[0] === 'records' && parts[1] === config.recordId && parts.length === 2) {
        return send(res, 200, etag(record.version), record);
      }
      if (req.method !== 'POST' || parts.length !== 3 || parts[0] !== 'records' || parts[1] !== config.recordId || parts[2] !== 'operations') return send(res, 404);
      const body = await read(req);
      if (faults.replyLate) { faults.replyLate = false; await hold(res, key); }
      if (!key) return send(res, 400);
      const replay = idempotency.get(key);
      if (replay) return send(res, 200, replay);
      if (body.operation.id === config.operations.read.id && body.operation.version === config.operations.read.version) {
        idempotency.set(key, etag(record.version)); return send(res, 200, etag(record.version), record);
      }
      if (faults.advanceBeforeWrite) { faults.advanceBeforeWrite = false; record = { ...record, version: record.version + 1 }; }
      if (req.headers['if-match'] !== etag(record.version)) return send(res, 412);
      const status = body.operation.id === config.operations.approve.id ? config.approvedStatus
        : body.operation.id === config.operations.undo.id ? config.initialStatus : null;
      const operation = Object.values(config.operations).find(value => value.id === body.operation.id && value.version === body.operation.version);
      if (status === null || !operation) return send(res, 422);
      const before = { ...record }; record = { version: record.version + 1, status };
      idempotency.set(key, etag(record.version)); writes.push({ operation: operation.id, key, before, after: { ...record }, input: body.input });
      // A real HTTP deadline expires after the business write; do not manufacture an engine error.
      if (faults.loseResponseAfterWrite) { faults.loseResponseAfterWrite = false; return; }
      send(res, 200, etag(record.version));
    })().catch(() => { if (!res.headersSent) send(res, 400); else res.destroy(); });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.http.port, config.http.host, resolve); });
  } catch (error) {
    const denied = loopbackAvailability(error);
    if (denied.status === 'verify-not-run') throw new FixtureUnavailableError(denied);
    throw error;
  }
  const baseUrl = `http://${config.http.host}:${(server.address() as AddressInfo).port}`;
  const releaseLate = () => {
    if (!late) throw new Error('no operation request is held');
    const { release, replied } = late; release(); return replied;
  };
  return { baseUrl, faults, writes, requests, etag, idempotency, current: () => ({ ...record }), heldLate: () => late !== null, releaseLate,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
