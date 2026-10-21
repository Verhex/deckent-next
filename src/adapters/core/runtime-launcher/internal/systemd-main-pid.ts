import { execFile } from 'node:child_process';

/** One bounded command without a shell; resolves with its stdout, rejects on a failed, absent, over-bound or timed-out run. */
export type SystemdQueryExec = (file: string, args: readonly string[], options: Readonly<{ env: Readonly<Record<string, string>>; timeout: number;
  maxBuffer: number }>) => Promise<string>;
const execBounded: SystemdQueryExec = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], { ...options, encoding: 'utf8', shell: false }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});
const UNIT = /^[^\s-]\S*\.service$/;
const PID = /^[1-9][0-9]*$/;
/** Only what reaches the manager's bus: never the caller's other variables (they can hold credentials). */
const BUS_ENVIRONMENT = ['PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const;
/**
 * CI-108: the unit's main process as systemd itself reports it (`systemctl [--user] show -p MainPID --value -- <unit>`), within the caller's
 * time and output bounds. Null when there is none (`0`), the answer is not one positive process id, or the manager is absent, unreachable or slow.
 */
export async function querySystemdMainPid(unit: Readonly<{ scope: 'user' | 'system'; unit: string }>, bounds: Readonly<{ timeoutMs: number; outputBytes: number }>,
  env: Readonly<Record<string, string | undefined>> = process.env, exec: SystemdQueryExec = execBounded): Promise<number | null> {
  if (!UNIT.test(unit.unit)) return null;
  const busEnv = Object.fromEntries(BUS_ENVIRONMENT.flatMap(name => (typeof env[name] === 'string' ? [[name, env[name]]] : [])));
  const answer = await exec('systemctl', [...(unit.scope === 'user' ? ['--user'] : []), 'show', '-p', 'MainPID', '--value', '--', unit.unit],
    { env: busEnv, timeout: bounds.timeoutMs, maxBuffer: bounds.outputBytes }).catch(() => null);
  const text = answer?.trim() ?? '';
  const pid = PID.test(text) ? Number(text) : 0;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
