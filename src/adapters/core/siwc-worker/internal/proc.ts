import { readFileSync } from 'node:fs';

/** Kernel start time (clock ticks since boot, /proc/<pid>/stat field 22): with the pid it names one process incarnation. */
export function procStartTime(pid: number): string | null {
  try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null; } catch { return null; }
}
/**
 * U9-6 supervisor-established peer: a host-pid-namespace pid is the init process (pid 1 of its own pid namespace) of exactly `containerId`'s
 * cgroup. Only the Deckent bootstrap is that process (`--entrypoint node /run/deckent-bootstrap.mjs`); a tool child or helper re-exec in the
 * same container has another pid and is refused. Unreadable facts refuse.
 */
export function containerInitPeer(pid: number, containerId: string): Readonly<{ pid: number; startTime: string }> | null {
  try {
    if (!/^[a-f0-9]{64}$/u.test(containerId)) return null;
    const cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n');
    if (!cgroup.some(line => line.endsWith(`/docker-${containerId}.scope`) || line.endsWith(`/docker/${containerId}`) || line.endsWith(`/${containerId}`))) return null;
    const nspid = /^NSpid:\s+(.+)$/mu.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]?.trim().split(/\s+/u) ?? [];
    const startTime = procStartTime(pid);
    return nspid.length >= 2 && nspid[0] === String(pid) && nspid.at(-1) === '1' && startTime ? Object.freeze({ pid, startTime }) : null;
  } catch { return null; }
}
/** Yama ptrace scope of the shared kernel (null: no Yama). At 1+ a tool child cannot attach to (or read the memory of) its ancestors —
 * the bootstrap, app-server and helper that hold the relay capability. */
export function yamaPtraceScope(): number | null {
  try { const value = Number(readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim()); return Number.isSafeInteger(value) ? value : null; } catch { return null; }
}
