import type { Readable, Writable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { beuserBindingSchema, type BeuserBinding } from '#domain/core/beuser/index.js';
import { verifiedPrincipalSchema } from '#domain/index.js';
import { assertBeuserAccess, pinBeuserLimits, type BeuserContext, type BeuserScreen, type SurfacePort } from '#engine/core/beuser-contract/index.js';
import { catalogCommand, type SurfaceCommand } from './argv.js';
import { SurfaceCapture, surfaceDigest, type HarnessAction, type HarnessProcess, type HarnessSink } from './capture.js';
import { atomicKey, BeuserSurfaceError, literalInput, positive } from './input.js';
import { BeuserScreenRenderer, type ScreenSize } from './screen.js';

/** C2 launches the packaged Python driver INSIDE the admitted realm and supplies its private pipes.
 * Boot argv/catalog/secret FD configuration is C2-owned. No host spawn, path or socket selection here.
 */
export interface RealmDriverIO {
  readonly input: Writable; readonly output: Readable;
  /** Ends the driver; C2 independently settles cleanup/quarantine of the entire realm. */
  cancel(reason: string): Promise<void>;
}
export interface BeuserRealmChannel {
  readonly binding: BeuserBinding;
  verify(context: BeuserContext): Promise<void>;
  open(context: BeuserContext, size: ScreenSize, bounds: SurfaceBounds): Promise<RealmDriverIO>;
  /** Trusted C2 readback confirms completion, old process destruction and closed secret FDs.
   * Returns a newly bootstrapped driver with no secret descriptors or old terminal state.
   * The referenced retained evidence is checked by C6/C7; a walker cannot call this capability.
   */
  restartAfterSecret?(context: BeuserContext, size: ScreenSize, bounds: SurfaceBounds): Promise<{ readonly io: RealmDriverIO; readonly evidenceRef: string }>;
  cancel(context: BeuserContext, reason: string): Promise<void>;
}
export interface SurfaceBounds {
  readonly quietMs: number; readonly inactivityMs: number; readonly maxInputBytes: number;
}
const replySchema = z.object({ id: z.number().int().positive().safe(), data: z.string(),
  state: z.enum(['ready', 'eof', 'secret', 'unavailable', 'invalid', 'limit', 'timeout']),
  exitCode: z.number().int().nullable(), columns: z.number().int().positive(), rows: z.number().int().positive() }).strict();
type DriverReply = z.infer<typeof replySchema>;

class DriverProtocol {
  private buffer = Buffer.alloc(0);
  private next = 0;
  private ended = false;
  private pending: { id: number; resolve: (reply: DriverReply) => void; reject: (error: Error) => void } | undefined;
  constructor(private readonly io: RealmDriverIO, private readonly maxBytes: number, private readonly nonce: string) {
    io.output.on('data', (data: Buffer) => this.receive(data));
    io.output.on('end', () => this.fail(new BeuserSurfaceError('BEUSER_SURFACE_EOF')));
    io.output.on('error', () => this.fail(new BeuserSurfaceError('BEUSER_SURFACE_UNAVAILABLE')));
    io.input.on('error', () => this.fail(new BeuserSurfaceError('BEUSER_SURFACE_UNAVAILABLE')));
  }
  private fail(error: Error): void { this.ended = true; this.buffer = Buffer.alloc(0); this.pending?.reject(error); this.pending = undefined; }
  private receive(data: Buffer): void {
    if (this.ended) return;
    if (!Buffer.isBuffer(data) || this.buffer.length + data.length > this.maxBytes) { this.fail(new BeuserSurfaceError('BEUSER_SURFACE_LIMIT')); return; }
    this.buffer = Buffer.concat([this.buffer, data]);
    const end = this.buffer.indexOf(10);
    if (end < 0) return;
    try {
      const parsed = replySchema.parse(JSON.parse(this.buffer.subarray(0, end).toString('utf8')));
      if (!this.pending || parsed.id !== this.pending.id || end !== this.buffer.length - 1
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(parsed.data)) throw new Error();
      const pending = this.pending;
      this.pending = undefined; this.buffer = Buffer.alloc(0); pending.resolve(parsed);
    } catch { this.fail(new BeuserSurfaceError('BEUSER_SURFACE_INVALID')); }
  }
  async request(command: Readonly<Record<string, unknown>>): Promise<DriverReply> {
    if (this.ended) throw new BeuserSurfaceError('BEUSER_SURFACE_EOF');
    if (this.pending) throw new BeuserSurfaceError('BEUSER_SURFACE_BUSY');
    const id = ++this.next, wire = JSON.stringify({ ...command, id, nonce: this.nonce }) + '\n';
    if (Buffer.byteLength(wire) > this.maxBytes) throw new BeuserSurfaceError('BEUSER_SURFACE_LIMIT');
    return new Promise<DriverReply>((resolve, reject) => {
      this.pending = { id, resolve, reject };
      this.io.input.write(wire, error => { if (error) this.fail(new BeuserSurfaceError('BEUSER_SURFACE_UNAVAILABLE')); });
    });
  }
  close(): void { this.fail(new BeuserSurfaceError('BEUSER_SURFACE_EOF')); }
}

export interface BeuserSurfaceOptions {
  readonly context: BeuserContext; readonly realm: BeuserRealmChannel; readonly size: ScreenSize;
  readonly bounds: SurfaceBounds; readonly catalog: readonly SurfaceCommand[]; readonly sink: HarnessSink;
}
export interface BeuserSurface extends SurfacePort {
  resize(context: BeuserContext, columns: number, rows: number): Promise<BeuserScreen>;
  /** Trusted harness only. Values are resolved by opaque FD inside the realm; capture remains closed. */
  secret(context: BeuserContext, opaqueRef: string): Promise<void>;
  resumeAfterSecret(context: BeuserContext): Promise<BeuserScreen>;
  close(context: BeuserContext): Promise<void>;
}

export function createBeuserSurface(options: BeuserSurfaceOptions): BeuserSurface {
  const { realm, sink } = options;
  const admitted: BeuserContext = { binding: beuserBindingSchema.parse(options.context.binding),
    principal: verifiedPrincipalSchema.parse(options.context.principal), limits: pinBeuserLimits(options.context.limits), signal: options.context.signal };
  // Node timers outside this protocol range wrap to 1 ms; never silently shorten an admitted budget.
  if ([admitted.limits.maxWallMs, admitted.limits.maxWaitMs, admitted.limits.cleanupDeadlineMs].some(ms => ms > 0x7fffffff)) throw new BeuserSurfaceError('BEUSER_SURFACE_LIMIT');
  const bounds = Object.freeze({ ...options.bounds }), size = Object.freeze({ ...options.size });
  const catalog = options.catalog.map(row => Object.freeze({ commandId: row.commandId, args: Object.freeze([...row.args]) }));
  positive(bounds.quietMs); positive(bounds.inactivityMs); positive(bounds.maxInputBytes);
  if (bounds.quietMs > bounds.inactivityMs || bounds.inactivityMs > admitted.limits.maxWaitMs
    || bounds.maxInputBytes > admitted.limits.maxArtifactBytes) throw new BeuserSurfaceError('BEUSER_SURFACE_LIMIT');
  assertBeuserAccess(admitted, realm.binding, admitted.principal, { kind: 'beuser-sandbox', id: realm.binding.realmId }, 'create');
  let renderer = new BeuserScreenRenderer(size, admitted.limits.maxArtifactBytes);
  const capture = new SurfaceCapture(admitted, sink);
  const started = performance.now();
  let busy = false, closed = false, secret = false, steps = 0, rawBytes = 0, io: RealmDriverIO | undefined, driver: DriverProtocol | undefined;
  let currentSize = size;
  let lastProcess: HarnessProcess = { state: 'ready', exitCode: null };
  const elapsed = () => Math.floor(performance.now() - started);
  const access = (context: BeuserContext) => {
    context.signal.throwIfAborted();
    assertBeuserAccess(admitted, context.binding, context.principal, { kind: 'beuser-sandbox', id: context.binding.realmId }, 'create');
    assertBeuserAccess(admitted, realm.binding, admitted.principal, { kind: 'beuser-sandbox', id: realm.binding.realmId }, 'create');
  };
  const stop = async (reason: string) => {
    if (closed) return;
    closed = true; driver?.close(); renderer.dispose();
    clearTimeout(wallTimer);
    admitted.signal.removeEventListener('abort', onAbort);
    const cleanup = Promise.allSettled([Promise.resolve().then(() => io?.cancel(reason)), Promise.resolve().then(() => realm.cancel(admitted, reason))]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const results = await Promise.race([cleanup, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BeuserSurfaceError('BEUSER_SURFACE_UNAVAILABLE')), admitted.limits.cleanupDeadlineMs);
      })]);
      if (results.some(result => result.status === 'rejected')) throw new BeuserSurfaceError('BEUSER_SURFACE_UNAVAILABLE');
    } finally { if (timer) clearTimeout(timer); }
  };
  const onAbort = () => { void stop('cancelled').catch(() => {}); };
  const wallTimer = setTimeout(() => { void stop('wall-limit').catch(() => {}); }, admitted.limits.maxWallMs);
  wallTimer.unref();
  admitted.signal.addEventListener('abort', onAbort, { once: true });
  const execute = async <T>(context: BeuserContext, work: () => Promise<T>): Promise<T> => {
    access(context);
    if (closed) throw new BeuserSurfaceError('BEUSER_SURFACE_EOF');
    if (busy) throw new BeuserSurfaceError('BEUSER_SURFACE_BUSY');
    if (++steps > admitted.limits.maxSteps || elapsed() >= admitted.limits.maxWallMs) {
      await stop('limit'); throw new BeuserSurfaceError('BEUSER_SURFACE_LIMIT');
    }
    busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const result = await Promise.race([Promise.resolve().then(async () => {
        access(context); await realm.verify(admitted); access(context);
        if (closed) throw new BeuserSurfaceError('BEUSER_SURFACE_EOF');
        if (!driver) {
          io = await realm.open(admitted, size, bounds);
          if (closed) { await io.cancel('cancelled'); throw new BeuserSurfaceError('BEUSER_SURFACE_EOF'); }
          driver = new DriverProtocol(io, admitted.limits.maxTranscriptBytes * 2, admitted.binding.nonce);
        }
        access(context);
        return work();
      }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BeuserSurfaceError('BEUSER_SURFACE_LIMIT')),
          Math.min(admitted.limits.maxWallMs - elapsed(), admitted.limits.maxWaitMs));
        abort = () => reject(new BeuserSurfaceError('BEUSER_SURFACE_EOF'));
        context.signal.addEventListener('abort', abort, { once: true });
        if (context.signal.aborted) abort();
      })]);
      access(context);
      return result;
    } catch (error) { await stop('interrupted'); throw error; }
    finally { busy = false; if (timer) clearTimeout(timer); if (abort) context.signal.removeEventListener('abort', abort); }
  };
  const request = async (command: Readonly<Record<string, unknown>>): Promise<DriverReply> => {
    if (closed || elapsed() >= admitted.limits.maxWallMs) throw new BeuserSurfaceError('BEUSER_SURFACE_LIMIT');
    const reply = await driver!.request({ ...command, quietMs: bounds.quietMs, inactivityMs: bounds.inactivityMs });
    if (reply.state === 'secret') { capture.block(); renderer.dispose(); throw new BeuserSurfaceError('BEUSER_CAPTURE_BLOCKED'); }
    if (reply.state === 'invalid') throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
    if (reply.state === 'limit' || reply.state === 'timeout') throw new BeuserSurfaceError('BEUSER_SURFACE_LIMIT');
    if (reply.state === 'unavailable') throw new BeuserSurfaceError('BEUSER_SURFACE_UNAVAILABLE');
    lastProcess = { state: reply.state === 'eof' ? 'eof' : 'ready', exitCode: reply.exitCode };
    const bytes = Buffer.from(reply.data, 'base64');
    rawBytes += bytes.length;
    if (rawBytes > admitted.limits.maxTranscriptBytes) throw new BeuserSurfaceError('BEUSER_SURFACE_LIMIT');
    await renderer.write(bytes);
    if (reply.columns !== renderer.dimensions.columns || reply.rows !== renderer.dimensions.rows) throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
    if (reply.state === 'eof') renderer.finish();
    // An incomplete code point/control is a continuation read, never a partial screenshot or repeated effect.
    if (!renderer.complete) {
      if (!bytes.length) throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
      return request({ op: 'read', ms: bounds.inactivityMs });
    }
    return reply;
  };
  const screen = async (): Promise<BeuserScreen> => {
    capture.assertOpen();
    const rendered = renderer.snapshot(), sequence = await capture.record('screen', elapsed(), rendered, undefined, lastProcess);
    return { binding: admitted.binding, sequence, text: rendered.text, digest: surfaceDigest(rendered.text) };
  };
  const action = (context: BeuserContext, command: Readonly<Record<string, unknown>>, detail: HarnessAction, synthetic = false) => execute(context, async () => {
    capture.assertOpen();
    await capture.record(synthetic ? 'synthetic-person-decision' : 'action', elapsed(), undefined, detail);
    await request(command); return screen();
  });
  return {
    look: context => execute(context, async () => { capture.assertOpen(); await request({ op: 'read', ms: bounds.quietMs }); return screen(); }),
    type: (context, text) => action(context, { op: 'input', text: literalInput(text, bounds.maxInputBytes) }, { kind: 'type' }),
    press: (context, key) => action(context, { op: 'input', text: atomicKey(key, renderer.applicationCursor) }, { kind: 'press', key }, true),
    wait: (context, ms) => {
      positive(ms); if (ms > admitted.limits.maxWaitMs) throw new BeuserSurfaceError('BEUSER_SURFACE_LIMIT');
      return execute(context, async () => { capture.assertOpen(); await request({ op: 'read', ms }); return screen(); });
    },
    argv: (context, command) => {
      const validated = catalogCommand(command, catalog, bounds.maxInputBytes);
      return action(context, { op: 'argv', ...validated }, { kind: 'argv', commandId: validated.commandId });
    },
    resize: (context, columns, rows) => execute(context, async () => {
      capture.assertOpen(); renderer.resize(columns, rows);
      currentSize = { columns, rows, scrollback: size.scrollback };
      await request({ op: 'resize', columns, rows }); return screen();
    }),
    secret: (context, opaqueRef) => execute(context, async () => {
      if (!/^[a-zA-Z0-9_.:-]+$/u.test(opaqueRef) || Buffer.byteLength(opaqueRef) > bounds.maxInputBytes) throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
      secret = true; capture.block(); renderer.dispose(); await capture.record('secret-step', elapsed());
      const reply = await driver!.request({ op: 'secret', ref: opaqueRef, quietMs: bounds.quietMs, inactivityMs: bounds.inactivityMs });
      if (reply.state !== 'secret' || reply.data !== '') throw new BeuserSurfaceError('BEUSER_CAPTURE_BLOCKED');
    }),
    resumeAfterSecret: context => execute(context, async () => {
      if (!secret || !realm.restartAfterSecret) throw new BeuserSurfaceError('BEUSER_SURFACE_UNAVAILABLE');
      driver!.close(); await io!.cancel('secret-reset');
      const reset = await realm.restartAfterSecret(admitted, currentSize, bounds);
      try {
        access(context);
        if (closed || !reset.evidenceRef || /[\p{Cc}\p{Cs}]/u.test(reset.evidenceRef) || Buffer.byteLength(reset.evidenceRef) > bounds.maxInputBytes) throw new BeuserSurfaceError('BEUSER_CAPTURE_BLOCKED');
      } catch (error) { await reset.io.cancel('invalid-reset'); throw error; }
      io = reset.io; driver = new DriverProtocol(io, admitted.limits.maxTranscriptBytes * 2, admitted.binding.nonce);
      renderer = new BeuserScreenRenderer(currentSize, admitted.limits.maxArtifactBytes);
      secret = false; capture.reopen();
      await capture.record('action', elapsed(), undefined, { kind: 'capture-reset', evidenceRef: reset.evidenceRef });
      await request({ op: 'read', ms: bounds.quietMs }); return screen();
    }),
    close: async context => { access(context); await stop('closed'); },
  };
}
