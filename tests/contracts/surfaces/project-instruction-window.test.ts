import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { openProjectInstructionReader, previewProjectInstructions, registerProviderConfig } from '#adapters/index.js';
import type { ProjectInstructionPort } from '#engine/index.js';
import { lineInstructionContext, instructionModelContext, projectInstructionLabels, projectSkeleton, InstructionInitWindow } from '#surfaces/core/project-instructions/index.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';
import { main } from '#surfaces/index.js';
import { clearConfigCache } from '#platform/index.js';
const roots: string[] = [], mounted: ReturnType<typeof mountWorkline>[] = [];
const cleanup: (() => void)[] = [];
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'instruction-window-')); roots.push(folder);
  const root = join(folder, 'project'), trust = join(folder, 'trust'); await mkdir(root); await mkdir(trust, { mode: 0o700 });
  await writeFile(join(root, 'DECKENT.md'), 'PROJECT-ONLY-CONTEXT');
  const reader = await openProjectInstructionReader(root, trust);
  const port: ProjectInstructionPort = { ...reader, preview: async () => { throw new Error('unused'); }, initialize: async () => [] };
  return { root, trust, port };
}
afterEach(async () => {
  clearConfigCache();
  for (const close of cleanup.splice(0)) close();
  for (const view of mounted.splice(0)) { view.instance.unmount(); view.stdin.end(); }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
describe('project instruction trust on the real Ink workline', () => {
  it('renders source/size in a window before model delivery; Esc sends the turn without untrusted content', async () => {
    const f = await fixture(), calls: string[] = [];
    const view = mountWorkline({ projectInstructions: { port: f.port, labels: projectInstructionLabels('en') }, completeTurn: async messages => { calls.push(JSON.stringify(messages)); return 'done'; } }); mounted.push(view);
    await settle(60); view.stdin.write('hello\r');
    await until(() => view.stdout.frame.includes('Project instruction trust'), 'trust window');
    expect(view.stdout.frame).toContain('DECKENT.md'); expect(view.stdout.frame).toContain('20 bytes'); expect(calls).toEqual([]);
    view.stdin.write('\u001b'); await until(() => calls.length === 1, 'declined turn');
    expect(calls[0]).not.toContain('PROJECT-ONLY-CONTEXT'); expect(await f.port.inspect()).toMatchObject({ status: 'trust-required' });
  });
  it('Down then Enter accepts exact content, persists its digest and changed content asks again before the next model turn', async () => {
    const f = await fixture(), calls: string[] = [];
    const view = mountWorkline({ projectInstructions: { port: f.port, labels: projectInstructionLabels('en') }, completeTurn: async messages => { calls.push(JSON.stringify(messages)); return 'done'; } }); mounted.push(view);
    await settle(60); view.stdin.write('hello\r'); await until(() => view.stdout.frame.includes('Project instruction trust'), 'trust window');
    view.stdin.write('\u001b[B'); await settle(); view.stdin.write('\r'); await until(() => calls.length === 1, 'accepted turn');
    expect(calls[0]).toContain('PROJECT-ONLY-CONTEXT');
    expect(await (await openProjectInstructionReader(f.root, f.trust)).inspect()).toMatchObject({ status: 'ready' });
    await settle(80); view.stdin.write('/context\r');
    await until(() => view.stdout.frame.includes('Project instructions:'), 'context source');
    expect(view.stdout.frame).toContain(`${f.root}/DECKENT.md`); expect(calls).toHaveLength(1);
    await settle(80); await writeFile(join(f.root, 'DECKENT.md'), 'CHANGED-PROJECT'); view.stdin.write('second\r');
    await until(() => view.stdout.frame.includes('CHANGED-PROJECT'), 'changed trust window'); expect(calls).toHaveLength(1);
    view.stdin.write('\u001b'); await until(() => calls.length === 2, 'declined changed turn');
    expect(calls[1]).not.toContain('CHANGED-PROJECT'); expect(calls[1]).not.toContain('PROJECT-ONLY-CONTEXT');
  });
  it('line mode requires an explicit matching digest, and a changed file cannot reuse that flag', async () => {
    const f = await fixture(), view = await f.port.inspect(); if (!('source' in view)) throw new Error('source');
    expect(instructionModelContext(await lineInstructionContext(f.port))).toBe('');
    expect(instructionModelContext(await lineInstructionContext(f.port, '0'.repeat(64)))).toBe('');
    expect(instructionModelContext(await lineInstructionContext(f.port, view.source.digest))).toContain('PROJECT-ONLY-CONTEXT');
    await writeFile(join(f.root, 'DECKENT.md'), 'changed');
    expect(instructionModelContext(await lineInstructionContext(f.port, view.source.digest))).toBe('');
  });
  it('the CLI line entry sends only trusted context and /context prints its real source and size locally', async () => {
    registerProviderConfig();
    const f = await fixture(); await mkdir(join(f.root, '.deckent'), { mode: 0o700 });
    await writeFile(join(f.root, '.deckent/config.json'), JSON.stringify({ terminal: { scopeId: 'installation' } }), { mode: 0o600 });
    const source = await f.port.inspect(); if (!('source' in source)) throw new Error('source');
    const calls: string[] = []; let output = '';
    const stdout = new Writable({ write(chunk: Buffer, _encoding, done) { output += chunk.toString(); done(); } });
    const invoke = async (digest?: string) => main(['terminal', 'session', ...(digest ? ['--trust-instructions', digest] : [])], {
      root: f.root, env: { HOME: f.trust, DECKENT_TEST_SKIP_PUBLISH_LOCK: '1' }, stdin: Readable.from(['hello\n/context\n']), stdout, stderr: stdout,
      openProjectInstructions: async () => f.port, completeTerminalChat: async (_root, input) => { calls.push(JSON.stringify(input.messages)); return 'done'; } });
    expect({ code: await invoke(), output }).toMatchObject({ code: 0 }); expect(calls[0]).not.toContain('PROJECT-ONLY-CONTEXT'); expect(output).toContain('--trust-instructions');
    output = ''; expect(await invoke(source.source.digest)).toBe(0); expect(calls[1]).toContain('PROJECT-ONLY-CONTEXT');
    expect(output).toContain(`${f.root}/DECKENT.md`); expect(output).toContain('20 bytes'); expect(calls).toHaveLength(2);
  });
  it('init renders a generated preview before confirmation and Esc performs no write', async () => {
    const f = await fixture(); await rm(join(f.root, 'DECKENT.md'));
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ name: 'init-derived', scripts: { test: 'never execute this' } }));
    const skeleton = projectSkeleton('en'), initial = await previewProjectInstructions(f.root, [], skeleton);
    const written: unknown[] = [];
    const port: ProjectInstructionPort = { ...f.port, preview: bridges => previewProjectInstructions(f.root, bridges, skeleton), initialize: async preview => { written.push(preview); return []; } };
    let frame = '', finished = false;
    const stdout = Object.assign(new Writable({ write(chunk: Buffer, _encoding, done) { frame = chunk.toString(); done(); } }), { isTTY: true, columns: 180, rows: 50 });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
    const view = render(createElement(InstructionInitWindow, { port, initial, skeleton, labels: projectInstructionLabels('en'), finish: () => { finished = true; } }),
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, interactive: true, exitOnCtrlC: false, patchConsole: false });
    cleanup.push(() => { view.unmount(); stdin.end(); });
    await until(() => frame.includes('Optional host bridges'), 'init bridge selection');
    stdin.write('\r'); await until(() => frame.includes('Preview project instructions'), 'init preview');
    expect(frame).toContain('init-derived'); expect(frame).toContain('npm run test'); expect(written).toEqual([]);
    stdin.write('\u001b'); await until(() => finished, 'init escaped'); expect(written).toEqual([]);
  });
});
