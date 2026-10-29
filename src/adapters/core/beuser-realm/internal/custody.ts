import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, open } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { z } from 'zod';
import { beuserBindingSchema, beuserEvaluatorPrincipalRef, verifiedPrincipalSchema } from '#domain/index.js';
import { DockerBeuserRealmRuntime } from './lifecycle.js';
import { dockerRealmCommand, canonicalRealmPath, BEUSER_REALM_RECIPE, type BeuserRealmOptions } from './realm.js';
import { measureInstalledPackage } from '#adapters/core/installation-artifacts/index.js';
import { pinBeuserDriverBoot, BeuserSurfaceError, type BeuserDriverBoot, type BeuserRealmChannel, type RealmDriverIO } from '#adapters/core/beuser-surface/index.js';
import { BeuserRealmApplication, BeuserContractError, assertBeuserAccess, beuserBindingDigest, sameSandboxRequest,
  type BeuserContext, type BeuserRealmCustody, type BeuserRealmLease, type BeuserRealmHandle, type DispatchStore,
  type SandboxRequest } from '#engine/index.js';
import { jsonRecordDirectory, withConfigWriteLock, sha256, REDACTION_PATTERNS, REDACTION_GATE_PATTERNS, type JsonRecordFile } from '#platform/index.js';
import type { ArtifactStore } from '#capabilities/index.js';

const observationSchema = z.object({ binding: beuserBindingSchema, state: z.enum(['created', 'admitted', 'destroyed', 'quarantined', 'unknown']), evidenceRefs: z.array(z.string().min(1)) }).strict();
const handleSchema = z.object({ binding: beuserBindingSchema, incarnation: z.string().uuid(), containerId: z.string(), controlDirectory: z.string(), controlIdentity: z.string() }).strict();
const recordSchema = z.object({ schemaVersion: z.literal(1), principal: verifiedPrincipalSchema, binding: beuserBindingSchema,
  lease: z.object({ handle: handleSchema.nullable(), observation: observationSchema }).strict() }).strict();
const refuse = (): never => { throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX'); };
// Distribution admission uses credential rules; record redaction keeps its broader assignment classifier.
const distributionPatterns = [...REDACTION_PATTERNS.filter(row => row.gate), ...REDACTION_GATE_PATTERNS]
  .map(row => new RegExp('distributionSource' in row ? row.distributionSource : row.source, row.flags.replace('g', '')));
const hasDistributionCredential = (text: string): boolean => {
  const decoded = text.replace(/\\r\\n|\\[rn]/gu, '\n');
  return distributionPatterns.some(pattern => pattern.test(decoded));
};
/** The supervisor's per-Attempt custody file is never a scheduler or a launch grant. Dispatch remains the owner. */
export async function createBeuserRealmCustody(input: { readonly context: BeuserContext; readonly request: SandboxRequest;
  readonly store: Pick<DispatchStore, 'readDispatch'>; readonly owner: string; readonly directory: string; readonly timeoutMs: number }): Promise<BeuserRealmCustody> {
  const { context, request, store, owner, directory, timeoutMs } = input;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await canonicalRealmPath(directory, 'directory');
  const root = await lstat(directory); if (root.uid !== process.getuid?.() || (root.mode & 0o777) !== 0o700) return refuse();
  const name = sha256(JSON.stringify(context.binding.identity)), path = join(directory, `${name}.json`), file = jsonRecordDirectory(directory)(name);
  const check = async (ctx: BeuserContext) => {
    assertBeuserAccess(ctx, context.binding, context.principal, { kind: 'beuser-sandbox', id: context.binding.realmId }, 'create');
    const dispatch = await store.readDispatch(request);
    if (!dispatch || dispatch.owner !== owner || dispatch.launch !== 'granted' || !dispatch.grant || !sameSandboxRequest(dispatch.request, request)
      || beuserBindingDigest(beuserBindingSchema.parse(dispatch.profile.parameters['binding'])) !== beuserBindingDigest(context.binding)) return refuse();
    const actor = beuserEvaluatorPrincipalRef(dispatch.grant.principal);
    if (actor.issuer !== context.principal.issuer || actor.subject !== context.principal.subject) return refuse();
  };
  const read = async () => {
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & (constants.S_IRWXG | constants.S_IRWXO)) || info.size > context.limits.maxArtifactBytes) return refuse();
    const value = await file.read(); if (value.kind !== 'ready') return refuse();
    const record = recordSchema.parse(value.value);
    if (JSON.stringify(record.principal) !== JSON.stringify(verifiedPrincipalSchema.parse(context.principal))
      || beuserBindingDigest(record.binding) !== beuserBindingDigest(context.binding)
      || beuserBindingDigest(record.lease.observation.binding) !== beuserBindingDigest(context.binding)
      || record.lease.handle && beuserBindingDigest(record.lease.handle.binding) !== beuserBindingDigest(context.binding)) return refuse();
    return record;
  };
  const update = (ctx: BeuserContext, work: (held: Awaited<ReturnType<typeof read>>) => BeuserRealmLease) =>
    withConfigWriteLock(path, async () => { await check(ctx); const lease = work(await read());
      await file.write({ schemaVersion: 1, principal: context.principal, binding: context.binding, lease }); }, timeoutMs, { signal: ctx.signal });
  return {
    reserve: ctx => update(ctx, held => { if (held) return refuse(); return { handle: null, observation: { binding: context.binding, state: 'created', evidenceRefs: [] } }; }),
    publish: (ctx, handle) => update(ctx, held => {
      if (!held || held.lease.observation.state !== 'created' || beuserBindingDigest(handle.binding) !== beuserBindingDigest(context.binding)) return refuse();
      const old = held.lease.handle;
      if (old && (old.incarnation !== handle.incarnation || old.controlDirectory !== handle.controlDirectory || old.controlIdentity !== handle.controlIdentity
        || old.containerId && old.containerId !== handle.containerId)) return refuse();
      handleSchema.parse(handle); return { ...held.lease, handle };
    }),
    async load(ctx) { await check(ctx); return (await read())?.lease ?? null; },
    settle: (ctx, observation) => update(ctx, held => {
      if (!held || beuserBindingDigest(observation.binding) !== beuserBindingDigest(context.binding)
        || held.lease.observation.state === 'destroyed' && observation.state !== 'destroyed'
        || held.lease.observation.state === 'quarantined' && !['quarantined', 'destroyed'].includes(observation.state)) return refuse();
      return { ...held.lease, observation: observationSchema.parse(observation) };
    }),
  };
}
export async function retainBeuserJson(artifacts: ArtifactStore, context: BeuserContext, value: unknown): Promise<string> {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > context.limits.maxArtifactBytes) throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE');
  const receipt = await artifacts.put(context.binding.identity.scopeId, bytes);
  return `sha256:${receipt.digest}`;
}
/** Real package measurement is repeated before creation. The selected package is never the controller installation. */
export function createBeuserRealm(input: { readonly context: BeuserContext; readonly options: BeuserRealmOptions; readonly custody: BeuserRealmCustody;
  readonly artifacts: ArtifactStore; readonly measurement: { readonly digest: string; readonly limits: Parameters<typeof measureInstalledPackage>[1];
    readonly files: readonly { readonly path: string; readonly sha256: string; readonly size: number }[] };
  readonly capture: ReturnType<typeof createBeuserRemovalReadback>['capture'];
  readonly removal: (context: BeuserContext, handle: BeuserRealmHandle) => ReturnType<ConstructorParameters<typeof DockerBeuserRealmRuntime>[1]['removalEvidence']> }) {
  const runtime = new DockerBeuserRealmRuntime(input.options, {
    async verifyPackage(_context, root) { const measured = await measureInstalledPackage(root, input.measurement.limits);
      return measured.declaredMissing.length === 0 && measured.measurementDigest === input.measurement.digest
        && await verifyBeuserDistribution(root, input.measurement.files, input.measurement.limits, input.context.binding.candidate.stateDigest); },
    async retainEvidence(ctx, evidence) { await input.capture(ctx, evidence); return retainBeuserJson(input.artifacts, ctx, evidence); }, removalEvidence: input.removal,
  });
  return new BeuserRealmApplication(runtime, input.custody);
}
/** The mounted tree includes dependencies: package.files measurement alone cannot certify those or reject extra host state. */
export async function verifyBeuserDistribution(root: string, files: readonly { readonly path: string; readonly sha256: string; readonly size: number }[],
  limits: Parameters<typeof measureInstalledPackage>[1], digest: string): Promise<boolean> {
  if (sha256(JSON.stringify(files)) !== digest || !files.length || files.length > limits.maxFiles || new Set(files.map(file => file.path)).size !== files.length) return false;
  const allowed = new Map(files.map(file => [file.path, file])); let count = 0, total = 0;
  const visit = async (directory: string, depth: number): Promise<boolean> => {
    if (depth > limits.maxDepth) return false;
    for (const name of await readdir(directory)) {
      if (++count > limits.maxFiles || name.startsWith('.') || name === 'AGENTS.md' || name === 'CLAUDE.md' || /[\p{Cc}\p{Cs}]/u.test(name)) return false;
      const path = join(directory, name), info = await lstat(path);
      if (info.isSymbolicLink()) return false;
      if (info.isDirectory()) { if (!await visit(path, depth + 1)) return false; continue; }
      const expected = allowed.get(relative(root, path).split('\\').join('/'));
      if (!info.isFile() || info.nlink !== 1 || !expected || info.size !== expected.size || info.size > limits.maxFileBytes || (total += info.size) > limits.maxTotalBytes) return false;
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { const before = await handle.stat(); if (before.dev !== info.dev || before.ino !== info.ino) return false;
        const bytes = await handle.readFile(), after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || sha256(bytes) !== expected.sha256 || hasDistributionCredential(bytes.toString('utf8'))) return false;
      } finally { await handle.close(); }
      allowed.delete(relative(root, path).split('\\').join('/'));
    }
    return true;
  };
  await canonicalRealmPath(root, 'directory');
  return await visit(root, 0) && allowed.size === 0;
}
/** Private pipes to the packaged driver inside the exact, re-admitted container. No public executable/socket path. */
export function createBeuserChannel(input: { readonly context: BeuserContext; readonly realm: BeuserRealmApplication; readonly custody: BeuserRealmCustody;
  readonly options: BeuserRealmOptions; readonly boot: Pick<BeuserDriverBoot, 'mode' | 'entry' | 'commands'> & { readonly maxBootBytes: number; readonly language: string } }): BeuserRealmChannel {
  const { context, realm, custody, options, boot } = input, command = dockerRealmCommand(options);
  const verify = async (ctx: BeuserContext) => {
    assertBeuserAccess(ctx, context.binding, context.principal, { kind: 'beuser-sandbox', id: context.binding.realmId }, 'create');
    if ((await realm.observe(ctx)).state !== 'admitted') return refuse();
  };
  return { binding: context.binding, verify, async open(ctx, size, bounds): Promise<RealmDriverIO> {
    await verify(ctx); const handle = (await custody.load(ctx))?.handle; if (!handle?.containerId) return refuse();
    const wire = JSON.stringify(pinBeuserDriverBoot({ schemaVersion: 1, nonce: ctx.binding.nonce, mode: boot.mode, entry: boot.entry, commands: boot.commands,
      secretFds: {}, columns: size.columns, rows: size.rows, maxArtifactBytes: ctx.limits.maxArtifactBytes,
      env: { TERM: 'xterm-256color', LANG: boot.language, LC_ALL: boot.language, HOME: BEUSER_REALM_RECIPE.home, DECKENT_GLOBAL_HOME: `${BEUSER_REALM_RECIPE.home}/.deckent` },
      limits: { maxSteps: ctx.limits.maxSteps, maxWallMs: ctx.limits.maxWallMs, maxWaitMs: ctx.limits.maxWaitMs,
        maxTranscriptBytes: ctx.limits.maxTranscriptBytes, cleanupDeadlineMs: ctx.limits.cleanupDeadlineMs, ...bounds } })) + '\n';
    if (!Number.isSafeInteger(boot.maxBootBytes) || boot.maxBootBytes <= 0 || Buffer.byteLength(wire) > boot.maxBootBytes) throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
    // Revalidates the trusted Docker executable using the same checked, clean command transport before spawning a streaming exec.
    await command(['container', 'inspect', '--format', '{{.Id}}', handle.containerId], ctx);
    const helper = `${BEUSER_REALM_RECIPE.packageTarget}/dist/adapters/core/beuser-surface/internal/pty-driver.py`;
    const child = spawn(options.executable, ['container', 'exec', '--interactive', '--user', `${options.uid}:${options.gid}`, handle.containerId,
      'python3', helper, String(boot.maxBootBytes)], { env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'], signal: ctx.signal,
      timeout: ctx.limits.maxWallMs, killSignal: 'SIGKILL' });
    let stderrBytes = 0;
    child.stderr.on('data', (bytes: Buffer) => { stderrBytes += bytes.length; if (stderrBytes > ctx.limits.maxArtifactBytes) child.kill('SIGKILL'); });
    child.on('error', () => { child.stdout.destroy(new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX')); });
    child.stdin.on('error', () => {});
    child.stdin.write(wire);
    return { input: child.stdin, output: child.stdout, async cancel() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((done, fail) => { const timer = setTimeout(() => fail(new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX')), ctx.limits.cleanupDeadlineMs);
        child.once('close', () => { clearTimeout(timer); done(); }); child.kill('SIGKILL'); });
    } };
  }, async cancel() { /* C4 owns bounded destruction of the entire realm, including escaped driver descendants. */ } };
}
/** Host kernel/merged-root readback is independent of `docker rm`. Unobservable local-daemon paths stay unknown. */
export function createBeuserRemovalReadback(options: BeuserRealmOptions, artifacts: ArtifactStore, file: JsonRecordFile) {
  const snapshotSchema = z.object({ bindingDigest: z.string(), incarnation: z.string().uuid(), containerId: z.string(),
    pid: z.number().int().positive(), start: z.string(), cgroup: z.string(), mergedRoot: z.string() }).strict();
  const absent = async (path: string) => lstat(path).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
  return {
    async capture(ctx: BeuserContext, evidence: { kind: string; value: string; incarnation: string; bindingDigest: string }) {
      if (evidence.kind !== 'containment') return;
      const value = JSON.parse(evidence.value) as { id: string; state: { Pid: number } };
      if (!Number.isSafeInteger(value.state.Pid) || value.state.Pid <= 0 || !/^[a-f0-9]{64}$/u.test(value.id)) return refuse();
      try {
        const raw = JSON.parse(await dockerRealmCommand(options)(['container', 'inspect', value.id], ctx)) as { GraphDriver?: { Data?: { MergedDir?: string } } }[];
        const mergedRoot = raw[0]?.GraphDriver?.Data?.MergedDir;
        const cgroupRow = (await readFile(`/proc/${value.state.Pid}/cgroup`, 'utf8')).trim().split('\n').find(row => row.startsWith('0::/'));
        const group = cgroupRow?.slice(3);
        if (!mergedRoot || !group || group === '/' || group.includes('..') || !mergedRoot.startsWith('/') || mergedRoot.includes('..')) return;
        await canonicalRealmPath(mergedRoot, 'directory');
        const start = (await readFile(`/proc/${value.state.Pid}/stat`, 'utf8')).split(') ').at(-1)!.split(' ')[19]!;
        await file.write(snapshotSchema.parse({ bindingDigest: evidence.bindingDigest, incarnation: evidence.incarnation, containerId: value.id,
          pid: value.state.Pid, start, cgroup: resolve('/sys/fs/cgroup', `.${group}`), mergedRoot }));
      } catch { /* A remote or inaccessible daemon cannot supply local kernel custody. Never manufacture absence. */ }
    },
    async read(ctx: BeuserContext, handle: BeuserRealmHandle) {
      const unknown = { processesAbsent: false, cgroupAbsent: false, filesystemAbsent: false, evidenceRefs: [] as string[] };
      try {
        const read = await file.read(); if (read.kind !== 'ready') return unknown;
        const pin = snapshotSchema.parse(read.value);
        if (pin.bindingDigest !== beuserBindingDigest(ctx.binding) || pin.incarnation !== handle.incarnation || pin.containerId !== handle.containerId) return unknown;
        const processesAbsent = await absent(`/proc/${pin.pid}`), cgroupAbsent = await absent(pin.cgroup), filesystemAbsent = await absent(pin.mergedRoot);
        const proof = { bindingDigest: pin.bindingDigest, incarnation: pin.incarnation, containerId: pin.containerId, processesAbsent, cgroupAbsent, filesystemAbsent };
        return { processesAbsent, cgroupAbsent, filesystemAbsent, evidenceRefs: [await retainBeuserJson(artifacts, ctx, proof)] };
      } catch { return unknown; }
    },
  };
}

/** Read through the target's own guarded, read-only identity adapter; return allowlisted values only. */
export async function readBeuserInstallationSummary(context: BeuserContext, handle: BeuserRealmHandle, options: BeuserRealmOptions, nodeExecutable: string): Promise<unknown> {
  const script = `
const target = '${BEUSER_REALM_RECIPE.packageTarget}';
const { FileInstallationIdentityStore } = await import(target + '/dist/adapters/core/installation-files/index.js');
const { resolveProductLayout, getConfigFieldDefault } = await import(target + '/dist/platform/index.js');
const layout = resolveProductLayout({ projectRoot: '${BEUSER_REALM_RECIPE.workTarget}' });
const read = await new FileInstallationIdentityStore(layout, getConfigFieldDefault('installation').writeLockTimeoutMs).read();
const installation = read.status === 'available' ? 'installed'
  : read.status === 'unavailable' && read.reason === 'not-created' ? 'absent' : 'unknown';
console.log(JSON.stringify({ installation, preservedData: 'unknown', card: 'unknown', receiptLocation: 'unknown', forbiddenEffect: 'unknown', lifecycle: 'unknown' }));
`;

  return JSON.parse(await dockerRealmCommand(options)(['container', 'exec', handle.containerId, nodeExecutable, '--input-type=module', '--eval', script], context)) as unknown;
}
