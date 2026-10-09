import { AsyncLocalStorage } from 'node:async_hooks';

type ProcessWitness = Readonly<{ pid: number; uid: number; connection?: AbortSignal; isConnectionActive?: () => boolean }>;
const channels = new AsyncLocalStorage<{ channel: 'mcp' | undefined; peer: ProcessWitness | undefined }>();
/** Code-only composition context. Neither configuration nor command input may select an actor. */
export const localPrincipalChannel = () => channels.getStore()?.channel;
export const localPrincipalPeer = () => channels.getStore()?.peer;
export const withLocalPrincipalChannel = <T>(channel: 'mcp' | undefined, work: () => T, peer?: ProcessWitness): T => channels.run({ channel, peer }, work);
export const withMcpPrincipal = <T>(work: () => T): T => withLocalPrincipalChannel('mcp', work, localPrincipalPeer());
