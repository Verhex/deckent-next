import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { z } from 'zod';
import { findExecutable, runDetectCommand, type DetectEnvironment, type DetectRunner } from './process.js';
import type { ExecutionFacts, RuntimeFacts } from './family.js';
import registryData from './runtimes.json' with { type: 'json' };
import limits from './limits.json' with { type: 'json' };

const argv = z.array(z.string().min(1).max(256)).max(16), name = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const runtimeEntry = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), label: z.string().min(1).max(64), support: z.enum(['supported', 'unsupported']),
  executable: name, versionArgs: argv.optional(), endpointArgs: argv.optional(), infoArgs: argv.optional(), groupArgs: argv.optional(), groupExecutable: name.optional(),
  userSocketPrefix: z.string().startsWith('/').optional(), rootless: z.object({ securityOptions: z.array(z.string()).max(8) }).strict().optional(),
  desktop: z.object({ operatingSystem: z.array(z.string()).max(8), cliPrefixes: z.array(z.string().startsWith('/')).max(8) }).strict().optional() }).strict()
  .refine(entry => entry.support === 'unsupported' || (entry.versionArgs && entry.endpointArgs && entry.infoArgs));
export type ExecutionRuntimeEntry = z.infer<typeof runtimeEntry>;
/** The versioned execution-environment registry (data, not code): Docker is the only supported entry today; later runtimes are entries here. */
export const parseExecutionRuntimes = (input: unknown): readonly ExecutionRuntimeEntry[] =>
  z.object({ $comment: z.string().optional(), schemaVersion: z.literal(1), runtimes: z.array(runtimeEntry).min(1).max(limits.runtimes) }).strict().parse(input).runtimes;
export const EXECUTION_RUNTIMES = parseExecutionRuntimes(registryData);

type SocketState = Readonly<{ state: 'missing' | 'accessible' | 'denied' | 'unknown'; gid: number | null }>;
/** Read-only host ports; tests replace them with fakes (absent, stopped, no permission, no answer). */
export type ExecutionDetectPorts = Readonly<{ run: DetectRunner; find: typeof findExecutable; realpath: (path: string) => Promise<string>;
  socket: (path: string) => Promise<SocketState>; groups: () => readonly number[]; user: () => string }>;
export const HOST_EXECUTION_PORTS: ExecutionDetectPorts = Object.freeze({ run: runDetectCommand, find: findExecutable, realpath: (path: string) => realpath(path),
  groups: () => process.getgroups?.() ?? [], user: () => userInfo().username, socket: async (path: string): Promise<SocketState> => {
    const info = await stat(path).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? 'missing' as const : null);
    if (info === 'missing' || info === null) return { state: info ?? 'unknown', gid: null };
    return { state: await access(path, constants.R_OK | constants.W_OK).then(() => 'accessible' as const, () => 'denied' as const), gid: info.gid };
  } });
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const json = (text: string): Record<string, unknown> => { try { return record(JSON.parse(text)); } catch { return {}; } };
const version = (value: unknown) => typeof value === 'string' && /^[0-9A-Za-z.+~_-]{1,64}$/u.test(value) ? value : null;

/**
 * Detection only (INIT-D2: installing is I-D2): per registry entry, the CLI on PATH, its version, the service it talks to, whether this user may
 * reach it, and its kind. Read-only registry argv under one shared deadline; never starts a service, pulls an image, writes or asks for sudo.
 * A probe that cannot answer reports `unknown`, never a guess.
 */
export async function detectExecutionFacts(input: Readonly<{ env: DetectEnvironment; ports?: ExecutionDetectPorts; runtimes?: readonly ExecutionRuntimeEntry[]; signal?: AbortSignal }>): Promise<ExecutionFacts> {
  const ports = input.ports ?? HOST_EXECUTION_PORTS, signal = AbortSignal.any([AbortSignal.timeout(limits.totalTimeoutMs), ...(input.signal ? [input.signal] : [])]), runtimes: RuntimeFacts[] = [];
  for (const entry of input.runtimes ?? EXECUTION_RUNTIMES) runtimes.push(await detectRuntime(entry, input.env, ports, signal));
  return { schemaVersion: 1, runtimes };
}

async function detectRuntime(entry: ExecutionRuntimeEntry, env: DetectEnvironment, ports: ExecutionDetectPorts, signal: AbortSignal): Promise<RuntimeFacts> {
  const base = { id: entry.id, label: entry.label, support: entry.support, path: null, version: null, daemon: 'not-run', serverVersion: null, kind: null,
    endpoint: null, group: null } as const;
  const path = await ports.find(entry.executable, env, limits.pathDirectories, signal);
  if (!path) return { ...base, cli: signal.aborted ? 'unknown' : 'absent' };
  if (entry.support === 'unsupported' || !entry.versionArgs || !entry.endpointArgs || !entry.infoArgs) return { ...base, cli: 'found', path };
  const run = (args: readonly string[], executable = path) => ports.run(executable, args, { env, timeoutMs: limits.commandTimeoutMs, outputBytes: limits.outputBytes, signal });
  const versions = await run(entry.versionArgs), parsed = json(versions.stdout), serverVersion = version(record(parsed['Server'])['Version']);
  const real = await ports.realpath(path).catch(() => path), desktopCli = (entry.desktop?.cliPrefixes ?? []).some(prefix => real.startsWith(prefix));
  const host = json((await run(entry.endpointArgs)).stdout)['Host'], socket = typeof host === 'string' && host.startsWith('unix://') ? host.slice('unix://'.length) : null;
  const endpoint = typeof host !== 'string' ? null : !socket ? 'remote' : entry.userSocketPrefix && socket.startsWith(entry.userSocketPrefix) ? 'user' : 'system';
  const found = { ...base, cli: 'found', path, version: version(record(parsed['Client'])['Version']), endpoint } as const;
  if (serverVersion) {
    const info = json((await run(entry.infoArgs)).stdout), options = Array.isArray(info['SecurityOptions']) ? info['SecurityOptions'].map(String) : [];
    const kind = desktopCli || (entry.desktop?.operatingSystem ?? []).includes(String(info['OperatingSystem'])) ? 'desktop'
      : options.some(option => (entry.rootless?.securityOptions ?? []).includes(option)) ? 'rootless' : Object.keys(info).length ? 'engine' : 'unknown';
    return { ...found, daemon: 'reachable', serverVersion, kind };
  }
  const kind = desktopCli ? 'desktop' : endpoint === 'user' ? 'rootless' : null;
  // No server answer: tell a stopped service from a socket this user may not open, from the socket itself (never from the CLI's English text).
  const state = versions.code === null || !socket ? null : await ports.socket(socket);
  if (state?.state !== 'denied') return { ...found, kind, daemon: !state ? versions.code === null ? 'unknown' : 'unreachable' : state.state === 'unknown' ? 'unknown' : 'unreachable' };
  return { ...found, kind, daemon: 'no-permission', group: await groupState(entry, state.gid, env, ports, run) };
}

/** `member`: this session holds the socket's group; `relogin`: the user is in it, but this session started before (log in again or newgrp). */
async function groupState(entry: ExecutionRuntimeEntry, gid: number | null, env: DetectEnvironment, ports: ExecutionDetectPorts,
  run: (args: readonly string[], executable?: string) => ReturnType<DetectRunner>): Promise<RuntimeFacts['group']> {
  if (gid === null) return 'unknown';
  if (ports.groups().includes(gid)) return 'member';
  const tool = entry.groupExecutable && entry.groupArgs ? await ports.find(entry.groupExecutable, env, limits.pathDirectories, AbortSignal.timeout(limits.commandTimeoutMs)) : null;
  const listed = tool ? await run([...entry.groupArgs!, ports.user()], tool) : null;
  return listed?.code !== 0 ? 'unknown' : listed.stdout.trim().split(/\s+/u).map(Number).includes(gid) ? 'relogin' : 'not-member';
}
