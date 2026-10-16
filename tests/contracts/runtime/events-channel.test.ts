import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createServerSubscriptionChannel } from '#adapters/core/local-runtime-socket/index.js';
import { ServiceFrameDecoder } from '#adapters/index.js';
class SocketDouble extends EventEmitter {
  writes: Buffer[] = []; blocked = false; destroyed = false;
  write(bytes: Buffer) { this.writes.push(bytes); return !this.blocked; }
  destroy() { this.destroyed = true; this.emit('close'); }
}
afterEach(() => { vi.useRealTimers(); });
const token = { serviceEpoch: randomUUID(), viewId: randomUUID(), sequence: 0 };
const heartbeat = { type: 'heartbeat' as const, resume: token, observedAt: 1, freshness: 'current' as const };
it('sends separate correlated subscription frames and removes its socket listeners on finish', async () => {
  const socket = new SocketDouble(), channel = createServerSubscriptionChannel(socket as unknown as Socket, 'request', 4096);
  await channel.send(heartbeat, 100); await channel.send({ type: 'close', reason: 'service-shutdown', resume: token }, 100);
  const frames = socket.writes.map(bytes => { const decoder = new ServiceFrameDecoder(4096); decoder.push(bytes); return decoder.finish(); });
  expect(frames).toMatchObject([{ kind: 'subscription', requestId: 'request', sequence: 0, item: heartbeat }, { kind: 'subscription', sequence: 1, item: { type: 'close' } }]);
  channel.finish(); expect(socket.listenerCount('close')).toBe(0); expect(socket.listenerCount('error')).toBe(0);
});
it('waits for one socket drain and times out by disconnecting only its own observation channel', async () => {
  vi.useFakeTimers(); const socket = new SocketDouble(); socket.blocked = true;
  const channel = createServerSubscriptionChannel(socket as unknown as Socket, 'request', 4096);
  const pending = channel.send(heartbeat, 20); const rejected = expect(pending).rejects.toThrow('RUNTIME_EVENTS_SLOW_CONSUMER');
  await vi.advanceTimersByTimeAsync(20); await rejected; expect(channel.signal.aborted).toBe(true); expect(socket.destroyed).toBe(true);
  expect(socket.writes).toHaveLength(1); expect(socket.listenerCount('drain')).toBe(0); channel.finish();
});
it('disconnect releases a pending drain without an execution cancellation hook', async () => {
  const socket = new SocketDouble(); socket.blocked = true;
  const channel = createServerSubscriptionChannel(socket as unknown as Socket, 'request', 4096);
  const pending = channel.send(heartbeat, 100); socket.destroy(); await expect(pending).rejects.toThrow('RUNTIME_EVENTS_DISCONNECTED');
  expect(channel.signal.aborted).toBe(true); channel.finish();
});
it('refuses an event that cannot fit the delivery frame before socket write', async () => {
  const socket = new SocketDouble(), channel = createServerSubscriptionChannel(socket as unknown as Socket, 'request', 8);
  await expect(channel.send(heartbeat, 100)).rejects.toHaveProperty('code'); expect(socket.writes).toEqual([]); channel.finish();
});
