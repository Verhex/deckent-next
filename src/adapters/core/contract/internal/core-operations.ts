import { CORE_API_VERSION, adapterModuleManifestSchema, type OperationDescriptor } from '#domain/index.js';
import type { AdapterModuleRegistration } from '#engine/index.js';
import { WORKSPACE_FILE_WRITE_OPERATION } from '#adapters/core/workspace-write/index.js';
import { HOST_SHELL_RUN_OPERATION } from '#adapters/core/host-shell/index.js';

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
