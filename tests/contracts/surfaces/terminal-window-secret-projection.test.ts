import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearConfigCache, snapshotKnownSecrets } from '#platform/index.js';
import { terminalAdminPorts } from '#surfaces/core/terminal-admin/index.js';
import { projectPickerTree } from '#surfaces/core/terminal-picker/index.js';
import { projectInfoModel, type InfoWindowModel } from '#surfaces/core/terminal-window/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { SLASH_WINDOW_TEST_LABELS } from '../support/slash-window-labels.js';

// Astra 2456 P1-2: the information windows (SW-1) and the list windows (SW-3 /scratch) project every visible word through the known-secret /
// human-text projection, whole, before layout. A configured secret in a producer's text or a scratch file name never reaches the screen —
// neither whole nor as a fragment left by a cut or a wrap — at a wide and a narrow width with the NO_COLOR palette (the harness palette).
const CANARY = 'zq7Kx9Vw3Lp2Nr8Tb5HcQm4Ys', known = snapshotKnownSecrets([{ name: 'SW_CANARY', value: CANARY }]);
const MASK = '‹secret:SW_CANARY›', ESC = '\u001B', ENTER = '\r';
/** Any 5-character piece of the canary (what a cut or a wrap could leave). */
function leaks(text: string): string | null {
  for (let at = 0; at + 5 <= CANARY.length; at++) if (text.includes(CANARY.slice(at, at + 5))) return CANARY.slice(at, at + 5);
  return null;
}
const roots: string[] = [], views: Array<ReturnType<typeof mountWorkline>> = [];
afterEach(async () => { for (const view of views.splice(0)) view.instance.unmount(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function type(view: ReturnType<typeof mountWorkline>, text: string) { for (const char of text) { view.stdin.write(char); await settle(2); } }

describe('information and list windows mask known secrets before layout (Astra 2456 P1-2)', () => {
  it.each([200, 40])('/status on the real workline at %s columns: the producer text with a known secret is masked whole, never cut into pieces', async columns => {
    const root = await mkdtemp(join(tmpdir(), 'dn-sw-secret-')); roots.push(root);
    await mkdir(join(root, '.deckent'), { recursive: true });
    await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') } }));
    const info = terminalAdminPorts({ root, scopeId: 's', installationId: '7d1e2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b', projectId: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d',
      options: { env: { HOME: join(root, 'h') } }, locale: 'en', context: {}, status: async () => `Terminal: token ${CANARY} in a long detail line that wraps on a narrow terminal ${CANARY}`,
      doctor: async sink => { sink.write('DOCTOR\n'); }, principalName: `user-${CANARY}` }).info;
    const view = mountWorkline({ info, knownSecrets: known, labels: { ...WORKLINE_TEST_LABELS, windows: SLASH_WINDOW_TEST_LABELS } }, columns, { rows: 60 });
    views.push(view);
    await until(() => view.stdout.frame.includes('READY'), 'ready'); await settle(40);
    await type(view, '/status\r');
    await until(() => view.stdout.frame.includes('▸ Runtime service') || view.stdout.frame.includes('> Runtime service'), 'status window');
    await settle(40);
    if (columns === 200) expect(view.stdout.frame).toContain(MASK);
    expect(leaks(view.stdout.text)).toBeNull();
    view.stdin.write(ESC); await until(() => view.stdout.frame.includes('Deckent system'), 'summary line');
    expect(leaks(view.stdout.text)).toBeNull();
  });

  it.each([200, 40])('/scratch list and file path windows at %s columns never show a known secret in a file name or the folder', async columns => {
    const folder = `/tmp/scratch-${CANARY}`;
    const port = { async inspect() { return { schemaVersion: 1 as const, path: folder, exists: true, bytes: 20, truncated: false,
      files: [{ path: `${folder}/notes-${CANARY}.txt`, bytes: 10, modifiedAtMs: 0 }, { path: `${folder}/plain.txt`, bytes: 10, modifiedAtMs: 0 }],
      limits: { writeMaxBytes: 1, sessionMaxBytes: 1000, retentionDays: 1 } }; },
      async clear() { return { schemaVersion: 1 as const, path: folder, removedFiles: 0, removedBytes: 0 }; } };
    const view = mountWorkline({ scratch: port, knownSecrets: known, labels: { ...WORKLINE_TEST_LABELS, windows: SLASH_WINDOW_TEST_LABELS,
      scratch: { summary: 's', empty: 'e', entry: 'ENTRY {path}', more: 'm', path: 'p', cleared: 'CLEARED {count} {bytes}', usage: 'u' } } }, columns, { rows: 60 });
    views.push(view);
    await until(() => view.stdout.frame.includes('READY'), 'ready'); await settle(40);
    await type(view, '/scratch\r');
    await until(() => view.stdout.frame.includes(SLASH_WINDOW_TEST_LABELS.scratch.folder) && view.stdout.frame.includes(SLASH_WINDOW_TEST_LABELS.scratch.title), 'scratch list');
    await settle(40);
    if (columns === 200) expect(view.stdout.frame).toContain(MASK);
    expect(leaks(view.stdout.text)).toBeNull();
    // Selection still works: Enter on the first (masked) file opens its path window.
    view.stdin.write(ENTER);
    await until(() => view.stdout.frame.includes(SLASH_WINDOW_TEST_LABELS.scratch.pathTitle), 'path window');
    await settle(40);
    expect(leaks(view.stdout.text)).toBeNull();
    if (columns === 200) expect(view.stdout.frame).toContain(`notes-${MASK}.txt`);
    view.stdin.write(ESC); await settle(60);
  });

  it('the projections keep choice ids, picker ids and the summary, and mask identities before they are shortened', () => {
    const model: InfoWindowModel = { title: `T ${CANARY}`, summary: `S ${CANARY}`, sections: [{ title: CANARY, rows: [{ key: 'K', value: CANARY, id: `${CANARY}-id` }],
      items: [{ text: CANARY }], table: { columns: [CANARY], rows: [[CANARY]] }, choices: [{ id: `choice-${CANARY}`, label: CANARY, detail: CANARY }], notes: [CANARY] }] };
    const mask = (text: string) => text.split(CANARY).join('M');
    const shown = projectInfoModel(model, mask);
    expect(JSON.stringify({ ...shown, summary: '', sections: shown.sections.map(section => ({ ...section, choices: section.choices?.map(choice => ({ ...choice, id: '' })) })) })).not.toContain(CANARY);
    expect(shown.sections[0]!.choices![0]!.id).toBe(`choice-${CANARY}`); expect(shown.summary).toBe(`S ${CANARY}`);
    expect(shown.sections[0]!.rows![0]!.id).toBe('M-id');
    const tree = projectPickerTree({ title: CANARY, items: [{ id: `file:${CANARY}`, label: CANARY, detail: CANARY, children: [{ id: 'leaf', label: CANARY }] }] }, mask);
    expect(tree.items[0]!.id).toBe(`file:${CANARY}`); expect(tree.items[0]!.children![0]!.id).toBe('leaf');
    expect(JSON.stringify({ ...tree, items: tree.items.map(item => ({ ...item, id: '' })) })).not.toContain(CANARY);
  });
});
