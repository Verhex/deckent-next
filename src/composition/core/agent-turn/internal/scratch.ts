import { join } from 'node:path';
import { scratchQuerySchema, type ScratchClearance, type ScratchView } from '#domain/index.js';
import { AgentTurnStoreError, type ModelInvocationDelivery } from '#engine/index.js';
import { inspectProductDirectory, loadConfig, ManagedFileError, productResourcePath, type ConfigLoadOptions, type ProductLayout } from '#platform/index.js';
import { clearScratchSession, inspectScratchSession, readTerminalScratchConfig, scratchSessionKey, type LocalPeerIdentity } from '#adapters/index.js';
import { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';

/** The layout's scratch resource when it exists (a missing one holds nothing: null); an unsafe one throws. Never created here. */
export async function scratchResource(layout: ProductLayout): Promise<string | null> {
  try { return await inspectProductDirectory(layout, 'scratch'); }
  catch (error) { if (error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING') return null; throw error; }
}

/**
 * `/scratch` inside the runtime service (v16, SCR-A): the caller's own area of one conversation — the connection's verified peer, a
 * member of the scope under current policy (read access to look, write access to empty it). No policy grant beyond membership: the
 * area is the person's own temporary space. The view is newest first and bounded to the caller's delivery (older files are dropped).
 */
export async function executePeerScratchOperation(projectRoot: string, operation: 'inspectScratch' | 'clearScratch', input: unknown, peer: LocalPeerIdentity,
  options: ConfigLoadOptions, delivery: ModelInvocationDelivery): Promise<ScratchView | ScratchClearance> {
  const parsed = scratchQuerySchema.safeParse(input);
  if (!parsed.success) throw new AgentTurnStoreError('AGENT_TURN_INVALID');
  const query = parsed.data;
  const context = await loadPeerInvocationContext(projectRoot, query.scopeId, options, peer, operation === 'clearScratch' ? 'write' : 'read');
  const limits = readTerminalScratchConfig(await loadConfig(projectRoot, { ...options, heal: false }) as Record<string, unknown>);
  const key = scratchSessionKey({ scopeId: query.scopeId, principal: context.principal, sessionId: query.sessionId }), root = await scratchResource(context.layout);
  const path = join(productResourcePath(context.layout, 'scratch'), ...key.split('/'));
  if (operation === 'clearScratch') return Object.freeze({ schemaVersion: 1, ...(root ? await clearScratchSession(root, key) : { path, removedFiles: 0, removedBytes: 0 }) });
  const found = root ? await inspectScratchSession(root, key) : { path, exists: false, bytes: 0, truncated: false, files: [] };
  const view = { schemaVersion: 1 as const, ...found, files: [...found.files], limits: { writeMaxBytes: limits.writeMaxBytes, sessionMaxBytes: limits.sessionMaxBytes,
    retentionDays: limits.retentionDays } };
  while (view.files.length > 0 && Buffer.byteLength(JSON.stringify(view), 'utf8') > delivery.maxResultBytes) { view.files.pop(); view.truncated = true; }
  return Object.freeze(view);
}
