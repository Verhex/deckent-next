import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { relative } from 'node:path';
import { productResourcePath, type ProductLayout } from '#platform/index.js';
import { nativeWorkerInputViews, nativeWorkerInputSandboxes } from '#capabilities/index.js';
import { taskInputBindingSchema } from '#engine/index.js';
import { MAX_WALK_DEPTH, createWorkspaceReadTools, resolveDockerReadOnlyMounts, BASH_LAUNCH, runShellProcess, bubblewrapArguments,
  resolveBubblewrapView, recheckRuntimeSocketMasks, BUBBLEWRAP_ARGUMENT_MAX_BYTES,
  type ShellCapabilities, type NativeCliWorkerToolContext, type ShellSandboxLayout, type ShellSandbox, type WorkerTreeGateOptions } from '#adapters/index.js';

export const prepareNativeWorkerInputs = (resources: NativeCliWorkerToolContext, scopeId: string, project: string, workspace: string,
  layout: ProductLayout, limits: WorkerTreeGateOptions | undefined, maxBytes: number, resultBytes: number) =>
  nativeWorkerInputViews(resources, scopeId, project, workspace, productResourcePath(layout, 'artifacts'), layout.root, limits ? { ...limits, maxDepth: MAX_WALK_DEPTH } : undefined, maxBytes, resultBytes,
    { lstat, readdir, realpath, open: path => open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
      admitInput: row => { const value = { ...row }; Reflect.deleteProperty(value, 'path'); taskInputBindingSchema.parse(value); },
      admitMount: async mount => { await resolveDockerReadOnlyMounts(project, [{ ...mount, source: relative(project, mount.source) }], [workspace, layout.root]); },
      readTools: createWorkspaceReadTools });
export const nativeWorkerViewSandboxes = (layout: ShellSandboxLayout, inputs: Awaited<ReturnType<typeof prepareNativeWorkerInputs>>, providers: readonly ShellSandbox[]) =>
  nativeWorkerInputSandboxes<ShellCapabilities, Extract<ReturnType<ShellSandbox['usable']>, { ok: true }>>(inputs, providers, { launcher: capabilities => capabilities.bubblewrap.launcher?.path ?? null, maxArgumentBytes: BUBBLEWRAP_ARGUMENT_MAX_BYTES,
    async args(request) {
      const view = await resolveBubblewrapView(layout, request.environment ?? process.env, {}, { floorReadOnly: request.writeFloorReadOnly === true,
        projectReadOnly: request.projectReadOnly === true, ...(request.writeSet ? { writeSet: request.writeSet } : {}) });
      return view.ok ? bubblewrapArguments(await recheckRuntimeSocketMasks(view.view)) : null;
    }, run: (file, args, request) => runShellProcess({ file, args: command => [...args, '--', BASH_LAUNCH.file, ...BASH_LAUNCH.args(command)] }, request) });
