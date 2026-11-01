import { createContext, useCallback, useContext } from 'react';
import { useApp, useStdout } from 'ink';

/** PV: what the terminal host switches off while a child process owns the terminal (mouse and focus reports); null where no host takes them. */
export const TerminalHandoverContext = createContext<Readonly<{ release(): void; reclaim(): void }> | null>(null);

/**
 * PV 3: hands the terminal to a child process the way `$EDITOR` gets it (terminal-host `useDraftHandoffs`): Ink releases raw mode, bracketed
 * paste and the alternate screen, the host's mouse and focus reports go off, SIGINT is left to the child in the same foreground group (it never
 * ends this process), `banner` is printed above the child, and a line break follows the child's last output (PV 2e) before everything is restored
 * on every path. `work` is the caller's (it owns the child, its bound and its result); a failed hand-over resolves to null.
 */
export function useTerminalHandover() {
  const { suspendTerminal } = useApp(), { stdout } = useStdout(), handover = useContext(TerminalHandoverContext);
  return useCallback(async <T,>(banner: string, work: () => Promise<T>): Promise<T | null> => {
    const ignore = () => undefined; let result: { value: T } | null = null;
    process.on('SIGINT', ignore);
    try {
      await suspendTerminal(async () => {
        handover?.release();
        try { stdout.write(`${banner}\n`); result = { value: await work() }; } finally { stdout.write('\n'); handover?.reclaim(); }
      });
    } catch { /* the hand-over failed: null */ } finally { process.off('SIGINT', ignore); }
    return (result as { value: T } | null)?.value ?? null;
  }, [suspendTerminal, stdout, handover]);
}
