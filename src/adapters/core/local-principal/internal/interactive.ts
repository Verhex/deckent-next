import { readFile, readlink, stat } from 'node:fs/promises';

/** Service-held process evidence, never a client TTY flag. Both input and output must use its controlling terminal. */
export async function attestLocalInteractiveTerminal(pid = process.pid, uid = process.getuid?.() ?? -1): Promise<boolean> {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    const base = `/proc/${pid}`;
    const [before, owner, input, output, inDevice, outDevice] = await Promise.all([
      readFile(`${base}/stat`, 'utf8'), stat(base), readlink(`${base}/fd/0`), readlink(`${base}/fd/1`), stat(`${base}/fd/0`), stat(`${base}/fd/1`),
    ]);
    const fields = before.slice(before.lastIndexOf(')') + 2).trim().split(/\s+/);
    const after = await readFile(`${base}/stat`, 'utf8');
    const current = after.slice(after.lastIndexOf(')') + 2).trim().split(/\s+/);
    return owner.uid === uid && fields[4] !== '0' && fields[19] !== undefined && fields[19] === current[19]
      && fields[4] === current[4] && !['Z', 'X', 'x'].includes(current[0] ?? '')
      && /^\/dev\/(?:pts\/\d+|tty\d+)$/.test(input) && input === output
      && inDevice.isCharacterDevice() && outDevice.isCharacterDevice()
      && inDevice.rdev === outDevice.rdev && BigInt(inDevice.rdev) === BigInt(fields[4] ?? 0);
  } catch { return false; }
}
