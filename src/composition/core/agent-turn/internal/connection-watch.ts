/** How often a turn asks the transport whether its client is still there (a turn waiting on an owner writes nothing that could fail). */
export const CONNECTION_WATCH_MS = 250;

/**
 * A client that closes while the service has nothing to write (an approval card waiting for the owner) is not seen by the stream's
 * writes. The transport's own liveness witness is polled instead; a gone client aborts the returned signal, which is the turn's
 * cancellation, so a waiting approval settles `cancelled`/`expired` through the existing wait and never becomes an allow.
 * `stop` releases the timer when the turn ends.
 */
export function watchTurnConnection(peer: { readonly isConnectionActive?: () => boolean }, intervalMs = CONNECTION_WATCH_MS): { readonly signal: AbortSignal; stop(): void } {
  const controller = new AbortController();
  const active = peer.isConnectionActive;
  if (!active) return { signal: controller.signal, stop() {} };
  const timer = setInterval(() => {
    const alive = (() => { try { return active(); } catch { return false; } })();
    if (!alive) { clearInterval(timer); controller.abort(); }
  }, intervalMs);
  timer.unref();
  return { signal: controller.signal, stop() { clearInterval(timer); } };
}
