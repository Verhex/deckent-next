import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ErrorRegistry } from '#platform/index.js';
import type { AgentToolOutcome, ShellRealm, ShellRealmRequest, ShellRealmResult } from '#domain/index.js';
import { artifactReceiptSchema, type ArtifactReceipt } from '#capabilities/core/artifacts/index.js';

export type NativeWorkerResources = Readonly<{ inputs?: readonly Readonly<{ name: string; sourceAttemptId: string; receipt: ArtifactReceipt; path: string }>[] | undefined;
  handoffInputs?: readonly Readonly<{ target: string; receipt: ArtifactReceipt; path: string }>[] | undefined;
  readOnlyMounts?: readonly Readonly<{ source: string; target: string }>[] | undefined }>;
export type NativeWorkerInputBounds = Readonly<{ maxFiles: number; maxFileBytes: number; maxTotalBytes: number; timeoutMs: number; maxDepth: number }>;
type FileInfo = Readonly<{ size: number; nlink: number; isDirectory(): boolean; isFile(): boolean }>;
export interface NativeWorkerInputIO {
  admitInput(row: NonNullable<NativeWorkerResources['inputs']>[number]): void;
  admitMount(row: NonNullable<NativeWorkerResources['readOnlyMounts']>[number]): Promise<void>;
  realpath(path: string): Promise<string>; lstat(path: string): Promise<FileInfo>; readdir(path: string): Promise<string[]>;
  open(path: string): Promise<{ stat(): Promise<FileInfo>; read(bytes: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>; close(): Promise<void> }>;
  readTools(root: string, options: { limits: { maxFileBytes?: number; maxResultBytes: number } }): Promise<{ execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolOutcome> }>;
}
const ENTRY_COUNT_INCREMENT = 1, SINGLE_FILE_LINK = 1, READ_SENTINEL_BYTES = 1, C_STRING_TERMINATOR_BYTES = 1;
type View = Readonly<{ source: string; target: string; file: boolean; digest?: string; byteLength?: number }>;
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
const overlap = (a: string, b: string) => inside(a, b) || inside(b, a);
const refused = () => ErrorRegistry.createError('NATIVE_WORKER_INPUT_REFUSED');
/** Trusted producer receipts plus the existing tree gate admit these views. No login-realm object receives them. */
export async function nativeWorkerInputViews(resources: NativeWorkerResources, scopeId: string, projectRoot: string, workspace: string,
  artifacts: string, stateRoot: string, limits: NativeWorkerInputBounds | undefined, maxInputBytes: number, maxResultBytes: number, io: NativeWorkerInputIO) {
  for (const row of resources.inputs ?? []) io.admitInput(row);
  const parsed = resources;
  const views: View[] = [];
  for (const input of [...(parsed.inputs ?? []).map(row => ({ ...row, target: `/deckent/inputs/${row.name}` })), ...(parsed.handoffInputs ?? [])]) {
    artifactReceiptSchema.parse(input.receipt);
    if (!/^\/deckent\/inputs\/(?:[A-Za-z0-9._-]+|_handoff\/[A-Za-z0-9_%!~*().+-]+\.json)$/u.test(input.target)) throw refused();
    if (input.receipt.scopeId !== scopeId || !inside(artifacts, input.path) || input.path === artifacts) throw refused();
    views.push({ source: input.path, target: input.target, file: true, digest: input.receipt.digest, byteLength: input.receipt.byteLength });
  }
  for (const mount of parsed.readOnlyMounts ?? []) {
    if (!inside(projectRoot, mount.source) || overlap(mount.source, workspace) || overlap(mount.source, stateRoot)) throw refused();
    await io.admitMount(mount);
    views.push({ source: mount.source, target: mount.target, file: false });
  }
  if (views.some((view, index) => views.some((other, otherIndex) => index !== otherIndex && overlap(view.target, other.target)))
    || views.some(view => overlap(view.target, workspace) || overlap(view.target, stateRoot))) throw refused();
  const validateTree = async () => {
    if (!views.length) return;
    if (!limits) throw refused();
    let files = 0, bytes = 0, inputs = 0; const started = performance.now();
    const walk = async (path: string, depth: number): Promise<void> => {
      if ((files += ENTRY_COUNT_INCREMENT) > limits.maxFiles || depth > limits.maxDepth || performance.now() - started > limits.timeoutMs || await io.realpath(path) !== path) throw refused();
      const info = await io.lstat(path);
      if (info.isDirectory()) { for (const name of await io.readdir(path)) await walk(join(path, name), depth + ENTRY_COUNT_INCREMENT); }
      else if (!info.isFile() || info.nlink !== SINGLE_FILE_LINK || info.size > limits.maxFileBytes || (bytes += info.size) > limits.maxTotalBytes) throw refused();
    };
    for (const view of views) {
      await walk(view.source, 0);
      if (!view.file) continue;
      if ((inputs += view.byteLength!) > maxInputBytes) throw refused();
      const file = await io.open(view.source);
      try {
        const info = await file.stat(); if (!info.isFile() || info.nlink !== SINGLE_FILE_LINK || info.size !== view.byteLength) throw refused();
        const data = Buffer.alloc(info.size + READ_SENTINEL_BYTES), read = await file.read(data, 0, data.length, 0);
        if (read.bytesRead !== view.byteLength || createHash('sha256').update(data.subarray(0, read.bytesRead)).digest('hex') !== view.digest) throw refused();
      } finally { await file.close(); }
    }
  };
  const validate = async () => { try { await validateTree(); } catch { throw refused(); } };
  await validate();
  const readers = await Promise.all(views.map(async view => ({ view, tools: await io.readTools(view.file ? dirname(view.source) : view.source,
    { limits: { ...(limits ? { maxFileBytes: limits.maxFileBytes } : {}), maxResultBytes } }) })));
  return { views, validate, async read(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolOutcome | null> {
    const path = args['path']; if (typeof path !== 'string' || !isAbsolute(path)) return null;
    const match = readers.find(({ view }) => path === view.target || !view.file && inside(view.target, path));
    if (!match) return null;
    // Never normalize a parent traversal into another admitted view.
    if (path !== resolve(path)) throw refused();
    await validate();
    return match.tools.execute(name, { ...args, path: match.view.file ? basename(match.view.source) : relative(match.view.target, path) || '.' }, signal);
  } };
}

/** A provider keeps its own admission facts; Core owns only the added input view's closed lifecycle. */
export function nativeWorkerInputSandboxes<C, R extends { ok: true; realm: ShellRealm; writeSets?: boolean }>(
  inputs: { views: readonly View[]; validate(): Promise<void> },
  providers: readonly { kind: Exclude<ShellRealm['kind'], 'host'>; usable(capabilities: C): R | { ok: false; reason: string; restricted?: boolean } }[],
  ports: { launcher(capabilities: C): string | null; args(request: ShellRealmRequest): Promise<readonly string[] | null>;
    maxArgumentBytes: number; run(file: string, args: readonly string[], request: ShellRealmRequest): Promise<ShellRealmResult> }) {
  if (!inputs.views.length) return providers;
  return providers.filter(provider => provider.kind === 'bubblewrap').map(provider => ({ ...provider, usable(capabilities: C) {
    const ready = provider.usable(capabilities), launcher = ports.launcher(capabilities);
    if (!ready.ok || !launcher) return ready;
    const realm: ShellRealm = { kind: 'bubblewrap', async run(request) {
      await inputs.validate();
      const base = await ports.args(request), fail = (): ShellRealmResult => ({ status: 'spawn-failed', exitCode: null, signal: null,
        output: 'NATIVE_WORKER_INPUT_REFUSED', totalBytes: 0, omittedBytes: 0, durationMs: 0, cleanup: 'clean' });
      if (!base || request.open || request.writeSet && !ready.writeSets) return fail();
      const args = [...base, ...inputs.views.flatMap(view => ['--ro-bind', view.source, view.target]), '--remount-ro', '/'];
      if (args.reduce((sum, arg) => sum + Buffer.byteLength(arg) + C_STRING_TERMINATOR_BYTES, 0) > ports.maxArgumentBytes) return fail();
      return ports.run(launcher, args, request);
    } };
    return { ...ready, opens: false, realm };
  } }));
}

/** The environment application still owns requirement selection; this uses its existing read-only realm port. */
export function nativeWorkerEnvironmentProbe(realm: ShellRealm, input: { cwd: string; environment: Readonly<Record<string, string | undefined>>; signal: AbortSignal; resultMaxBytes: number }) {
  return async (argv: readonly string[], timeoutMs: number, probeSignal?: AbortSignal) => {
    const command = argv.map(part => "'" + part.replaceAll("'", "'\\''") + "'").join(' ');
    const result = await realm.run({ ...input, command, timeoutMs, signal: AbortSignal.any([input.signal, ...(probeSignal ? [probeSignal] : [])]), writeFloorReadOnly: true, projectReadOnly: true });
    if (result.cleanup === 'unverified') throw ErrorRegistry.createError('NATIVE_WORKER_CUSTODY_UNKNOWN');
    if (result.status === 'timed-out') return 'timed-out' as const;
    if (result.status === 'exited') return result.exitCode === 0 ? 'met' as const : 'unmet' as const;
    throw ErrorRegistry.createError('NATIVE_AGENT_ENVIRONMENT_REFUSED');
  };
}
