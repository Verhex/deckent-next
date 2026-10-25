/** A person's terminal input as a hold needs it (process.stdin on a TTY). */
type HeldInput = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown; unref?: () => unknown };
type Hold = { lent: boolean; attach(): void; detach(): void };
const holds = new WeakMap<object, Hold>();

/**
 * Between two views of one flow (init's window and the cards its stages open) the person's keys are neither echoed nor kept: the terminal stays in
 * raw mode and what is typed is discarded, so an arrow key never prints `^[[B` over the next frame and a stray Enter never answers the next card.
 * A view or a child that needs the input borrows it with `lendHeldInput` and gives it back. Ctrl+C typed while nothing else reads keeps its usual
 * meaning (SIGINT). The hold never keeps the process alive. Not a TTY with raw mode, or already held: a no-op. Returns the release.
 */
export function holdTerminalInput(stdin: HeldInput): () => void {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function' || holds.has(stdin)) return () => undefined;
  // Paused mode ('readable'), as Ink reads: a stream once switched to flowing ('data') and paused never wakes a later 'readable' reader.
  const discard = () => {
    let interrupt = false;
    for (let chunk = stdin.read(); chunk !== null; chunk = stdin.read()) interrupt ||= String(chunk).includes('\u0003');
    if (!interrupt || stdin.listenerCount('readable') > 1 || stdin.listenerCount('data') > 0) return;
    release(); process.kill(process.pid, 'SIGINT');
  };
  const hold: Hold = { lent: false,
    attach: () => { stdin.setRawMode!(true); stdin.on('readable', discard); stdin.unref?.(); },
    detach: () => { stdin.off('readable', discard); } };
  const release = () => {
    if (holds.get(stdin) !== hold) return;
    holds.delete(stdin);
    if (!hold.lent) hold.detach();
    stdin.setRawMode!(false); stdin.pause();
  };
  holds.set(stdin, hold); hold.attach();
  return release;
}

/**
 * Lends held input to an Ink view (raw mode stays on, so nothing echoes before the view reads) or, with `plain`, to a child that takes the
 * terminal itself (sudo's prompt: the line discipline back, nothing read here). The returned function takes the input back after the borrower
 * is done. Not held, or already lent: a no-op.
 */
export function lendHeldInput(stdin: object, options: Readonly<{ plain?: boolean }> = {}): () => void {
  const hold = holds.get(stdin);
  if (!hold || hold.lent) return () => undefined;
  hold.lent = true; hold.detach();
  if (options.plain) { (stdin as HeldInput).setRawMode?.(false); (stdin as HeldInput).pause(); }
  return () => { if (holds.get(stdin) !== hold || !hold.lent) return; hold.lent = false; hold.attach(); };
}
