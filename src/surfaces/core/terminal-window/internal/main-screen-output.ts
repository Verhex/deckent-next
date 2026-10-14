/** Ink's resize overflow clear contains ED2 + ED3. Preserve main-screen scrollback while retaining its cursor/visible-screen redraw.
 * Explicit owner `/clear` writes HOME + ED2 + ED3 instead and remains unchanged. No terminal-wide scroll region is installed. */
export function preserveMainScreenScrollback(text: string): string {
  return text.replaceAll('\u001b[2J\u001b[3J\u001b[H', '\u001b[2J\u001b[H');
}

/** Forward sizes, resize subscriptions and write backpressure to the real stream. Never wrap a pipe. */
export function mainScreenOutput(stdout: NodeJS.WriteStream): NodeJS.WriteStream {
  if (!stdout.isTTY) return stdout;
  const write: NodeJS.WriteStream['write'] = (chunk, encodingOrCallback?, callback?) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
    const filtered = preserveMainScreenScrollback(text);
    if (typeof encodingOrCallback === 'function') return stdout.write(filtered, encodingOrCallback as (err?: Error | null) => void);
    return stdout.write(filtered, encodingOrCallback, callback as ((err?: Error | null) => void) | undefined);
  };
  return new Proxy(stdout, { get(target, key) {
    if (key === 'write') return write;
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
