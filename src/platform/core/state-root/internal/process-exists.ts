/** Only ESRCH proves that no process with this PID exists. */
export function probeProcessExistence(pid: number): 'present' | 'absent' | 'unverified' {
  try { process.kill(pid, 0); return 'present'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'unverified'; }
}

/** EPERM or any other probe failure stays on the busy side. */
export function processExists(pid: number): boolean {
  return probeProcessExistence(pid) !== 'absent';
}
