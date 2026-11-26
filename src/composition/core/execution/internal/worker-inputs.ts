import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { ErrorRegistry, pathWithin, productResourcePath, readPrivateFile, privateDirectory, PrivateFileError, type ProductLayout } from '#platform/index.js';
import { nativeWorkerInputViews, nativeWorkerInputSandboxes } from '#capabilities/index.js';
import { taskInputBindingSchema } from '#engine/index.js';
import { MAX_WALK_DEPTH, createWorkspaceReadTools, resolveDockerReadOnlyMounts, BASH_LAUNCH, runShellProcess, bubblewrapArgumentPlan,
  resolveBubblewrapView, recheckRuntimeSocketMasks, argumentCountRefusal, withinBubblewrapArgumentByteBound, BUBBLEWRAP_ARGUMENT_MAX_COUNT, SANDBOX_VIEW_TOO_LARGE,
  type ShellCapabilities, type NativeCliWorkerToolContext, type ShellSandboxLayout, type ShellSandbox, type WorkerTreeGateOptions } from '#adapters/index.js';

export const prepareNativeWorkerInputs = async (resources: NativeCliWorkerToolContext, scopeId: string, project: string, workspace: string,
  layout: ProductLayout, limits: WorkerTreeGateOptions | undefined, maxBytes: number, resultBytes: number) => {
  let directory: Promise<string> | undefined;
  const custody = dirname(workspace), root = () => directory ??= (async () => {
    if (!await privateDirectory(custody)) throw new PrivateFileError('unsafe');
    return mkdtemp(join(custody, 'worker-inputs-'));
  })();
  const checkRoot = async () => { if (!await privateDirectory(custody) || !await privateDirectory(await root())) throw new PrivateFileError('unsafe'); };
  const inputs = await nativeWorkerInputViews(resources, scopeId, project, workspace, productResourcePath(layout, 'artifacts'), layout.root, limits ? { ...limits, maxDepth: MAX_WALK_DEPTH } : undefined, maxBytes, resultBytes,
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
  const sealed = resources.sealedNodeModules;
  if (!sealed) return inputs;
  await sealed.validate();
  const reader = await createWorkspaceReadTools(sealed.source, { limits: { maxResultBytes: resultBytes } });
  return { ...inputs, sealed, protectedView: true, async validate() { await sealed.validate(); await inputs.validate(); },
    async read(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      const path = args['path'];
      if (typeof path !== 'string' || !pathWithin(sealed.target, resolve(workspace, path))) return inputs.read(name, args, signal);
      if (path.split('/').includes('..')) throw ErrorRegistry.createError('NATIVE_WORKER_DEPENDENCIES_REFUSED');
      await sealed.validate();
      return reader.execute(name, { ...args, path: relative(sealed.target, resolve(workspace, path)) || '.' }, signal);
    } };
};
export const nativeWorkerViewSandboxes = (layout: ShellSandboxLayout, inputs: Awaited<ReturnType<typeof prepareNativeWorkerInputs>>, providers: readonly ShellSandbox[]) =>
  nativeWorkerInputSandboxes<ShellCapabilities, Extract<ReturnType<ShellSandbox['usable']>, { ok: true }>, ReturnType<typeof bubblewrapArgumentPlan>>(inputs, providers, {
    launcher: capabilities => capabilities.bubblewrap.launcher?.path ?? null,
    async args(request) {
      const view = await resolveBubblewrapView(layout, request.environment ?? process.env, {}, { floorReadOnly: request.writeFloorReadOnly === true,
        projectReadOnly: request.projectReadOnly === true, ...(request.writeSet ? { writeSet: request.writeSet } : {}) });
      const sealed = 'sealed' in inputs ? inputs.sealed : undefined;
      return view.ok ? bubblewrapArgumentPlan({ ...await recheckRuntimeSocketMasks(view.view), ...(sealed ? { sealedNodeModules: sealed.source, sealedLockfile: sealed.lockfile } : {}) }) : null;
    },
    async run(file, base, inputBinds, request) {
      const fail = (output: string) => ({ status: 'spawn-failed' as const, exitCode: null, signal: null,
        output, totalBytes: 0, omittedBytes: 0, durationMs: 0, cleanup: 'clean' as const });
      const remount = ['--remount-ro', '/'];
      const prefix = [...base.prefix, ...inputBinds, ...remount];
      const tail = ['--', BASH_LAUNCH.file, ...BASH_LAUNCH.args(request.command)];
      const args = [...prefix, ...tail];
      if (args.length > BUBBLEWRAP_ARGUMENT_MAX_COUNT) {
        const counts = { ...base.counts, protective: base.counts.protective + inputBinds.length, remounts: base.counts.remounts + remount.length, tail: tail.length };
        const reason = argumentCountRefusal(args.length, counts, request.environment ?? process.env);
        return fail(`[deckent] sandbox: ${SANDBOX_VIEW_TOO_LARGE}: ${reason}; nothing was run.`);
      }
      if (!withinBubblewrapArgumentByteBound(prefix)) return fail('NATIVE_WORKER_INPUT_REFUSED');
      return runShellProcess({ file, args: () => args }, 'sealed' in inputs && inputs.sealed ? {
        ...request, fixedEnv: { ...request.fixedEnv, TMPDIR: '/tmp', XDG_CACHE_HOME: '/tmp', npm_config_cache: '/tmp/npm', npm_config_offline: 'true' },
      } : request);
    } });
