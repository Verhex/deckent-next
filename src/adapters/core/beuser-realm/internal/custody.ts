import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { beuserBindingSchema, beuserEvaluatorPrincipalRef, verifiedPrincipalSchema, type BeuserCandidateManifest } from '#domain/index.js';
import { DockerBeuserRealmRuntime } from './lifecycle.js';
import { dockerRealmCommand, canonicalRealmPath, BEUSER_REALM_RECIPE, type BeuserRealmOptions, type BeuserRealmCommand } from './realm.js';
import { readBeuserCandidate } from './candidate.js';
import { measureInstalledPackage } from '#adapters/core/installation-artifacts/index.js';
import { pinBeuserDriverBoot, BeuserSurfaceError, type BeuserDriverBoot, type BeuserRealmChannel, type RealmDriverIO } from '#adapters/core/beuser-surface/index.js';
import { BeuserRealmApplication, BeuserContractError, assertBeuserAccess, beuserBindingDigest, sameSandboxRequest,
  type BeuserContext, type BeuserRealmCustody, type BeuserRealmLease, type BeuserRealmHandle, type DispatchStore,
  type SandboxRequest, type BeuserArrangePort, type BeuserArrangeStep, beuserFilesystemProofSchema } from '#engine/index.js';
import { jsonRecordDirectory, withConfigWriteLock, sha256 } from '#platform/index.js';
import { createBeuserRemovalReadback } from './removal.js';
import { retainBeuserJson } from './records.js';
import type { ArtifactStore } from '#capabilities/index.js';

const observationSchema = z.object({ binding: beuserBindingSchema, state: z.enum(['created', 'admitted', 'destroyed', 'quarantined', 'unknown']), evidenceRefs: z.array(z.string().min(1)), filesystemProof: beuserFilesystemProofSchema.optional() }).strict();
const handleSchema = z.object({ binding: beuserBindingSchema, incarnation: z.string().uuid(), containerId: z.string(), controlDirectory: z.string(), controlIdentity: z.string() }).strict();
const recordSchema = z.object({ schemaVersion: z.literal(1), principal: verifiedPrincipalSchema, binding: beuserBindingSchema,
  lease: z.object({ handle: handleSchema.nullable(), observation: observationSchema }).strict() }).strict();
const refuse = (): never => { throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX'); };
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
/** Real package measurement is repeated before creation. The selected package is never the controller installation. */
export function createBeuserRealm(input: { readonly context: BeuserContext; readonly options: BeuserRealmOptions; readonly custody: BeuserRealmCustody;
  readonly artifacts: ArtifactStore; readonly measurement: { readonly digest: string; readonly limits: Parameters<typeof measureInstalledPackage>[1];
    readonly candidateManifest: BeuserCandidateManifest };
  readonly capture: ReturnType<typeof createBeuserRemovalReadback>['capture'];
  readonly removal: (context: BeuserContext, handle: BeuserRealmHandle) => ReturnType<ConstructorParameters<typeof DockerBeuserRealmRuntime>[1]['removalEvidence']> }) {
  const runtime = new DockerBeuserRealmRuntime(input.options, {
    async verifyPackage(_context, root) {
      await readBeuserCandidate(root, input.measurement.candidateManifest, input.measurement.limits,
        input.measurement.digest, input.context.binding.candidate.stateDigest);
      return true;
    },
    async retainEvidence(ctx, evidence) { await input.capture(ctx, evidence); return retainBeuserJson(input.artifacts, ctx, evidence); }, removalEvidence: input.removal,
  });
  return new BeuserRealmApplication(runtime, input.custody);
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
const recipe = BEUSER_REALM_RECIPE, cli = `${recipe.packageTarget}/dist/composition/core/cli/internal/entry.js`;
// Fixed fixture Git identity and config: no system/global config, no prompt. Catalog steps never supply these.
const gitEnv = `{ ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'BeUser fixture',
  GIT_AUTHOR_EMAIL: 'beuser@fixture.invalid', GIT_COMMITTER_NAME: 'BeUser fixture', GIT_COMMITTER_EMAIL: 'beuser@fixture.invalid' }`;
const inRealm = `const work = ${JSON.stringify(recipe.workTarget)}, inRealm = rel => { const full = resolve(work, rel ?? '.');
  if (full !== work && !full.startsWith(work + '/')) throw new Error('outside'); return full; };`;
// In-realm read-only observer: the target's own guarded adapters for product facts, plain lstat/git for fixtures. Values only.
const observeScript = `const { lstatSync, readFileSync } = await import('node:fs'), { resolve } = await import('node:path');
const { spawnSync } = await import('node:child_process'), { createHash } = await import('node:crypto');
const target = ${JSON.stringify(recipe.packageTarget)}, readback = JSON.parse(process.argv[1]); ${inRealm}
const platform = () => import(target + '/dist/platform/index.js');
const stat = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
let value = 'unknown';
if (readback.kind === 'installation') {
  const { FileInstallationIdentityStore } = await import(target + '/dist/adapters/core/installation-files/index.js'), { resolveProductLayout, getConfigFieldDefault } = await platform();
  const read = await new FileInstallationIdentityStore(resolveProductLayout({ projectRoot: inRealm(readback.root) }), getConfigFieldDefault('installation').writeLockTimeoutMs).read();
  value = read.status === 'available' ? 'installed' : read.status === 'unavailable' && read.reason === 'not-created' ? 'absent' : 'unknown';
} else if (readback.kind === 'path') {
  const info = stat(readback.path);
  value = !info ? { state: 'absent' } : { state: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSocket() ? 'socket' : 'other',
    mode: '0' + (info.mode & 0o777).toString(8).padStart(3, '0') };
  try { if (info?.isFile()) value.sha256 = createHash('sha256').update(readFileSync(readback.path)).digest('hex'); } catch { /* unreadable: no digest */ }
} else if (readback.kind === 'git') {
  value = spawnSync('git', ['ls-files', '--error-unmatch', '--', readback.path], { cwd: work, env: ${gitEnv}, stdio: 'ignore', timeout: 10000 }).status === 0 ? 'tracked' : 'untracked';
} else if (readback.kind === 'runtime-socket') {
  // The socket adapter's own safe read (parent lstat/realpath/uid/mode): an unsafe or unreadable path is unknown, never a confident absence.
  const { observeRuntimeSocket } = await import(target + '/dist/adapters/core/local-runtime-socket/index.js'), { resolveProductLayout } = await platform();
  value = await observeRuntimeSocket(resolveProductLayout({ projectRoot: work }));
} else if (readback.kind === 'install-method') value = (await platform()).packageRemovalCommand() === null ? 'unproven' : 'package-manager';
console.log(JSON.stringify(value));`;
const observe = async (context: BeuserContext, handle: BeuserRealmHandle, options: BeuserRealmOptions, command: BeuserRealmCommand, readback: BeuserArrangeStep['readback']) =>
  JSON.parse(await command(['container', 'exec', '--user', `${options.uid}:${options.gid}`, handle.containerId, recipe.nodeExecutable, '--input-type=module', '--eval', observeScript,
    JSON.stringify(readback)], context)) as unknown;
/** Read through the target's own guarded, read-only identity and socket adapters; return allowlisted values only. Walk20: lifecycle is read
 * (a safe runtime socket absence: `stopped` when installed, `absent` when not; an unsafe path, or a socket file alone, which does not prove a
 * running service, is `unknown`).
 * preservedData, card, receiptLocation and forbiddenEffect have no in-realm reader yet and stay `unknown`, so their dimensions stay unknown. */
export async function readBeuserInstallationSummary(context: BeuserContext, handle: BeuserRealmHandle, options: BeuserRealmOptions, command = dockerRealmCommand(options)): Promise<unknown> {
  const installation = await observe(context, handle, options, command, { kind: 'installation', expected: 'installed' });
  const socket = await observe(context, handle, options, command, { kind: 'runtime-socket', expected: 'absent' });
  const lifecycle = socket !== 'absent' ? 'unknown' : installation === 'installed' ? 'stopped' : installation === 'absent' ? 'absent' : 'unknown';
  return { installation, preservedData: 'unknown', card: 'unknown', receiptLocation: 'unknown', forbiddenEffect: 'unknown', lifecycle };
}
// In-realm effect wrapper: every child gets /dev/null stdin and pipes only, so the product's own witness check sees no terminal. Fixture files
// and Git stay under the work target (no symlink is followed for the file itself). Exit codes are data.
const arrangeScript = `const { spawnSync } = await import('node:child_process'), { createHash } = await import('node:crypto'), { resolve, dirname } = await import('node:path');
const { mkdirSync, realpathSync, openSync, writeSync, closeSync, lstatSync, chmodSync, constants } = await import('node:fs');
const [step, maxBuffer] = JSON.parse(process.argv[1]); ${inRealm}
// Creates a missing directory one level at a time below the work target, never through a symlink: no effect lands outside it (Astra 2830).
const safeDir = dir => { let at = work;
  for (const part of dir.slice(work.length).split('/').filter(Boolean)) { at += '/' + part; let info;
    try { info = lstatSync(at); } catch { mkdirSync(at, { mode: 0o700 }); info = lstatSync(at); }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('outside'); }
  return dir; };
let run;
if (step.kind === 'file') {
  try { const path = inRealm(step.path); safeDir(dirname(path));
    if (realpathSync(dirname(path)) !== dirname(path)) throw new Error('outside');
    if (step.content !== undefined) { const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { writeSync(fd, step.content); } finally { closeSync(fd); } }
    if (!lstatSync(path).isFile()) throw new Error('not a file');
    chmodSync(path, parseInt(step.mode, 8)); run = { status: 0 };
  } catch { run = { status: 1 }; }
} else {
  let cwd; try { cwd = safeDir(inRealm(step.cwd)); } catch { cwd = null; }
  run = cwd === null ? { status: 1 } : spawnSync(step.kind === 'git' ? 'git' : process.execPath, step.kind === 'git' ? step.args : [${JSON.stringify(cli)}, ...step.args],
    { cwd, env: step.kind === 'git' ? ${gitEnv} : process.env, stdio: ['ignore', 'pipe', 'ignore'], timeout: step.timeoutMs, maxBuffer, killSignal: 'SIGKILL' });
}
const out = run.stdout ?? Buffer.alloc(0);
console.log(JSON.stringify({ exitCode: run.error ? null : run.status, stdoutBytes: out.length, stdoutDigest: createHash('sha256').update(out).digest('hex') }));`;
/** First BeUser arrange adapter: product CLI, fixture file and Git steps over TTY-less `exec` (no --interactive/--tty) with explicit uid:gid and
 * locale. Never the PTY driver: input through it is person-equivalent for the product's terminal witness. */
export function createBeuserArrange(input: { readonly realm: BeuserRealmApplication; readonly custody: BeuserRealmCustody; readonly options: BeuserRealmOptions;
  readonly language: string; readonly command?: BeuserRealmCommand }): BeuserArrangePort {
  const { realm, custody, options, language } = input, command = input.command ?? dockerRealmCommand(options);
  const admitted = async (ctx: BeuserContext) => { const handle = (await custody.load(ctx))?.handle;
    return (await realm.observe(ctx)).state === 'admitted' && handle?.containerId ? handle : refuse(); };
  return {
    run: async (ctx, step) => JSON.parse(await command(['container', 'exec', '--user', `${options.uid}:${options.gid}`, '--workdir', recipe.workTarget,
      ...[`LANG=${language}`, `LC_ALL=${language}`, `HOME=${recipe.home}`, `DECKENT_GLOBAL_HOME=${recipe.home}/.deckent`].flatMap(env => ['--env', env]),
      (await admitted(ctx)).containerId, recipe.nodeExecutable, '--input-type=module', '--eval', arrangeScript, JSON.stringify([step, ctx.limits.maxArtifactBytes])], ctx)) as unknown,
    observe: async (ctx, readback) => observe(ctx, await admitted(ctx), options, command, readback),
  };
}
