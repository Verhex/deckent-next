import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { removalRegistry } from './inventory.js';
/** One bounded `systemctl --user` command. */
export type NativeServiceExec = (args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;
/** No shell, elevation or inherited credentials; systemctl by absolute path from the registry (K4). Commands and output share the caller's limits. */
export function nativeServiceExec(bounds: { timeoutMs: number; outputBytes: number }, env: Readonly<Record<string, string | undefined>>): NativeServiceExec {
  const bus = { LC_ALL: 'C', ...Object.fromEntries(['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].flatMap(key => env[key] === undefined ? [] : [[key, env[key]]])) };
  const systemctl = removalRegistry.systemctl.find(path => existsSync(path));
  return args => new Promise((resolve, reject) => systemctl ? execFile(systemctl, ['--user', ...args], { env: bus, shell: false, encoding: 'utf8',
    timeout: bounds.timeoutMs, maxBuffer: bounds.outputBytes }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })) : reject(new Error('SYSTEMCTL_ABSENT')));
}

/** Queries executed by the running manager in its own namespace/environment, including process membership and disable dry-run. */
export function nativeUserUnitLinks(bounds: { timeoutMs: number; outputBytes: number }, env: Readonly<Record<string, string | undefined>>) {
  const busctl = removalRegistry.busctl.find(path => existsSync(path));
  const bus = Object.fromEntries(['HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].flatMap(key => env[key] === undefined ? [] : [[key, env[key]]]));
  const call = (method: string, signature: string, args: readonly string[], type: string): Promise<unknown[]> => new Promise((resolve, reject) => busctl ? execFile(busctl,
    ['--user', '--json=short', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', method, signature, ...args],
    { env: bus, shell: false, encoding: 'utf8', timeout: bounds.timeoutMs, maxBuffer: bounds.outputBytes }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { const result = JSON.parse(stdout) as { type?: string; data?: unknown[] }, data = result.data?.[0];
        if (result.type !== type || !Array.isArray(data)) throw new Error('UNIT_MANAGER_EVIDENCE_UNPROVEN'); resolve(data);
      } catch (failure) { reject(failure); }
    }) : reject(new Error('BUSCTL_ABSENT')));
  return Object.assign(async (unit: string): Promise<readonly string[]> => {
    const paths = await call('GetUnitFileLinks', 'sb', [unit, 'false'], 'as');
    if (paths.some(path => typeof path !== 'string')) throw new Error('UNIT_LINKS_UNPROVEN'); return paths as string[];
  }, { async processes(unit: string): Promise<readonly number[]> {
    const rows = await call('GetUnitProcesses', 's', [unit], 'a(sus)');
    if (rows.some(row => !Array.isArray(row) || !Number.isSafeInteger(row[1]) || Number(row[1]) < 1)) throw new Error('UNIT_PROCESSES_UNPROVEN');
    return rows.map(row => (row as [string, number, string])[1]); // command lines never escape this adapter
  } });
}
