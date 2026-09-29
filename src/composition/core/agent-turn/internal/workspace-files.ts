import { workspaceAttachmentRequestSchema, workspaceFileQuerySchema, WORKSPACE_ATTACHMENT_MAX_BYTES, type WorkspaceAttachment, type WorkspaceFileMatches } from '#domain/index.js';
import { AgentTurnStoreError, type ModelInvocationDelivery } from '#engine/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { createWorkspaceScope, rankWorkspacePaths, readWorkspaceAttachment, type LocalPeerIdentity, type RuntimeWorkspaceFileHost } from '#adapters/index.js';
import { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import { agentWorkspaceDeny } from './turn.js';

const resultBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Composer `@file` operations inside the runtime service (T-L5, protocol v15). The caller is the connection's verified peer and
 * must be a member of the scope under current policy (read access); files come only from the project workspace through the
 * read adapter's boundary with the agent tools' deny for this layout (Core floor plus the layout's approval records and previews
 * inside the project), no symlink followed, regular single-link files. The attached content is the user's
 * own context for their next message, like a paste: it is bounded here and grants nothing.
 */
export async function findPeerWorkspaceFiles(projectRoot: string, input: unknown, peer: LocalPeerIdentity, options: ConfigLoadOptions,
  delivery: ModelInvocationDelivery, host: RuntimeWorkspaceFileHost): Promise<WorkspaceFileMatches> {
  const parsed = workspaceFileQuerySchema.safeParse(input);
  if (!parsed.success) throw new AgentTurnStoreError('AGENT_TURN_INVALID');
  const query = parsed.data;
  const context = await loadPeerInvocationContext(projectRoot, query.scopeId, options, peer, 'read');
  const index = await host.index(projectRoot, agentWorkspaceDeny(projectRoot, context.layout));
  const paths = rankWorkspacePaths(index.paths, query.query, query.limit);
  // The answer always fits the caller's delivery bound: the lowest-ranked candidates are dropped first.
  while (paths.length > 0 && resultBytes({ schemaVersion: 1, paths, truncated: true, incomplete: true }) > delivery.maxResultBytes) paths.pop();
  return Object.freeze({ schemaVersion: 1, paths, truncated: index.truncated, incomplete: index.incomplete });
}

export async function attachPeerWorkspaceFile(projectRoot: string, input: unknown, peer: LocalPeerIdentity, options: ConfigLoadOptions,
  delivery: ModelInvocationDelivery, signal?: AbortSignal): Promise<WorkspaceAttachment> {
  const parsed = workspaceAttachmentRequestSchema.safeParse(input);
  if (!parsed.success) throw new AgentTurnStoreError('AGENT_TURN_INVALID');
  const request = parsed.data;
  const context = await loadPeerInvocationContext(projectRoot, request.scopeId, options, peer, 'read');
  const scope = await createWorkspaceScope(projectRoot, agentWorkspaceDeny(projectRoot, context.layout));
  let maxBytes = Math.min(request.maxBytes, WORKSPACE_ATTACHMENT_MAX_BYTES);
  for (;;) {
    const read = await readWorkspaceAttachment(scope, request.path, maxBytes, signal);
    const result: WorkspaceAttachment = read.status === 'refused'
      ? { schemaVersion: 1, path: read.path, status: 'refused', reason: read.reason }
      : { schemaVersion: 1, path: read.path, status: 'attached', content: read.content, bytes: read.bytes, totalBytes: read.totalBytes, truncated: read.truncated };
    // JSON escaping can grow content (quotes, control characters): shrink the prefix until the answer fits the delivery bound.
    const size = resultBytes(result);
    if (size <= delivery.maxResultBytes || result.status === 'refused') return Object.freeze(result);
    const next = Math.floor(maxBytes * delivery.maxResultBytes / size * 0.9);
    if (next < 1 || next >= maxBytes) throw new AgentTurnStoreError('AGENT_TURN_INVALID');
    maxBytes = next;
  }
}
