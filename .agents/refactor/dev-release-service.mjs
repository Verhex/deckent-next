// Developer-host lifecycle discovery; no raw signal substitutes for governed shutdown.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI_ENTRY = '/dist/composition/core/cli/internal/entry.js';
const UNIT = 'deckent-n1.service';
export function cliOfProcess(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').find(arg => arg.endsWith(CLI_ENTRY)) ?? null; }
  catch { return null; }
}
function belongsToProject(L, pid) {
  try { return statSync(`/proc/${pid}`).uid === process.getuid() && realpathSync(`/proc/${pid}/cwd`) === realpathSync(L.project); }
  catch { return false; }
}
function holdsLedger(L, pid) {
  let config = {}; try { config = JSON.parse(readFileSync(join(L.project, '.deckent/config.json'), 'utf8')); } catch { /* same defaults as dataPaths */ }
  const root = config.layout?.root ?? join(L.project, '.deckent');
  const lockPath = join(root, ...(config.layout?.resources?.ledger ?? 'state/ledger.db').split('/')) + '-lock';
  try {
    const lock = statSync(lockPath);
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const opened = statSync(`/proc/${pid}/fd/${fd}`);
        if (opened.dev === lock.dev && opened.ino === lock.ino
          && /lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s/u.test(readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'))) return true;
      } catch { /* process/fd closed during discovery */ }
    }
  } catch { /* custody cannot be established */ }
  return false;
}
/** Probe each scoped service PID with its own CLI, so it uses that release's endpoint and protocol rules. */
export function discoverService(L, fallbackCli, node, describe) {
  const found = describe(L, fallbackCli, node);
  if (found.descriptor) return { ...found, cli: fallbackCli };
  for (const name of readdirSync('/proc').filter(name => /^\d+$/u.test(name))) {
    const pid = Number(name), cli = cliOfProcess(pid);
    if (!cli || !belongsToProject(L, pid) || !holdsLedger(L, pid)) continue;
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      const at = argv.indexOf(cli);
      if (argv[at + 1] !== 'runtime' || argv[at + 2] !== 'serve') continue;
    } catch { continue; }
    const candidate = describe(L, cli, node);
    if (candidate.descriptor?.processId === pid) return { ...candidate, cli };
  }
  return found;
}

function control(opts, action, extra = []) {
  const args = ['--user', action, UNIT, ...extra];
  return (opts.systemctl ?? ((args, timeout) => spawnSync('systemctl', args, { encoding: 'utf8', timeout })))(args, opts.startTimeoutMs);
}
const cgroup = (pid, opts) => (opts.readCgroup ?? (pid => readFileSync(`/proc/${pid}/cgroup`, 'utf8')))(pid)
  .trim().split('\n').map(line => line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1));
const inGroup = (pid, group, opts) => { try { return cgroup(pid, opts).some(path => path === group || path.startsWith(group + '/')); } catch { return false; } };
const marker = L => join(L.installRoot, 'service-unit.json');
/** A persisted manager is an installation-scoped recovery hint, revalidated before every effect. */
export function systemdManager(L, pid, opts, fail) {
  const saved = existsSync(marker(L));
  let runningInUnit = false;
  if (pid) {
    try { runningInUnit = cgroup(pid, opts).some(path => path.split('/').includes(UNIT)); }
    catch { fail('DEV_RELEASE_PROCESS_CUSTODY_UNAVAILABLE', { processId: pid }); }
  }
  if (!runningInUnit && !saved) return null;
  if (saved) {
    let hint; try { hint = JSON.parse(readFileSync(marker(L), 'utf8')); } catch { fail('DEV_RELEASE_SYSTEMD_CUSTODY_INVALID', { unit: UNIT }); }
    if (hint.unit !== UNIT || hint.project !== L.project || hint.launcher !== L.launcher || hint.installRoot !== L.installRoot)
      fail('DEV_RELEASE_SYSTEMD_CUSTODY_INVALID', { unit: UNIT });
    if (pid && !runningInUnit) fail('DEV_RELEASE_SYSTEMD_CUSTODY_INVALID', { unit: UNIT, processId: pid });
  }
  const result = control(opts, 'show', ['--property=LoadState,WorkingDirectory,ControlGroup,MainPID,UMask,Restart,ExecStart,Environment']);
  if (result.status !== 0) fail('DEV_RELEASE_SYSTEMD_UNAVAILABLE', { unit: UNIT, error: result.error?.code ?? null, stderr: String(result.stderr ?? '').slice(-800) });
  const properties = Object.fromEntries(String(result.stdout).trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  let directory; try { directory = realpathSync(properties.WorkingDirectory); } catch { /* refused below */ }
  // No shell or alternate entry: the unit must use this installation's pinned launcher.
  const command = properties.ExecStart ?? '';
  const launcher = command.split(/\s|;/u).includes(L.launcher);
  const rootOverride = /(?:^|\s)DECKENT_NEXT_INSTALL_ROOT=([^\s]+)/u.exec(properties.Environment ?? '')?.[1];
  if (properties.LoadState !== 'loaded' || directory !== realpathSync(L.project) || properties.UMask !== '0022'
    || !['no', 'on-failure'].includes(properties.Restart) || !launcher || !command.includes('cli runtime serve')
    || (rootOverride && rootOverride !== L.installRoot)) fail('DEV_RELEASE_SYSTEMD_CUSTODY_INVALID', { unit: UNIT });
  if (pid && (!belongsToProject(L, pid) || !properties.ControlGroup?.split('/').includes(UNIT)
    || !inGroup(pid, properties.ControlGroup, opts) || !inGroup(Number(properties.MainPID), properties.ControlGroup, opts)))
    fail('DEV_RELEASE_SYSTEMD_CUSTODY_INVALID', { unit: UNIT, processId: pid });
  const normal = join(L.globalHome, '../../share/deckent-next-dev');
  if (!rootOverride && L.installRoot !== normal)
    fail('DEV_RELEASE_SYSTEMD_CUSTODY_INVALID', { unit: UNIT, reason: 'unit install root differs' });
  return { unit: UNIT };
}
export function retainManager(L, manager) {
  if (manager) writeFileSync(marker(L), JSON.stringify({ ...manager, project: L.project, launcher: L.launcher, installRoot: L.installRoot }) + '\n', { mode: 0o600 });
}
export function restartManaged(L, opts, fail) {
  systemdManager(L, undefined, opts, fail);
  const result = control(opts, 'restart');
  return result.status === 0 ? null : { code: result.error?.code ?? 'SYSTEMCTL_RESTART_FAILED', message: String(result.stderr ?? 'systemctl restart failed').slice(-800) };
}
export function stopManaged(L, opts, fail) {
  systemdManager(L, undefined, opts, fail);
  const result = control(opts, 'stop');
  if (result.status !== 0) fail('DEV_RELEASE_SYSTEMD_STOP_FAILED', { unit: UNIT, error: result.error?.code ?? null });
}
