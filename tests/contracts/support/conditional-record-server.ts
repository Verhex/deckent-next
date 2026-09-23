import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** ERP-like record service for effect-contract tests: ETag record versions, If-Match (412), Idempotency-Key replay, an
 * idempotency lookup endpoint and fault knobs. It stands in for a vendor API; it is not an ERP adapter. */
export async function conditionalRecordServer() {
  const records = new Map<string, number>(), idempotency = new Map<string, string>(), operations: { id: string; key: string; body: unknown }[] = [];
  const faults = { dropAfterWrite: 0, bumpBeforeApply: 0, lookupDown: 0 };
  const etag = (version: number) => `"v${version}"`;
  const read = (req: IncomingMessage) => new Promise<string>(resolve => { let text = ''; req.on('data', chunk => { text += String(chunk); }); req.on('end', () => resolve(text)); });
  const send = (res: ServerResponse, status: number, headers: Record<string, string> = {}, body = '') => { res.writeHead(status, headers); res.end(body); };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost'), parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (req.method === 'GET' && parts[0] === 'records' && parts.length === 2) {
      const version = records.get(parts[1]!);
      return version === undefined ? send(res, 404) : send(res, 200, { etag: etag(version) }, '{}');
    }
    if (req.method === 'GET' && parts[0] === 'idempotency' && parts.length === 2) {
      if (faults.lookupDown > 0) { faults.lookupDown--; return send(res, 503); }
      const version = idempotency.get(parts[1]!);
      return version === undefined ? send(res, 404) : send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ status: 'applied', version }));
    }
    if (req.method === 'POST' && parts[0] === 'records' && parts[2] === 'operations' && parts.length === 3) {
      const id = parts[1]!, key = String(req.headers['idempotency-key'] ?? ''), body = JSON.parse(await read(req) || 'null') as { input?: { reject?: boolean } };
      if (!key) return send(res, 400);
      const replay = idempotency.get(key);
      if (replay !== undefined) return send(res, 200, { etag: replay }, '{}');
      if (faults.bumpBeforeApply > 0) { faults.bumpBeforeApply--; records.set(id, (records.get(id) ?? 0) + 1); }
      const current = records.get(id), ifMatch = req.headers['if-match'];
      if (ifMatch !== undefined && (current === undefined || ifMatch !== etag(current))) return send(res, 412);
      if (body?.input?.reject) return send(res, 422);
      const next = (current ?? 0) + 1; records.set(id, next); idempotency.set(key, etag(next)); operations.push({ id, key, body });
      if (faults.dropAfterWrite > 0) { faults.dropAfterWrite--; req.socket.destroy(); return; }
      return send(res, 200, { etag: etag(next) }, '{}');
    }
    send(res, 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, records, idempotency, operations, faults, etag,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
