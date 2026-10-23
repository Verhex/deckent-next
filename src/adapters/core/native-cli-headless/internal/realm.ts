import type { Dir } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeCliIdSchema } from '#domain/index.js';
import type { BubblewrapCapability } from '#adapters/core/host-shell/index.js';
import { nativeEgressLimits, openNativeEgressGateway } from '#adapters/core/native-connection/index.js';
import { runNodeProcess, type ProcessCommand, type ProcessEvidence, type ProcessLineConsumer } from '#adapters/core/process-runner/index.js';
import { isolatedProcessCommand, verifyBubblewrapLauncher } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { refuse } from './contract.js';
import type { HeadlessEntry } from './env.js';

/** S3-5: the host's bubblewrap measurement the realm launches with (composition: the service's own, under the global state root). */
export type HeadlessIsolation = () => Promise<BubblewrapCapability>;
/** The launcher identity a passing check sealed (preflight record and doctor). */
export type HeadlessIsolationSeal = Readonly<{ launcher: string; version: string }>;
/** What bubblewrap and the relay print when the realm itself could not start (never the CLI's own output). */
const REALM_FAILURE = /^(?:bwrap|deckent-relay): /u;

/**
 * The relay inside the realm (`node -e`): it listens on the registry proxy address of the realm's own loopback and pipes each connection to the
 * gateway socket (the one way out), starts the CLI with inherited stdio once it listens, and mirrors the CLI's exit. It waits through SIGINT:
 * the CLI, in the same process group, ends its turn and the relay ends with it. Plain JavaScript text: it runs inside the realm in every build.
 */
const RELAY = String.raw`'use strict';
const net = require('node:net'), { spawn } = require('node:child_process'), { constants } = require('node:os');
const [config, executable, ...args] = process.argv.slice(1), c = JSON.parse(config);
const fail = text => { process.stderr.write('deckent-relay: ' + text + '\n'); process.exit(1); };
process.on('SIGINT', () => {});
const server = net.createServer(client => {
  const remote = net.connect(c.socket), close = () => { client.destroy(); remote.destroy(); };
  for (const socket of [client, remote]) { socket.on('error', close); socket.on('close', close); socket.setTimeout(c.idleMs, close); }
  client.pipe(remote); remote.pipe(client);
});
server.maxConnections = c.connections;
server.on('error', () => fail('proxy listen failed'));
server.listen(c.port, c.host, () => {
  const child = spawn(executable, args, { stdio: 'inherit' });
  child.on('error', () => fail('start failed'));
  child.on('exit', (code, signal) => process.exit(code ?? 128 + (constants.signals[signal] ?? 0)));
});`;

/** The registry's isolation is usable now: the measured launcher works with user namespaces and is still the measured file. Typed refusal otherwise. */
export async function headlessIsolationSeal(isolation: HeadlessIsolation): Promise<HeadlessIsolationSeal & { path: string }> {
  if (process.platform !== 'linux') refuse('HEADLESS_ISOLATION_UNAVAILABLE', { check: 'launcher' });
  const capability = await isolation().catch(() => null);
  if (capability?.status === 'restricted') refuse('HEADLESS_ISOLATION_UNAVAILABLE', { check: 'user-namespace' });
  if (capability?.status !== 'available' || !capability.launcher || !verifyBubblewrapLauncher(capability.launcher).ok) refuse('HEADLESS_ISOLATION_UNAVAILABLE', { check: 'launcher' });
  return Object.freeze({ launcher: capability.launcher.source, version: capability.launcher.version, path: capability.launcher.path });
}

/** Existing entries of the login dir outside the registry's visible list, by kind (symbolic links stay: they resolve inside the view or nowhere). */
async function loginMasks(configDir: string, visible: readonly string[], maxEntries: number) {
  const directories: string[] = [], files: string[] = [];
  let dir: Dir | undefined, seen = 0;
  try {
    dir = await opendir(configDir);
    for (let entry = await dir.read(); entry; entry = await dir.read()) {
      if (++seen > maxEntries) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir' });
      if (visible.includes(entry.name) || entry.isSymbolicLink()) continue;
      (entry.isDirectory() ? directories : files).push(join(configDir, entry.name));
    }
  } catch (error) { if ((error as { code?: unknown }).code === 'HEADLESS_PREFLIGHT_FAILED') throw error; refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir' }); }
  finally { await dir?.close().catch(() => undefined); }
  return Object.freeze({ directories: directories.sort(), files: files.sort() });
}

export type HeadlessSpawn = Readonly<{ executable: string; args: readonly string[]; env: Readonly<Record<string, string>>; stateDir: string; runDir: string; configDir: string;
  promptFile?: string | undefined }>;
type Bounds = Omit<Extract<ProcessCommand, { schemaVersion: 2 }>, 'requestId' | 'executable' | 'args' | 'cwd' | 'env' | 'schemaVersion'>;
/**
 * The one way a headless CLI process starts (preflight probes and the call): inside the realm, with the connection's own gateway for the
 * provider's allowlisted endpoints, the login dir as the only host directory it may write and the run dir as private memory. The gateway lives
 * exactly as long as the process. A realm that could not start is a typed isolation refusal; no path runs the CLI outside it.
 */
export async function runHeadlessIsolated(entry: HeadlessEntry, isolation: HeadlessIsolation, spawn: HeadlessSpawn, bounds: Bounds, signal?: AbortSignal,
  onLine?: ProcessLineConsumer): Promise<ProcessEvidence> {
  const seal = await headlessIsolationSeal(isolation), realm = entry.headless.isolation, provider = nativeCliIdSchema.safeParse(entry.id);
  if (!provider.success) refuse('HEADLESS_REQUEST_INVALID', { reason: 'definition' });
  // The relay runs on this process's own Node.js (bound read-only at its path: a test CLI's shebang names the same path).
  const masks = await loginMasks(spawn.configDir, realm.configVisible, realm.configMaxEntries), node = process.execPath;
  const gateway = await openNativeEgressGateway({ provider: provider.data, directory: spawn.stateDir }).catch(() => refuse('HEADLESS_ISOLATION_UNAVAILABLE', { check: 'gateway' }));
  try {
    const relay = JSON.stringify({ socket: realm.socketPath, host: realm.proxy.host, port: realm.proxy.port, ...nativeEgressLimits() });
    const command = isolatedProcessCommand({ shell: realm.shell, launcher: seal.path, fileSizeBlocks: realm.limits.fileSizeBlocks, openFiles: realm.limits.openFiles,
      view: { workDir: spawn.runDir, workFiles: spawn.promptFile ? [spawn.promptFile] : [], executables: [...new Set([spawn.executable, node])], stateDir: spawn.configDir,
        stateMasks: masks, sockets: [{ source: gateway.socketPath, target: realm.socketPath }], tmpfsBytes: realm.limits.tmpfsBytes },
      command: [node, '-e', RELAY, relay, spawn.executable, ...spawn.args] });
    if (!command) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir' });
    const evidence = await runNodeProcess({ schemaVersion: 2, requestId: randomUUID(), executable: command.executable, args: [...command.args], cwd: spawn.runDir, env: spawn.env,
      ...bounds }, signal, onLine);
    if (evidence.reason === 'exit' && evidence.exitCode !== 0 && REALM_FAILURE.test(Buffer.from(evidence.stderrBase64, 'base64').toString('utf8'))) refuse('HEADLESS_ISOLATION_UNAVAILABLE', { check: 'realm' });
    return evidence;
  } finally { await gateway.close(); }
}
