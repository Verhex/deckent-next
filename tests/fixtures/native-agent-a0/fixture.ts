import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import manifest from './manifest.json' with { type: 'json' };

export const a0Records = manifest.records;
export type A0Record = (typeof a0Records)[number];
export type A0Event = Record<string, unknown>;
export function a0Record(id: string): A0Record {
  const found = a0Records.find(record => record.id === id);
  if (!found) throw new Error('A0_RECORD_NOT_FOUND: ' + id);
  return found;
}
export function a0Wire(record: A0Record): Promise<Buffer> {
  return readFile(new URL(record.file, import.meta.url));
}
/** Declared publication redaction only: two top-level init paths. All other bytes remain producer bytes. */
export function redactA0Paths(wire: Buffer): Buffer {
  return Buffer.from(wire.toString('utf8').replace(/"(?:cwd|original_cwd)":("(?:\\.|[^"\\])*")/gu, (field, value: string) => {
    const leaf = (JSON.parse(value) as string).split('/').at(-1);
    return field.slice(0, field.indexOf(':') + 1) + JSON.stringify('/fixture/a0/' + leaf);
  }));
}
export async function a0Events(id: string): Promise<A0Event[]> {
  const bytes = await a0Wire(a0Record(id));
  return bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line) as A0Event);
}

/** Copies everything the player needs into the caller's disposable directory, including for a future realm mount.
 * Normal argv is claude --print --output-format stream-json or codex exec --json. No fake auth/help response.
 * `interrupt` is opt-in, limited to retained cancellation runs: emit through the pending call, wait for a signal,
 * then emit the retained tail. Timing is synthetic; wire bytes and exit codes are historical A0 evidence. */
export async function writeA0FakeCli(dir: string, id: string, options: { mode?: 'replay' | 'interrupt'; chunkBytes?: number; waitTimeoutMs?: number } = {}): Promise<string> {
  const record = a0Record(id), wire = await a0Wire(record);
  const mode = options.mode ?? 'replay', chunkBytes = options.chunkBytes ?? wire.length, waitTimeoutMs = options.waitTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || !Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 1) throw new Error('A0_FAKE_INVALID_BOUND');
  if (mode === 'interrupt' && record.reason !== 'cancelled') throw new Error('A0_FAKE_NOT_A_CANCEL_RECORD');
  let pendingBytes = 0;
  if (mode === 'interrupt') {
    let foundPendingCall = false;
    for (const line of wire.toString('utf8').trimEnd().split('\n')) {
      pendingBytes += Buffer.byteLength(line + '\n');
      const event = JSON.parse(line);
      if (event.type === 'item.started' && event.item?.type === 'mcp_tool_call'
        || event.type === 'assistant' && event.message?.content?.some((part: A0Event) => part['type'] === 'tool_use')) {
        foundPendingCall = true;
        break;
      }
    }
    if (!foundPendingCall) throw new Error('A0_FAKE_PENDING_CALL_MISSING');
  }
  const target = join(dir, id);
  await mkdir(target, { mode: 0o700 });
  const executable = join(target, record.cli + '.mjs');
  const script = await readFile(new URL('./replay.mjs', import.meta.url), 'utf8');
  await writeFile(join(target, 'stdout.jsonl'), wire, { mode: 0o600 });
  await writeFile(executable + '.json', JSON.stringify({ cli: record.cli, version: record.version, sha256: record.sha256, mode, chunkBytes, waitTimeoutMs, pendingBytes, exitCode: record.exitCode }), { mode: 0o600 });
  await writeFile(executable, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  return executable;
}
