import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach } from 'vitest';
import type { ConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import type { LocalPeerIdentity } from '#adapters/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';

// Separate control pipes leave the SDK child's stdin/stdout on a real controlling PTY.
const DRIVER = String.raw`
import json, os, pty, select, sys
argv = json.loads(sys.argv[1])
command_read, command_write = os.pipe()
result_read, result_write = os.pipe()
pid, terminal = pty.fork()
if pid == 0:
    source, target = os.dup(command_read), os.dup(result_write)
    os.dup2(source, 3); os.dup2(target, 4)
    os.set_inheritable(3, True); os.set_inheritable(4, True)
    os.execvp(argv[0], argv)
os.close(command_read); os.close(result_write)
try:
    while True:
        ready, _, _ = select.select([0, result_read, terminal], [], [])
        for fd in ready:
            try: data = os.read(fd, 65536)
            except OSError: data = b''
            if not data: sys.exit(0)
            if fd == 0: os.write(command_write, data)
            elif fd == result_read: os.write(1, data)
            else: os.write(2, data)
finally:
    try: os.kill(pid, 15)
    except ProcessLookupError: pass
    os.waitpid(pid, 0)
`;
const cleanups: (() => void)[] = [];
const peers = new WeakMap<ConfiguredRuntimeClient, Promise<LocalPeerIdentity>>();
const approvalPeers = new Map<string, Promise<LocalPeerIdentity>>();
afterEach(() => { for (const close of cleanups.splice(0)) close(); approvalPeers.clear(); });
/** Real interactive peer for existing terminal approval integration cases; no attestation is mocked. */
export function createTerminalRuntimeClient(project: string, options: ConfigLoadOptions = {}): ConfiguredRuntimeClient {
  const argv = [process.execPath, resolve('tests/fixtures/approval-terminal-client.mjs'), project, JSON.stringify(options)];
  const child = spawn('python3', ['-c', DRIVER, JSON.stringify(argv)], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; args: unknown[]; clear: () => void }>();
  let ready!: (peer: LocalPeerIdentity) => void;
  const peer = new Promise<LocalPeerIdentity>(resolve => { ready = resolve; });
  const connection = new AbortController();
  let alive = true;
  let next = 0, stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
  child.on('exit', () => { alive = false; connection.abort(); for (const item of pending.values()) { item.clear(); item.reject(new Error(stderr || 'terminal peer exited')); } pending.clear(); });
  createInterface({ input: child.stdout }).on('line', line => {
    const value = JSON.parse(line) as { ready?: { pid: number; uid: number; gid: number }; id: number; event?: unknown; index?: number; result?: unknown; error?: { code?: string; params?: Record<string, unknown>; message: string } };
    if (value.ready) { ready({ ...value.ready, assurance: 'linux-so-peercred', connection: connection.signal, isConnectionActive: () => alive }); return; }
    const item = pending.get(value.id); if (!item) return;
    if ('event' in value) { (item.args[value.index!] as (event: unknown) => void)(value.event); return; }
    pending.delete(value.id); item.clear();
    if (value.error) item.reject(value.error.code && ErrorRegistry.has(value.error.code)
      ? ErrorRegistry.createError(value.error.code, { params: value.error.params }) : new Error(value.error.message));
    else item.resolve(value.result);
  });
  cleanups.push(() => { child.stdin.end(); });
  const client = new Proxy({}, { get: (_target, method) => method === 'then' ? undefined : (...args: unknown[]) => new Promise((resolve, reject) => {
    const id = ++next;
    const signal = args.find(value => value instanceof AbortSignal) as AbortSignal | undefined;
    const abort = () => child.stdin.write(JSON.stringify({ id, abort: true }) + '\n');
    pending.set(id, { resolve, reject, args, clear: () => signal?.removeEventListener('abort', abort) });
    child.stdin.write(JSON.stringify({ id, method, args: args.map(value => typeof value === 'function' ? { fixture: 'callback' }
      : value instanceof AbortSignal ? { fixture: 'signal' } : value === undefined ? { fixture: 'undefined' } : value) }) + '\n');
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  }) }) as ConfiguredRuntimeClient;
  peers.set(client, peer);
  return client;
}
/** Trusted in-process transport fixture: points the composition at a live PTY process, never at a client-supplied isTTY. */
export const terminalRuntimePeer = (client: ConfiguredRuntimeClient) => peers.get(client)!;
export async function terminalApproval(project: string, action: 'decide', input: unknown, options: ConfigLoadOptions = {}) {
  const key = JSON.stringify([project, options]);
  if (!approvalPeers.has(key)) approvalPeers.set(key, terminalRuntimePeer(createTerminalRuntimeClient(project, options)));
  return configuredApproval(project, action, input, options, await approvalPeers.get(key)!);
}
