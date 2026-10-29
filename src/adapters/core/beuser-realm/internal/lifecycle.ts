import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { sha256, HOST_LIMITS_REGISTRY } from '#platform/index.js';
import { BEUSER_GENESIS_PATH, beuserBindingDigest, createBeuserRealmSeal, type BeuserRealmHandle, type BeuserRealmRuntime, type BeuserRealmRemoval } from '#engine/index.js';
import { pinBeuserLimits, type BeuserContext } from '#engine/index.js';
import { BeuserContainerMissing, BEUSER_REALM_RECIPE as recipe, canonicalRealmPath, checkHandle, dockerRealmCommand, pathContains,
  NANOSECONDS_PER_SECOND, pinRealmOptions, privateControllerRoot, realmFileIdentity, refuseRealm, type BeuserRealmOptions, type BeuserRealmCommand } from './realm.js';
import { inspectBeuserRealm, type BeuserEvidenceRetention } from './admission.js';

export interface BeuserRealmDependencies {
  /** Durable, redacted evidence storage; failure must prevent admission. Hashes alone are not retained proof. */
  readonly retainEvidence: BeuserEvidenceRetention;
  /** Existing package/build custody, including absence of secrets, host state and embedded symlinks/volumes. */
  verifyPackage(context: BeuserContext, packageRoot: string): Promise<boolean>;
  /** Independent supervisor readback after removal: actual process, cgroup and private filesystem absence. */
  removalEvidence(context: BeuserContext, handle: BeuserRealmHandle): Promise<BeuserRealmRemoval>;
}
export class DockerBeuserRealmRuntime implements BeuserRealmRuntime {
  readonly options: BeuserRealmOptions;
  readonly #command: BeuserRealmCommand;
  constructor(options: unknown, private readonly dependencies: BeuserRealmDependencies, command?: BeuserRealmCommand) {
    this.options = pinRealmOptions(options);
    this.#command = command ?? dockerRealmCommand(this.options);
  }
  async create(context: BeuserContext, publish: (handle: BeuserRealmHandle) => Promise<void>): Promise<BeuserRealmHandle> {
    pinBeuserLimits(context.limits); context.signal.throwIfAborted();
    const options = this.options;
    await privateControllerRoot(options.controllerRoot);
    await canonicalRealmPath(options.packageRoot, 'directory');
    if (pathContains(options.packageRoot, options.controllerRoot) || pathContains(options.controllerRoot, options.packageRoot)
      || !await this.dependencies.verifyPackage(context, options.packageRoot)) return refuseRealm();
    const controlDirectory = await mkdtemp(join(options.controllerRoot, 'realm-'));
    await chmod(controlDirectory, 0o700);
    const partial = Object.freeze({ binding: context.binding, incarnation: randomUUID(), containerId: '', controlDirectory,
      controlIdentity: await realmFileIdentity(controlDirectory) });
    // Persist the partial allocation before Docker can create anything. A lost create reply is retained, never repeated.
    await publish(partial);
    await writeFile(join(controlDirectory, 'genesis.json'), JSON.stringify(createBeuserRealmSeal(context.binding)), { mode: 0o444, flag: 'wx' });
    await chmod(join(controlDirectory, 'genesis.json'), 0o444);
    const seconds = Math.max(1, Math.ceil(context.limits.cleanupDeadlineMs / HOST_LIMITS_REGISTRY.msPerSecond));
    // The container has its own finite lifetime even if the creating CLI/controller dies. External cleanup is still required.
    const bootstrap = `const f=require('node:fs');for(const p of ${JSON.stringify([recipe.home, recipe.runtime])})f.mkdirSync(p,{recursive:true,mode:448});setTimeout(()=>process.exit(0),${context.limits.maxWallMs});`;
    const args = ['container', 'create', '--pull=never', '--cidfile', join(controlDirectory, 'container.id'),
      '--label', `deckent.beuser.binding=${beuserBindingDigest(context.binding)}`, '--label', `deckent.beuser.incarnation=${partial.incarnation}`,
      '--network=none', '--ipc=private', '--cgroupns=private', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
      '--read-only', '--user', `${options.uid}:${options.gid}`, '--memory', String(options.memoryBytes), '--memory-swap', String(options.memoryBytes),
      '--cpus', String(options.nanoCpus / NANOSECONDS_PER_SECOND), '--pids-limit', String(options.pids), '--stop-timeout', String(seconds),
      '--mount', `type=bind,src=${options.packageRoot},dst=${recipe.packageTarget},readonly,bind-propagation=rprivate`,
      '--mount', `type=bind,src=${controlDirectory}/genesis.json,dst=${BEUSER_GENESIS_PATH},readonly,bind-propagation=rprivate`,
      '--tmpfs', `${recipe.workTarget}:rw,nosuid,nodev,size=${options.filesystemBytes},uid=${options.uid},gid=${options.gid},mode=0700`,
      '--tmpfs', `/tmp:rw,nosuid,nodev,noexec,size=${options.filesystemBytes},uid=${options.uid},gid=${options.gid},mode=0700`,
      '--env', `HOME=${recipe.home}`, '--env', `XDG_RUNTIME_DIR=${recipe.runtime}`, '--env', `DECKENT_GLOBAL_HOME=${recipe.home}/.deckent`,
      '--workdir', recipe.workTarget, '--entrypoint', recipe.nodeExecutable, options.image, '--eval', bootstrap];
    const id = (await this.#command(args, context)).trim();
    const handle = Object.freeze({ ...partial, containerId: id }); checkHandle(context, handle);
    if ((await readFile(join(controlDirectory, 'container.id'), 'utf8')).trim() !== id) return refuseRealm();
    await publish(handle);
    await this.#command(['container', 'start', id], context);
    return handle;
  }
  async inspect(context: BeuserContext, handle: BeuserRealmHandle) {
    await this.control(handle);
    return inspectBeuserRealm(context, handle, this.options, this.#command, this.dependencies.retainEvidence);
  }
  private async control(handle: BeuserRealmHandle) {
    if (!pathContains(this.options.controllerRoot, handle.controlDirectory) || handle.controlDirectory === this.options.controllerRoot) return refuseRealm();
    await privateControllerRoot(handle.controlDirectory);
    if (await realmFileIdentity(handle.controlDirectory) !== handle.controlIdentity) return refuseRealm();
  }
  async remove(context: BeuserContext, retained: BeuserRealmHandle): Promise<BeuserRealmRemoval> {
    await this.control(retained);
    let handle = retained;
    if (!handle.containerId) {
      // Recover only our private cidfile. No broad name-based rm/kill and no guessing after a lost create response.
      const file = await open(join(handle.controlDirectory, 'container.id'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 65 || info.uid !== process.getuid?.()) return refuseRealm();
        handle = Object.freeze({ ...handle, containerId: (await file.readFile('utf8')).trim() });
      } finally { await file.close(); }
    }
    checkHandle(context, handle);
    // Inspect ownership without requiring a live process: interrupted starts/exits still need cleanup.
    let present = true;
    const inspected = await this.#command(['container', 'inspect', handle.containerId], context).catch(error => {
      if (error instanceof BeuserContainerMissing && error.containerId === handle.containerId) { present = false; return '[]'; }
      throw error;
    });
    const raw = JSON.parse(inspected) as { Id?: string; Config?: { Labels?: Record<string, string> } }[];
    if (present && (raw.length !== 1 || raw[0]?.Id !== handle.containerId || raw[0].Config?.Labels?.['deckent.beuser.binding'] !== beuserBindingDigest(context.binding)
      || raw[0].Config?.Labels?.['deckent.beuser.incarnation'] !== handle.incarnation)) return refuseRealm();
    if (present) await this.#command(['container', 'rm', '--force', '--volumes', handle.containerId], context);
    const proof = await this.dependencies.removalEvidence(context, handle);
    if (!proof.processesAbsent || !proof.cgroupAbsent || !proof.filesystemAbsent || !proof.evidenceRefs.length) return proof;
    // Only after independent absence readback may this controller remove its exact private directory.
    await this.control(handle);
    const names = await import('node:fs/promises').then(fs => fs.readdir(handle.controlDirectory));
    if (names.some(name => !['genesis.json', 'container.id'].includes(name))) return refuseRealm();
    for (const name of names) {
      const info = await lstat(join(handle.controlDirectory, name));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return refuseRealm();
    }
    await rm(handle.controlDirectory, { recursive: true });
    const absent = await lstat(handle.controlDirectory).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
    return { ...proof, filesystemAbsent: absent, evidenceRefs: [...proof.evidenceRefs, `beuser-control-removed:sha256:${sha256(handle.controlIdentity)}`] };
  }
}
