/** The one rule for where a provider key may travel (owner 2026-10-18, G2-7: "no key over plain http"): only over https. A plain-http endpoint,
 * loopback included, never receives a key — not by the connection check, the model listing, the invocation profile or a call. */
export function endpointMayCarryKey(url: string | URL): boolean {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}
