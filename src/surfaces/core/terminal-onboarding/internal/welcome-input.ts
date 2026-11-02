import { PassThrough } from 'node:stream';

// Ink may keep an unfinished escape or paste across reads; the welcome must retain that prefix too.
function pendingInput(text: string): string {
  const paste = text.lastIndexOf('\u001b[200~');
  if (paste > text.lastIndexOf('\u001b[201~')) return text.slice(paste);
  const escape = text.lastIndexOf('\u001b'), tail = text.slice(escape);
  // eslint-disable-next-line no-control-regex -- incomplete CSI/SS3 prefix, not a printable key.
  return escape >= 0 && /^\u001b(?:\[[0-?]*[ -/]*|O?)?$/u.test(tail) ? tail : '';
}
/** Only the welcome yields to typing: keep the triggering read intact until its card has unmounted. */
export function welcomeInput(source: NodeJS.ReadStream) {
  const input = Object.assign(new PassThrough(), {
    isTTY: source.isTTY,
    setRawMode(mode: boolean) { if (!typing || mode) source.setRawMode(mode); return input; },
    ref() { source.ref(); return input; }, unref() { source.unref(); return input; },
  });
  Object.defineProperty(input, 'isRaw', { get: () => source.isRaw });
  const read = input.read.bind(input);
  let current = '', pending = '', typing = false;
  input.read = (size?: number) => {
    if (typing) return null;
    const chunk = read(size) as string | Buffer | null;
    if (chunk !== null) { current = pending + String(chunk); pending = pendingInput(current); }
    return chunk;
  };
  source.pipe(input);
  return {
    stdin: input as unknown as NodeJS.ReadStream,
    typed() { typing = true; source.unpipe(input); source.pause(); },
    close() {
      source.unpipe(input); source.pause();
      // Unshift only after Ink detached, ahead of keys still in the source; the next owner reads each byte once.
      if (typing) {
        const rest: Array<string | Buffer> = []; let chunk: string | Buffer | null;
        while ((chunk = read() as string | Buffer | null) !== null) rest.push(chunk);
        for (const chunk of rest.reverse()) source.unshift(chunk);
        if (current) source.unshift(current);
      }
      input.destroy();
    },
  };
}
