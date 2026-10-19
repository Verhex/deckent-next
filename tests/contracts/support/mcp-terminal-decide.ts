import { afterEach } from 'vitest';
import { withLocalPrincipalChannel, type LocalPeerIdentity } from '#adapters/index.js';
import { runConfiguredMcpCommand } from '#composition/core/agent-turn/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { createTerminalRuntimeClient, terminalRuntimePeer } from './terminal-runtime-client.js';

// SEC-1 × C-MODELS (owner A48-D5, J2e join): an MCP trust decision is an authority write, witnessed by the deciding peer's controlling terminal
// before any card, start, audit or write. Registry tests that decide trust through the application (the card answered by the test, as a person
// answers it) first prove the same request is refused from this non-TTY process (AUTHORITY_WITNESS_REQUIRED), then decide it with a live PTY
// process as the peer (the existing W3-AUTHORITY transport fixture); the attestation itself is never mocked.
type Run = typeof runConfiguredMcpCommand;
const peers = new Map<string, Promise<LocalPeerIdentity>>();
afterEach(() => { peers.clear(); });

/** `runConfiguredMcpCommand` for a trust decision: refused without a terminal first (a request refused before its card keeps its own refusal),
 * then decided with a real PTY peer. */
export async function witnessedMcpCommand(root: string, request: Parameters<Run>[1], options: ConfigLoadOptions, ask: Parameters<Run>[3], locale?: Parameters<Run>[4]): Promise<unknown> {
  const refusal = await runConfiguredMcpCommand(root, request, options, ask, locale).then(() => null, (error: unknown) => error as { code?: string });
  if (refusal === null) throw new Error(`a non-TTY MCP trust decision was not refused: ${JSON.stringify(request)}`);
  if (refusal.code !== 'AUTHORITY_WITNESS_REQUIRED') throw refusal;
  const key = JSON.stringify([root, options]);
  if (!peers.has(key)) peers.set(key, terminalRuntimePeer(createTerminalRuntimeClient(root, options)));
  const peer = await peers.get(key)!;
  return withLocalPrincipalChannel(undefined, () => runConfiguredMcpCommand(root, request, options, ask, locale), peer);
}
