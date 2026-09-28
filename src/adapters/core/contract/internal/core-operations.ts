import { CORE_API_VERSION, adapterModuleManifestSchema, type OperationDescriptor } from '#domain/index.js';
import type { AdapterModuleRegistration } from '#engine/index.js';
import { WORKSPACE_FILE_WRITE_OPERATION } from '#adapters/core/workspace-write/index.js';
import { HOST_SHELL_RUN_OPERATION } from '#adapters/core/host-shell/index.js';
import { SCRATCH_FILE_WRITE_OPERATION } from '#adapters/core/scratch-store/index.js';
import { NETWORK_FETCH_OPERATION } from '#adapters/core/http-fetch/index.js';
import { MCP_TOOL_CALL_OPERATION } from '#adapters/core/mcp-client/index.js';

/** Registry entry of a Core target whose operation lives in code: the manifest carries the descriptor, no config-built adapter (the
 * target is constructed by its own producer with workspace scope or shell settings, never from `operations.targets`). Being a root entry
 * comes from composition passing it at registry construction; it is what reserves the operation id and its target kind against config. */
const coreOperationModule = (id: string, descriptor: OperationDescriptor): AdapterModuleRegistration => Object.freeze({
  manifest: adapterModuleManifestSchema.parse({ schemaVersion: 1, module: { id, version: '1', tier: 'core', namespace: null },
    requires: { coreApi: { min: CORE_API_VERSION, max: CORE_API_VERSION } }, provides: { targetAdapters: [], operations: [descriptor] }, signature: null }),
  factories: Object.freeze({}),
});
/** `workspace.file.write@1` on the `workspace-file` target (agent edits). */
export const coreWorkspaceWriteModule = coreOperationModule('core.workspace-write', WORKSPACE_FILE_WRITE_OPERATION);
/** `host.shell.run@1` on the `host-shell` target (agent shell commands). */
export const coreHostShellModule = coreOperationModule('core.host-shell', HOST_SHELL_RUN_OPERATION);
/** `workspace.scratch.write@1` on the `scratch-file` target (the agent's scratch area, SCR-A). */
export const coreScratchWriteModule = coreOperationModule('core.scratch-write', SCRATCH_FILE_WRITE_OPERATION);
/** `network.fetch@1` on the `network-fetch` target (the agent's `fetch_url`, FETCH S7): closes the `network` namespace to overlays. */
export const coreNetworkFetchModule = coreOperationModule('core.network-fetch', NETWORK_FETCH_OPERATION);
/** `mcp.tool.call@1` on the `mcp-tool` target (the agent's pinned MCP tools, MCP-CLIENT): closes the `mcp` namespace to overlays. */
export const coreMcpToolCallModule = coreOperationModule('core.mcp-tool-call', MCP_TOOL_CALL_OPERATION);
