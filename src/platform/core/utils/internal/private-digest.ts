import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { PrivateFileError, privateFile } from './private-file.js';
/** Stream a private file through one descriptor; content, size and timestamps must stay stable through the read. I/O errors remain raw. */
export async function digestPrivateFile(path: string): Promise<string> {
  const hash = createHash('sha256'), handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!privateFile(before)) throw new PrivateFileError('unsafe');
    let bytes = 0;
    for await (const chunk of createReadStream(path, { fd: handle.fd, autoClose: false, end: Math.max(0, before.size - 1) })) { bytes += chunk.length; hash.update(chunk); }
    const after = await handle.stat();
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new PrivateFileError('changed');
    return hash.digest('hex');
  } finally { await handle.close(); }
}
