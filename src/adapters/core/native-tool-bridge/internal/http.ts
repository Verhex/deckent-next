import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';

/** Protocol codes only; person-facing explanations belong to the shared reason catalogs. */
export function refuseBridge(response: ServerResponse, status: number, reason: string): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify({ jsonrpc: '2.0', id: null,
    error: { code: -32000, message: reason, data: { reason } } }));
}

/** Bounded before JSON parsing, including chunked uploads; never retain a rejected body. */
export async function bridgeBody(request: IncomingMessage, maxBytes: number, count: (bytes: number) => boolean): Promise<unknown> {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) throw new Error('NATIVE_BRIDGE_BODY_LIMIT');
  const chunks: Buffer[] = []; let size = 0;
  await new Promise<void>((resolve, reject) => {
    const clean = () => { request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', aborted); };
    const error = () => { clean(); reject(new Error('NATIVE_BRIDGE_BODY_LIMIT')); };
    const aborted = () => error();
    const end = () => { clean(); resolve(); };
    const data = (bytes: Buffer) => {
      size += bytes.length;
      if (size > maxBytes || !count(bytes.length)) { request.pause(); error(); return; }
      chunks.push(bytes);
    };
    request.on('data', data); request.once('end', end); request.once('error', error); request.once('aborted', aborted);
  });
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
}

/** Hold a complete SSE frame before forwarding it. Backpressure never grows an unbounded queue. */
export async function bridgeResponse(source: Response, target: ServerResponse, maxBytes: number, count: (bytes: number) => boolean, project: (text: string) => string): Promise<void> {
  for (const [name, value] of source.headers) target.setHeader(name, value);
  target.writeHead(source.status); target.flushHeaders();
  if (!source.body) { target.end(); return; }
  const reader = source.body.getReader(), sse = source.headers.get('content-type')?.includes('text/event-stream');
  const close = () => { void reader.cancel().catch(() => undefined); };
  target.once('close', close);
  let pending = Buffer.alloc(0);
  const send = async (bytes: Buffer) => {
    const projected = Buffer.from(project(bytes.toString('utf8')));
    if (projected.length > maxBytes || !count(projected.length)) throw new Error('NATIVE_BRIDGE_TRAFFIC_LIMIT');
    if (!target.write(projected)) {
      const controller = new AbortController(), closed = () => controller.abort(); target.once('close', closed);
      try { await once(target, 'drain', { signal: controller.signal }); }
      finally { target.off('close', closed); }
    }
  };
  try {
    while (!target.destroyed) {
      const { value, done } = await reader.read(); if (done) break;
      pending = Buffer.concat([pending, value]);
      if (sse) {
        for (let at = pending.indexOf('\n\n'); at >= 0; at = pending.indexOf('\n\n')) {
          if (at + 2 > maxBytes) throw new Error('NATIVE_BRIDGE_FRAME_LIMIT');
          await send(pending.subarray(0, at + 2)); pending = pending.subarray(at + 2);
        }
      }
      if (pending.length > maxBytes) throw new Error('NATIVE_BRIDGE_FRAME_LIMIT');
    }
    if (pending.length && !target.destroyed) await send(pending);
    if (!target.destroyed) target.end();
  } finally { target.off('close', close); await reader.cancel().catch(() => undefined); }
}
