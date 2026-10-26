import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import LIMITS from './editor.json' with { type: 'json' };
import { callerEnvironment } from '#platform/index.js';

export const TERMINAL_EDITOR_LIMITS = Object.freeze({ maxBytes: LIMITS.maxBytes, directoryPrefix: LIMITS.directoryPrefix, fileName: LIMITS.fileName });
/** Why the draft stayed as it was. Never carries the editor command, the file path or the text. */
export type ExternalEditorRefusal = 'no-editor' | 'not-started' | 'exit' | 'too-large' | 'unsafe' | 'failed';
export type ExternalEditorOutcome = Readonly<{ kind: 'edited'; text: string }> | Readonly<{ kind: 'unchanged' }> | Readonly<{ kind: 'refused'; reason: ExternalEditorRefusal }>;
/** `edit` runs the person's editor on `text` with the terminal handed over (the caller suspends its own screen and input first). */
export interface ExternalEditor { edit(text: string, signal?: AbortSignal): Promise<ExternalEditorOutcome> }
/** `env`: the person's environment: `VISUAL`, then `EDITOR` (as Git, Claude Code and Codex read them); the editor runs with it. */
export interface ExternalEditorOptions { readonly env: NodeJS.ProcessEnv; readonly tmpdir?: string }
/** `VISUAL`/`EDITOR` split into argv: whitespace separates, single or double quotes keep a path with spaces whole. No shell runs. */
export function editorCommand(env: NodeJS.ProcessEnv): readonly string[] | 'unset' | 'malformed' {
  const value = [env['VISUAL'], env['EDITOR']].find(item => typeof item === 'string' && item.trim() !== '')?.trim();
  if (!value) return 'unset';
  const words: string[] = [];
  let word: string | null = null, quote: string | null = null;
  for (const char of value) {
    if (quote) { if (char === quote) quote = null; else word += char; } else if (char === '"' || char === "'") { quote = char; word ??= ''; }
    else if (/\s/u.test(char)) { if (word !== null) words.push(word); word = null; } else word = (word ?? '') + char;
  }
  if (word !== null) words.push(word);
  return quote || !words[0] ? 'malformed' : words;
}

const refused = (reason: ExternalEditorRefusal): ExternalEditorOutcome => Object.freeze({ kind: 'refused', reason });
/**
 * Synchronous on purpose (as Claude Code runs `$EDITOR`): while the editor owns the TTY this process runs no event loop, so it reads no key the editor
 * should get (a paused stream still re-arms a read) and draws nothing; SIGINT from a cooked-mode editor is queued for the caller's listener.
 */
function runEditor(command: readonly string[], file: string, env: NodeJS.ProcessEnv): 'not-started' | 'aborted' | number {
  const result = spawnSync(command[0]!, [...command.slice(1), file], { stdio: 'inherit', shell: false, env: callerEnvironment(env) });
  return result.error ? 'not-started' : result.signal !== null || result.status === null ? 'aborted' : result.status;
}

/**
 * T4 (Ctrl+G, as in Claude Code and Codex): the draft is written to a fresh private directory (0700) as one 0600 file, the person's editor runs on
 * it with the terminal's own input and output, and the file is read back without following a link and only up to the byte bound. The directory
 * and everything an editor left in it (swap or backup copies) are removed on every path. The text is never logged; a refusal keeps the draft.
 */
export function openExternalEditor(options: ExternalEditorOptions): ExternalEditor {
  return Object.freeze({
    async edit(text: string, signal?: AbortSignal): Promise<ExternalEditorOutcome> {
      const command = editorCommand(options.env);
      if (command === 'unset' || command === 'malformed') return refused(command === 'unset' ? 'no-editor' : 'not-started');
      if (Buffer.byteLength(text, 'utf8') > LIMITS.maxBytes) return refused('too-large');
      if (signal?.aborted) return refused('failed');
      let directory: string | null = null;
      try {
        directory = await mkdtemp(join(options.tmpdir ?? tmpdir(), LIMITS.directoryPrefix));
        const file = join(directory, LIMITS.fileName);
        await writeFile(file, text, { mode: 0o600, flag: 'wx' });
        const exit = signal?.aborted ? 'aborted' : runEditor(command, file, options.env);
        if (exit !== 0) return refused(exit === 'not-started' ? 'not-started' : exit === 'aborted' ? 'failed' : 'exit');
        const after = await lstat(file);
        if (!after.isFile()) return refused('unsafe');
        if (after.size > LIMITS.maxBytes) return refused('too-large');
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), buffer = Buffer.alloc(LIMITS.maxBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0).finally(() => handle.close());
        if (bytesRead > LIMITS.maxBytes) return refused('too-large');
        const read = buffer.subarray(0, bytesRead).toString('utf8');
        return read === text ? Object.freeze({ kind: 'unchanged' }) : Object.freeze({ kind: 'edited', text: read });
      } catch { return refused('failed'); }
      finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
    },
  });
}
