import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openExternalEditor, TERMINAL_EDITOR_LIMITS } from '#adapters/index.js';

/** T4 (Ctrl+G, Claude Code / Codex): the draft goes to a private temporary file, the person's $VISUAL/$EDITOR edits it, the text comes back bounded. */
const fixture = resolve('tests/fixtures/terminal-editor/editor.mjs');
const editorValue = `"${process.execPath}" "${fixture}"`;
async function setup(mode: string, extra: Record<string, string> = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'deckent-editor-test-')), report = join(tmp, 'report.json');
  const env = { EDITOR: editorValue, FIXTURE_EDITOR_MODE: mode, FIXTURE_EDITOR_REPORT: report, ...extra };
  return { tmp, report, editor: openExternalEditor({ env, tmpdir: tmp }) };
}
const leftovers = async (tmp: string) => (await readdir(tmp)).filter(name => name !== 'report.json');

describe.skipIf(process.platform === 'win32')('external editor adapter (POSIX)', () => {
  it('opens the draft in a 0600 file inside a 0700 directory, returns the edited text and removes both', async () => {
    const { tmp, report, editor } = await setup('append');
    expect(await editor.edit('draft words')).toEqual({ kind: 'edited', text: 'draft words edited\n' });
    const seen = JSON.parse(readFileSync(report, 'utf8')) as { args: string[]; file: string; fileMode: number; dirMode: number };
    expect(seen.fileMode).toBe(0o600); expect(seen.dirMode).toBe(0o700);
    expect(seen.file.startsWith(tmp)).toBe(true); expect(seen.file.endsWith(TERMINAL_EDITOR_LIMITS.fileName)).toBe(true);
    expect(existsSync(seen.file)).toBe(false); expect(await leftovers(tmp)).toEqual([]);
  });

  it('prefers VISUAL over EDITOR and says no-editor when neither is set (never a guessed editor)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'deckent-editor-test-'));
    expect(await openExternalEditor({ env: {}, tmpdir: tmp }).edit('x')).toEqual({ kind: 'refused', reason: 'no-editor' });
    expect(await openExternalEditor({ env: { EDITOR: '   ' }, tmpdir: tmp }).edit('x')).toEqual({ kind: 'refused', reason: 'no-editor' });
    expect(await openExternalEditor({ env: { VISUAL: editorValue, EDITOR: '/nonexistent/editor', FIXTURE_EDITOR_MODE: 'append' }, tmpdir: tmp }).edit('v')).toEqual({ kind: 'edited', text: 'v edited\n' });
    expect(await leftovers(tmp)).toEqual([]);
  });

  it('keeps the draft when the editor cannot start, exits with an error, swaps in a link or writes more than the bound', async () => {
    let run = await setup('append');
    expect(await openExternalEditor({ env: { EDITOR: '/nonexistent/editor --wait' }, tmpdir: run.tmp }).edit('x')).toEqual({ kind: 'refused', reason: 'not-started' });
    expect(await leftovers(run.tmp)).toEqual([]);
    run = await setup('fail');
    expect(await run.editor.edit('x')).toEqual({ kind: 'refused', reason: 'exit' });
    run = await setup('link');
    expect(await run.editor.edit('x')).toEqual({ kind: 'refused', reason: 'unsafe' });
    run = await setup('huge', { FIXTURE_EDITOR_BYTES: String(TERMINAL_EDITOR_LIMITS.maxBytes + 1) });
    expect(await run.editor.edit('x')).toEqual({ kind: 'refused', reason: 'too-large' });
    expect(await leftovers(run.tmp)).toEqual([]);
    run = await setup('append');
    expect(await run.editor.edit('y'.repeat(TERMINAL_EDITOR_LIMITS.maxBytes + 1))).toEqual({ kind: 'refused', reason: 'too-large' });
    expect(existsSync(run.report)).toBe(false);
  });

  it('reports an unchanged draft and removes the files an editor leaves next to it (backup copies)', async () => {
    let run = await setup('none');
    expect(await run.editor.edit('same')).toEqual({ kind: 'unchanged' });
    run = await setup('backup');
    expect(await run.editor.edit('b')).toEqual({ kind: 'edited', text: 'b!' });
    expect(await leftovers(run.tmp)).toEqual([]);
  });

  it('ends the editor when the terminal goes away (abort)', async () => {
    const { tmp } = await setup('append');
    const controller = new AbortController(); controller.abort();
    expect(await openExternalEditor({ env: { EDITOR: editorValue }, tmpdir: tmp }).edit('x', controller.signal)).toEqual({ kind: 'refused', reason: 'failed' });
    expect(await leftovers(tmp)).toEqual([]);
  });
});
