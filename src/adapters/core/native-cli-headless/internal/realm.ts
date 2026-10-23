import type { Dir } from 'node:fs';
import { constants } from 'node:fs';
import { access, opendir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { headlessEgressSchema, nativeCliIdSchema, type HeadlessEgress } from '#domain/index.js';
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
/** What bubblewrap and the relay print when the realm itself could not start (never the CLI's own output); f5: the limiter's own refusal too. */
const REALM_FAILURE = /^(?:bwrap|deckent-relay|prlimit): /u, LIMITS_FAILURE = /^(?:deckent-relay: limits|prlimit: )/u;
/** `/proc/<pid>/stat` CPU fields count USER_HZ ticks, fixed at 100 in the Linux ABI (proc(5)). */
const USER_HZ = 100;
/** f5: which realm bound stopped the CLI (its reserved relay exit code), or null. */
export type HeadlessLimit = 'cpu-time' | 'processes' | 'memory';

/**
 * The relay inside the realm (`node -e`): it listens on the registry proxy address of the realm's own loopback and pipes each connection to the
 * gateway socket (the one way out), starts the CLI with inherited stdio once it listens, and mirrors the CLI's exit. It waits through SIGINT:
 * the CLI, in the same process group, ends its turn and the relay ends with it. Plain JavaScript text: it runs inside the realm in every build.
 * f5: it first proves the limiter's bounds are its own (`/proc/self/limits`), samples the realm's tasks and the CLI's data size and effective bounds
 * (the realm's fresh /proc shows only its own processes), and when the CLI ends abnormally near a bound it exits with that bound's reserved code
 * (a CLI's own exit with a reserved code becomes 1, so the code always means the bound).
 */
const RELAY = String.raw`'use strict';
const net = require('node:net'), fs = require('node:fs'), { spawn } = require('node:child_process'), { constants } = require('node:os');
const [config, executable, ...args] = process.argv.slice(1), c = JSON.parse(config);
const fail = text => { process.stderr.write('deckent-relay: ' + text + '\n'); process.exit(1); };
process.on('SIGINT', () => {});
const row = (text, name) => { const m = new RegExp('^Max ' + name + '\\s+(\\S+)\\s+(\\S+)', 'm').exec(text); return m ? m[1] + ':' + m[2] : ''; };
const own = fs.readFileSync('/proc/self/limits', 'utf8');
if (row(own, 'cpu time') !== c.cpu || row(own, 'processes') !== c.processes || row(own, 'data size') !== c.data) fail('limits');
const peak = { tasks: 0, data: 0, cpuTicks: 0, processes: Infinity, dataLimit: Infinity, cpuLimit: Infinity };
const number = (text, pattern) => Number(pattern.exec(text)?.[1] ?? 0);
const sample = pid => {
  let tasks = 0;
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = fs.readFileSync('/proc/' + name + '/status', 'utf8'); tasks += number(status, /^Threads:\s+(\d+)/m);
      if (Number(name) !== pid) continue;
      peak.data = Math.max(peak.data, number(status, /^VmData:\s+(\d+)/m) * 1024);
      const limits = fs.readFileSync('/proc/' + name + '/limits', 'utf8'), stat = fs.readFileSync('/proc/' + name + '/stat', 'utf8').split(') ')[1].split(' ');
      peak.processes = Math.min(peak.processes, Number(row(limits, 'processes').split(':')[0]) || Infinity);
      peak.dataLimit = Math.min(peak.dataLimit, Number(row(limits, 'data size').split(':')[0]) || Infinity);
      peak.cpuLimit = Math.min(peak.cpuLimit, Number(row(limits, 'cpu time').split(':')[0]) || Infinity);
      peak.cpuTicks = Math.max(peak.cpuTicks, Number(stat[11]) + Number(stat[12]));
    } catch {}
  }
  peak.tasks = Math.max(peak.tasks, tasks);
};
const server = net.createServer(client => {
  const remote = net.connect(c.socket), close = () => { client.destroy(); remote.destroy(); };
  for (const socket of [client, remote]) { socket.on('error', close); socket.on('close', close); socket.setTimeout(c.idleMs, close); }
  client.pipe(remote); remote.pipe(client);
});
server.maxConnections = c.connections;
server.on('error', () => fail('proxy listen failed'));
server.listen(c.port, c.host, () => {
  const child = spawn(executable, args, { stdio: 'inherit' });
  const timer = setInterval(() => sample(child.pid), c.sampleMs);
  child.on('error', () => fail('start failed'));
  child.on('exit', (code, signal) => {
    clearInterval(timer);
    const near = (value, bound) => value * 1000 >= bound * c.permille, abnormal = signal !== null || code >= 128;
    const cause = signal === 'SIGXCPU' || (signal === 'SIGKILL' && near(peak.cpuTicks, peak.cpuLimit * c.ticks)) ? 'cpu-time'
      : abnormal && near(peak.tasks, peak.processes) ? 'processes' : abnormal && near(peak.data, peak.dataLimit) ? 'memory' : null;
    const mirrored = code ?? 128 + (constants.signals[signal] ?? 0);
    process.exit(cause ? c.exits[cause] : Object.values(c.exits).includes(mirrored) ? 1 : mirrored);
  });
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
  promptFile?: string | undefined; now: () => number }>;
/** f5: the connection's refusal record beside `preflight.json` (doctor reads it without a spawn). */
export const HEADLESS_EGRESS_RECORD = 'egress.json';
/**
 * f5: adds one spawn's gateway refusals to the connection's cumulative record (0600, temporary file + rename; names past the gateway's host bound
 * count as `other`). Read-modify-write: a concurrent preflight in another process may lose one update (last writer wins); counts only, never a payload.
 */
async function recordEgress(stateDir: string, egress: HeadlessEgress, now: () => number, hostsMax: number): Promise<void> {
  if (egress.refused === 0) return;
  const target = join(stateDir, HEADLESS_EGRESS_RECORD), raw = await readFile(target, 'utf8').then(text => JSON.parse(text) as unknown, () => null);
  const { schemaVersion, lastRefusedAtMs, ...summary } = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const kept = schemaVersion === 1 && typeof lastRefusedAtMs === 'number' ? headlessEgressSchema.safeParse(summary) : { success: false as const };
  const hosts: Record<string, number> = { ...(kept.success ? kept.data.hosts : {}) };
  let other = (kept.success ? kept.data.other : 0) + egress.other;
  for (const [host, count] of Object.entries(egress.hosts)) if (Object.hasOwn(hosts, host) || Object.keys(hosts).length < hostsMax) hosts[host] = (hosts[host] ?? 0) + count; else other += count;
  const record = { schemaVersion: 1, connected: (kept.success ? kept.data.connected : 0) + egress.connected, refused: (kept.success ? kept.data.refused : 0) + egress.refused,
    hosts, other, lastRefusedAtMs: now() }, temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); await rename(temporary, target);
}
type Bounds = Omit<Extract<ProcessCommand, { schemaVersion: 2 }>, 'requestId' | 'executable' | 'args' | 'cwd' | 'env' | 'schemaVersion'>;
/**
 * The one way a headless CLI process starts (preflight probes and the call): inside the realm, with the connection's own gateway for the
 * provider's allowlisted endpoints, the login dir as the only host directory it may write and the run dir as private memory. The gateway lives
 * exactly as long as the process. A realm that could not start is a typed isolation refusal; no path runs the CLI outside it.
 */
export async function runHeadlessIsolated(entry: HeadlessEntry, isolation: HeadlessIsolation, spawn: HeadlessSpawn, bounds: Bounds, signal?: AbortSignal,
  onLine?: ProcessLineConsumer): Promise<ProcessEvidence & { egress: HeadlessEgress; limit: HeadlessLimit | null }> {
  const seal = await headlessIsolationSeal(isolation), realm = entry.headless.isolation, provider = nativeCliIdSchema.safeParse(entry.id);
  if (!provider.success) refuse('HEADLESS_REQUEST_INVALID', { reason: 'definition' });
  // The relay runs on this process's own Node.js (bound read-only at its path: a test CLI's shebang names the same path).
  const masks = await loginMasks(spawn.configDir, realm.configVisible, realm.configMaxEntries), node = process.execPath, caps = realm.limits;
  // f5: the limiter sets the realm's CPU, data and task bounds before the relay starts; without it the CLI never runs (no unbounded fallback).
  const limiter = await realpath(caps.limiter).catch(() => null);
  if (!limiter || !await access(limiter, constants.X_OK).then(() => true, () => false)) refuse('HEADLESS_ISOLATION_UNAVAILABLE', { check: 'limits' });
  const gateway = await openNativeEgressGateway({ provider: provider.data, directory: spawn.stateDir }).catch(() => refuse('HEADLESS_ISOLATION_UNAVAILABLE', { check: 'gateway' }));
  try {
    const cpu = `${caps.cpuSeconds}:${caps.cpuSeconds + caps.cpuGraceSeconds}`, egress = nativeEgressLimits();
    const relay = JSON.stringify({ socket: realm.socketPath, host: realm.proxy.host, port: realm.proxy.port, connections: egress.connections, idleMs: egress.idleMs,
      cpu, processes: `${caps.processes}:${caps.processes}`, data: `${caps.dataBytes}:${caps.dataBytes}`, ticks: USER_HZ,
      sampleMs: caps.sampleMs, permille: caps.attributionPermille, exits: caps.exits });
    const command = isolatedProcessCommand({ shell: realm.shell, launcher: seal.path, fileSizeBlocks: realm.limits.fileSizeBlocks, openFiles: realm.limits.openFiles,
      view: { workDir: spawn.runDir, workFiles: spawn.promptFile ? [spawn.promptFile] : [], executables: [...new Set([spawn.executable, node, limiter])], stateDir: spawn.configDir,
        stateMasks: masks, sockets: [{ source: gateway.socketPath, target: realm.socketPath }], tmpfsBytes: realm.limits.tmpfsBytes },
      command: [limiter, `--cpu=${cpu}`, `--nproc=${caps.processes}`, `--data=${caps.dataBytes}`, '--', node, '-e', RELAY, relay, spawn.executable, ...spawn.args] });
    if (!command) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir' });
    const evidence = await runNodeProcess({ schemaVersion: 2, requestId: randomUUID(), executable: command.executable, args: [...command.args], cwd: spawn.runDir, env: spawn.env,
      ...bounds }, signal, onLine);
    const summary = gateway.egress();
    await recordEgress(spawn.stateDir, summary, spawn.now, egress.refusedHostsMax).catch(() => undefined);
    const stderr = evidence.reason === 'exit' && evidence.exitCode !== 0 ? Buffer.from(evidence.stderrBase64, 'base64').toString('utf8') : '';
    if (LIMITS_FAILURE.test(stderr)) refuse('HEADLESS_ISOLATION_UNAVAILABLE', { check: 'limits' });
    if (REALM_FAILURE.test(stderr)) refuse('HEADLESS_ISOLATION_UNAVAILABLE', { check: 'realm' });
    const limit = evidence.reason === 'exit' ? (Object.entries(caps.exits) as [HeadlessLimit, number][]).find(([, code]) => code === evidence.exitCode)?.[0] ?? null : null;
    return { ...evidence, egress: summary, limit };
  } finally { await gateway.close(); }
}
