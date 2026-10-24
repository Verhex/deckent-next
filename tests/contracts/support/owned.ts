import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';

/**
 * Owned test resources (test revision stage B): every child process (and its process group), PTY driver, container, temporary root, server
 * and closer a test acquires is registered the moment it exists, so a failed setup still releases what it got. Teardown runs after every
 * afterEach (onTestFinished), in reverse acquisition order; one failing release never skips the next, and every failure — including a
 * resource still present afterwards — is reported in one aggregated error. Every child carries a deadline: past it the process group is
 * stopped (TERM, then KILL) and the wait fails with a typed error instead of hanging.
 */
export type OwnedErrorCode = 'TEST_CHILD_DEADLINE' | 'TEST_CHILD_OUTPUT_LIMIT' | 'TEST_CHILD_EXIT' | 'TEST_CLOSE_DEADLINE' | 'TEST_RESOURCE_LEAK';
export class OwnedResourceError extends Error {
  constructor(readonly code: OwnedErrorCode, message: string, readonly detail: Readonly<Record<string, unknown>> = {}) { super(`${code}: ${message}`); }
}
export class OwnedTeardownError extends AggregateError {
  readonly code = 'TEST_TEARDOWN_FAILED';
  constructor(errors: readonly unknown[]) {
    super(errors, `TEST_TEARDOWN_FAILED: ${errors.length} release(s) failed\n${errors.map(error => `- ${error instanceof Error ? error.message : String(error)}`).join('\n')}`);
  }
}

export interface OwnedSpawnOptions {
  /** Required: an explicit environment (see childEnv); the ambient process.env is never passed implicitly. */
  readonly env: NodeJS.ProcessEnv;
  /** Required: the wait fails with TEST_CHILD_DEADLINE past this bound and the process group is stopped. */
  readonly deadlineMs: number;
  readonly cwd?: string;
  readonly stdio?: StdioOptions;
  readonly label?: string;
}
export interface OwnedRunOptions extends Omit<OwnedSpawnOptions, 'stdio'> {
  /** Written to stdin, which is then closed; without it stdin is /dev/null. */
  readonly input?: string;
  /** Combined stdout+stderr bound (default 8 MiB): past it the group is killed and the run fails with TEST_CHILD_OUTPUT_LIMIT. */
  readonly outputBytes?: number;
}
export interface OwnedExit { readonly code: number | null; readonly signal: NodeJS.Signals | null }
export interface OwnedChild<C extends ChildProcess = ChildProcess> {
  readonly child: C;
  /** Settles on the process's own exit; rejects with TEST_CHILD_DEADLINE when the deadline stopped it. Never an unhandled rejection. */
  readonly exit: Promise<OwnedExit>;
}
export interface OwnedRun extends OwnedExit { readonly stdout: string; readonly stderr: string }

interface Entry { readonly label: string; release(): Promise<void>; present(): Promise<boolean> }
const GROUPS = process.platform !== 'win32';
const STOP_GRACE_MS = 1_000, REAP_MS = 5_000, CLOSE_MS = 10_000, PIPE_DRAIN_MS = 2_000;
/** Live process groups of this worker: a worker that exits before teardown (crash, bail) still kills them. */
const liveGroups = new Set<number>();
process.once('exit', () => { for (const pid of liveGroups) signalGroup(pid, 'SIGKILL'); });

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(GROUPS ? -pid : pid, signal); } catch { /* ESRCH: already gone */ }
}
/** A group still has a member (an orphaned grandchild counts); EPERM means the id now belongs to someone else. */
function groupAlive(pid: number): boolean {
  try { process.kill(GROUPS ? -pid : pid, 0); return true; } catch { return false; }
}
const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref(); });
async function until(check: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await pause(20)) if (check()) return true;
  return check();
}
async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OwnedResourceError('TEST_CLOSE_DEADLINE', `${label} did not close within ${ms} ms`)), ms); timer.unref();
    })]);
  } finally { clearTimeout(timer); }
}
const tail = (text: string) => text.length > 4000 ? `…${text.slice(-4000)}` : text;
const exists = (path: string) => access(path).then(() => true, () => false);

export class OwnedResources {
  readonly #entries: Entry[] = [];
  readonly #released: Entry[] = [];

  /** A fresh private temporary directory, removed at teardown (default parent: the canonical OS temporary root). */
  async root(prefix: string, parent = tmpdir()): Promise<string> {
    const path = await mkdtemp(join(parent, prefix));
    this.removeAfter(path);
    return path;
  }
  /** A path something else created (a socket directory, a fixture copy), removed at teardown. */
  removeAfter(path: string): string {
    this.#entries.push({ label: `path ${path}`, present: () => exists(path), release: async () => {
      try { await rm(path, { recursive: true, force: true, maxRetries: 3 }); }
      catch (error) {
        // A test that removed its own write permission (read-only fixture, chmod 000) gets it back first.
        if (!GROUPS || !['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await this.exec('/bin/chmod', ['-R', 'u+rwx', path], { env: { PATH: '/usr/bin:/bin' }, deadlineMs: 10_000, label: 'chmod for removal' }, false);
        await rm(path, { recursive: true, force: true, maxRetries: 3 });
      }
    } });
    return path;
  }

  /** Starts a child in its own process group (POSIX) and owns it until teardown. */
  spawn<C extends ChildProcess = ChildProcess>(command: string, args: readonly string[], options: OwnedSpawnOptions): OwnedChild<C> {
    return this.#spawn<C>(command, args, options, true);
  }
  #spawn<C extends ChildProcess = ChildProcess>(command: string, args: readonly string[], options: OwnedSpawnOptions, register: boolean): OwnedChild<C> {
    const label = options.label ?? `${command} ${args.slice(0, 3).join(' ')}`.slice(0, 160);
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'], detached: GROUPS }) as C;
    const pid = child.pid;
    if (pid !== undefined) liveGroups.add(pid);
    let expired = false;
    const stop = () => { if (pid === undefined) return; signalGroup(pid, 'SIGTERM'); setTimeout(() => signalGroup(pid, 'SIGKILL'), STOP_GRACE_MS).unref(); };
    const started = Date.now();
    const deadline = setTimeout(() => { expired = true; stop(); }, options.deadlineMs); deadline.unref();
    const exit = new Promise<OwnedExit>((resolve, reject) => {
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(deadline);
        if (expired) reject(new OwnedResourceError('TEST_CHILD_DEADLINE', `${label} exceeded its ${options.deadlineMs} ms deadline`,
          { elapsedMs: Date.now() - started, code, signal }));
        else resolve({ code, signal });
      });
    });
    exit.catch(() => undefined);
    const exited = () => child.exitCode !== null || child.signalCode !== null || pid === undefined;
    if (register) this.#entries.push({ label: `process ${label} (pid ${pid ?? 'none'})`,
      present: async () => !exited() || (pid !== undefined && groupAlive(pid)),
      release: async () => {
        clearTimeout(deadline);
        if (pid === undefined) return;
        // The child first; then any member of its group that outlived it (an orphaned worker or service grandchild).
        if (!exited()) { signalGroup(pid, 'SIGTERM'); if (!await until(exited, STOP_GRACE_MS)) signalGroup(pid, 'SIGKILL'); }
        if (!await until(exited, REAP_MS)) throw new OwnedResourceError('TEST_RESOURCE_LEAK', `${label} (pid ${pid}) was not reaped`);
        if (groupAlive(pid)) { signalGroup(pid, 'SIGKILL'); await until(() => !groupAlive(pid), REAP_MS); }
        if (groupAlive(pid)) throw new OwnedResourceError('TEST_RESOURCE_LEAK', `process group ${pid} of ${label} still has members`);
        liveGroups.delete(pid);
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      } });
    return { child, exit };
  }

  /** Runs a child to its exit with bounded output; a non-zero exit is a result, not an error. */
  async run(command: string, args: readonly string[], options: OwnedRunOptions): Promise<OwnedRun> {
    return this.#run(command, args, options, true);
  }
  async #run(command: string, args: readonly string[], options: OwnedRunOptions, register: boolean): Promise<OwnedRun> {
    const owned = this.#spawn(command, args, { ...options, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }, register);
    const { child } = owned, limit = options.outputBytes ?? 8 * 1024 * 1024, label = options.label ?? command;
    const out: Buffer[] = [], err: Buffer[] = [];
    let bytes = 0, overflow = false;
    const take = (into: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) { if (!overflow && child.pid !== undefined) { overflow = true; signalGroup(child.pid, 'SIGKILL'); } return; }
      into.push(chunk);
    };
    child.stdout!.on('data', take(out)); child.stderr!.on('data', take(err));
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    // A child that exits without reading its input must not turn EPIPE into an uncaught stream error.
    if (options.input !== undefined) { child.stdin!.on('error', () => undefined); child.stdin!.end(options.input); }
    const text = () => ({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    let status: OwnedExit;
    try { status = await owned.exit; }
    catch (error) {
      const { stdout, stderr } = text();
      if (error instanceof OwnedResourceError) throw new OwnedResourceError(error.code, `${error.message}\nstdout: ${tail(stdout)}\nstderr: ${tail(stderr)}`, { ...error.detail, stdout, stderr });
      throw error;
    } finally {
      // A grandchild that keeps the pipes open must not hold the run: the pipes are drained briefly, then released.
      await Promise.race([closed, pause(PIPE_DRAIN_MS)]);
      child.stdout!.destroy(); child.stderr!.destroy();
    }
    if (overflow) throw new OwnedResourceError('TEST_CHILD_OUTPUT_LIMIT', `${label} wrote more than ${limit} bytes`, { ...text() });
    return { ...status, ...text() };
  }

  /** run(), rejecting a non-zero exit the way execFile does (error.code is the exit code; stdout/stderr attached). */
  async exec(command: string, args: readonly string[], options: OwnedRunOptions, register = true): Promise<{ stdout: string; stderr: string }> {
    const result = await this.#run(command, args, options, register);
    if (result.code === 0) return { stdout: result.stdout, stderr: result.stderr };
    throw Object.assign(new OwnedResourceError('TEST_CHILD_EXIT', `${options.label ?? command} exited ${result.code ?? result.signal}\n${tail(result.stderr)}`),
      { exitCode: result.code, signal: result.signal, stdout: result.stdout, stderr: result.stderr });
  }

  /** A container (id or name) removed with `docker rm -f` at teardown; dockerArgs selects the daemon (e.g. ['--host', endpoint]). */
  container(handle: string, dockerArgs: readonly string[] = [], docker = '/usr/bin/docker'): string {
    const ask = (args: readonly string[]) => this.#run(docker, [...dockerArgs, ...args], { env: { PATH: '/usr/bin:/bin' }, deadlineMs: 20_000, label: `docker ${args[0]}` }, false);
    this.#entries.push({ label: `container ${handle}`,
      present: async () => {
        const answer = await ask(['inspect', '--format', '{{.Id}}', handle]);
        if (answer.code === 0) return true;
        if (/No such/iu.test(answer.stderr)) return false;
        throw new OwnedResourceError('TEST_RESOURCE_LEAK', `container ${handle} could not be inspected: ${tail(answer.stderr)}`);
      },
      release: async () => {
        const answer = await ask(['rm', '-f', handle]);
        if (answer.code !== 0 && !/No such/iu.test(answer.stderr)) throw new OwnedResourceError('TEST_RESOURCE_LEAK', `container ${handle} was not removed: ${tail(answer.stderr)}`);
      } });
    return handle;
  }

  /** A listening server, closed (with its open connections) at teardown. */
  server<S extends Server>(server: S): S {
    this.#entries.push({ label: 'server', present: async () => server.listening, release: () => bounded(new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close(error => error ? reject(error) : resolve());
      (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    }), CLOSE_MS, 'server') });
    return server;
  }

  /** Any other release (a store, a client, a runtime service), bounded at teardown. */
  defer(label: string, close: () => unknown): void {
    // A closer has no observable resource of its own: once attempted, its failure (if any) is the reported evidence.
    let attempted = false;
    this.#entries.push({ label, present: async () => !attempted, release: async () => { attempted = true; await bounded(Promise.resolve().then(close), CLOSE_MS, label); } });
  }

  /** Resources still present: not yet released, or released but still there. */
  async leaks(): Promise<string[]> {
    const present: string[] = [];
    for (const entry of [...this.#released, ...this.#entries]) {
      try { if (await entry.present()) present.push(entry.label); }
      catch (error) { present.push(`${entry.label}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return present;
  }

  /** Releases everything in reverse order, then proves nothing remains; every failure is reported together. */
  async teardown(): Promise<void> {
    const errors: unknown[] = [];
    for (const entry of this.#entries.splice(0).reverse()) {
      try { await entry.release(); } catch (error) { errors.push(error); }
      this.#released.push(entry);
    }
    for (const label of await this.leaks()) if (!errors.some(error => error instanceof Error && error.message.includes(label)))
      errors.push(new OwnedResourceError('TEST_RESOURCE_LEAK', `${label} is still present after teardown`));
    this.#released.splice(0);
    if (errors.length) throw new OwnedTeardownError(errors);
  }
}

let current: OwnedResources | null = null;
/** The running test's owned resources; the first call in a test registers its teardown (after every afterEach hook). */
export function owned(): OwnedResources {
  if (current) return current;
  const scope = current = new OwnedResources();
  onTestFinished(async () => { current = null; await scope.teardown(); });
  return scope;
}
