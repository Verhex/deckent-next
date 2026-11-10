import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { productResourcePath, readPrivateFile, privateDirectory, PrivateFileError, type ProductLayout } from '#platform/index.js';
import { nativeWorkerInputViews, nativeWorkerInputSandboxes } from '#capabilities/index.js';
import { taskInputBindingSchema } from '#engine/index.js';
import { MAX_WALK_DEPTH, createWorkspaceReadTools, resolveDockerReadOnlyMounts, BASH_LAUNCH, runShellProcess, bubblewrapArguments,
  resolveBubblewrapView, recheckRuntimeSocketMasks, BUBBLEWRAP_ARGUMENT_MAX_BYTES,
  type ShellCapabilities, type NativeCliWorkerToolContext, type ShellSandboxLayout, type ShellSandbox, type WorkerTreeGateOptions } from '#adapters/index.js';

export const prepareNativeWorkerInputs = (resources: NativeCliWorkerToolContext, scopeId: string, project: string, workspace: string,
  layout: ProductLayout, limits: WorkerTreeGateOptions | undefined, maxBytes: number, resultBytes: number) => {
  let directory: Promise<string> | undefined;
  const custody = dirname(workspace), root = () => directory ??= (async () => {
    if (!await privateDirectory(custody)) throw new PrivateFileError('unsafe');
    return mkdtemp(join(custody, 'worker-inputs-'));
  })();
  const checkRoot = async () => { if (!await privateDirectory(custody) || !await privateDirectory(await root())) throw new PrivateFileError('unsafe'); };
  return nativeWorkerInputViews(resources, scopeId, project, workspace, productResourcePath(layout, 'artifacts'), layout.root, limits ? { ...limits, maxDepth: MAX_WALK_DEPTH } : undefined, maxBytes, resultBytes,
    { lstat, readdir, realpath, open: path => open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
      async copy(path, bytes, mode = 0) {
        const target = join(await root(), path);
        if (bytes === null) await mkdir(target, { mode: 0o700 });
        else {
          const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400 | mode & 0o100);
          try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        }
        return target;
      },
      checkCopyCustody: checkRoot,
      async readCopy(path, maxBytes) {
        if ((await lstat(path)).mode & 0o200) throw new PrivateFileError('unsafe');
        const data = await readPrivateFile(path, maxBytes, { mode: 'mask' });
        if (data === null) throw new PrivateFileError('changed'); return data;
      },
      async directorySeal(path) {
        if (!await privateDirectory(path)) throw new PrivateFileError('unsafe');
        const info = await lstat(path); return JSON.stringify([info.dev, info.ino, info.mtimeMs, info.ctimeMs]);
      },
      admitInput: row => { const value = { ...row }; Reflect.deleteProperty(value, 'path'); taskInputBindingSchema.parse(value); },
      admitMount: async mount => { await resolveDockerReadOnlyMounts(project, [{ ...mount, source: relative(project, mount.source) }], [workspace, layout.root]); },
      readTools: createWorkspaceReadTools });
};
export const nativeWorkerViewSandboxes = (layout: ShellSandboxLayout, inputs: Awaited<ReturnType<typeof prepareNativeWorkerInputs>>, providers: readonly ShellSandbox[]) =>
  nativeWorkerInputSandboxes<ShellCapabilities, Extract<ReturnType<ShellSandbox['usable']>, { ok: true }>>(inputs, providers, { launcher: capabilities => capabilities.bubblewrap.launcher?.path ?? null, maxArgumentBytes: BUBBLEWRAP_ARGUMENT_MAX_BYTES,
    async args(request) {
      const view = await resolveBubblewrapView(layout, request.environment ?? process.env, {}, { floorReadOnly: request.writeFloorReadOnly === true,
        projectReadOnly: request.projectReadOnly === true, ...(request.writeSet ? { writeSet: request.writeSet } : {}) });
      return view.ok ? bubblewrapArguments(await recheckRuntimeSocketMasks(view.view)) : null;
    }, run: (file, args, request) => runShellProcess({ file, args: command => [...args, '--', BASH_LAUNCH.file, ...BASH_LAUNCH.args(command)] }, request) });
