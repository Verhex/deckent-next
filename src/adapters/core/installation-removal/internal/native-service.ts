import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { removalRegistry } from './inventory.js';
/** One bounded `systemctl --user` command. */
export type NativeServiceExec = (args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;
/** No shell, elevation or inherited credentials; systemctl by absolute path from the registry (K4). Commands and output share the caller's limits. */
export function nativeServiceExec(bounds: { timeoutMs: number; outputBytes: number }, env: Readonly<Record<string, string | undefined>>): NativeServiceExec {
  const bus = Object.fromEntries(['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].flatMap(key => env[key] === undefined ? [] : [[key, env[key]]]));
  const systemctl = removalRegistry.systemctl.find(path => existsSync(path));
  return args => new Promise((resolve, reject) => systemctl ? execFile(systemctl, ['--user', ...args], { env: bus, shell: false, encoding: 'utf8',
    timeout: bounds.timeoutMs, maxBuffer: bounds.outputBytes }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve({ stdout, stderr })) : reject(new Error('SYSTEMCTL_ABSENT')));
}
