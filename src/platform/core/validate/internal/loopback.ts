/** Provider locality invariant on a parsed URL hostname. No DNS/hosts lookup or private-network inference. */
export function isLiteralLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]';
}
