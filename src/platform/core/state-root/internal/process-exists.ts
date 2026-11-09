/** X11 (KG7 F5) [floor]: the one PID probe. Only ESRCH proves a process gone; EPERM or any other error reads alive (the busy side). */
export function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

