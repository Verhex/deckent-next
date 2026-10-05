import type { ChildProcess } from 'node:child_process';

/** An IPC event marks the phase boundary; the enclosing test still bounds startup.
 * A spawn event proves only OS process creation, not completion of module loading or transport setup.
 */
export function processReady(child: ChildProcess, event: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => { child.off('message', message); child.off('error', failed); child.off('close', closed); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const closed = (code: number | null, signal: NodeJS.Signals | null) => failed(new Error(`PROCESS_CLOSED_BEFORE_${event}:${code}:${signal}`));
    const message = (value: unknown) => { if (value === event) { cleanup(); resolve(); } };
    child.on('message', message); child.once('error', failed); child.once('close', closed);
  });
}
