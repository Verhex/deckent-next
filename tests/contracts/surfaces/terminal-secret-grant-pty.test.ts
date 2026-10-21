import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inPty, type Step } from '../support/pty-steps.js';
import { resolveGlobalConfigPaths } from '#platform/index.js';

// PRE-8 first-use card on a real pseudo-terminal (owner decisions 2026-10-21): the built workline, the card's catalog words (EN/TR), the
// composition's offer decision on a throwaway installation and this process's own terminal attestation. The turn and the grant record are
// in-process stand-ins (no runtime service, no model call); the governed `secret grant` application is P8-CORE's, wired at fan-in.
const fixture = resolve('tests/contracts/surfaces/terminal-secret-grant-pty.fixture.mjs');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function installation(profile: string | null) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-grant-pty-')); roots.push(root);
  const home = join(root, 'home'), env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') };
  const global = resolveGlobalConfigPaths(env).platformPath;
  await Promise.all([mkdir(dirname(global), { recursive: true }), mkdir(join(root, 'project', '.deckent'), { recursive: true })]);
  if (profile) await writeFile(global, JSON.stringify({ identity: { profile: { id: profile, version: 1 } } }));
  return { root, project: join(root, 'project'), marker: join(root, 'grant-DECKENT_ANTHROPIC_KEY') };
}
/** The last step's keys leave the view (Ctrl+C twice); the driver stops it otherwise. */
const EXIT = '\u0003\u0003';
/** The transcript as words: control sequences, frame glyphs and line wraps removed, so a wrapped sentence still reads whole. */
const words = (text: string) => stripVTControlCharacters(text).replace(/[│╭╮╰╯─]/gu, ' ').replace(/\s+/gu, ' ');
const run = async (where: Awaited<ReturnType<typeof installation>>, locale: 'en' | 'tr', steps: readonly Step[]) =>
  words((await inPty(fixture, where.project, { PRE8_PTY_ROOT: where.root, TERM: 'xterm-256color', NO_COLOR: '1' }, locale, steps)).output);

describe('PRE-8 first-use card on a real PTY', () => {
  beforeEach(async context => {
    if (process.platform !== 'linux') context.skip('PYTHON_PTY_LINUX_ONLY: the terminal attestation is Linux /proc evidence; native macOS has no witness yet (owner decision 6)');
    await access(resolve('dist/surfaces/core/cli-terminal/index.js'));
  });
  it('solo: the card names the key and the project; y records the grant and the same message is answered', async () => {
    const where = await installation('core:solo');
    const out = await run(where, 'en', [['READY', 'hello\r'], ['Use the main key DECKENT_ANTHROPIC_KEY in this project?', ''],
      ['y yes, grant', 'y', 'next'], ['ANSWER-AFTER-GRANT', EXIT, 'fresh']]);
    expect(existsSync(where.marker)).toBe(true);
    expect(out).toContain('an AI session cannot answer this card');
    expect(out).toContain('run deckent secret revoke DECKENT_ANTHROPIC_KEY --scope scope-a');
    expect(out).not.toContain('ERR:SECRET_GRANT_REQUIRED');
  });
  for (const [label, key] of [['n', 'n'], ['Enter', '\r']] as const) {
    it(`solo: ${label} records nothing and the turn shows the typed refusal with its command`, async () => {
      const where = await installation(null);
      const out = await run(where, 'en', [['READY', 'hello\r'], ['Use the main key DECKENT_ANTHROPIC_KEY', ''], ['y yes, grant', key, 'next'],
        ['ERR:SECRET_GRANT_REQUIRED', EXIT, 'fresh']]);
      expect(existsSync(where.marker)).toBe(false);
      expect(out).toContain('deckent secret grant DECKENT_ANTHROPIC_KEY --scope scope-a');
      expect(out).not.toContain('ANSWER-AFTER-GRANT');
    });
  }
  it('Turkish: the card speaks Turkish and Ctrl+C on it records nothing', async () => {
    const where = await installation('core:solo');
    const out = await run(where, 'tr', [['READY', 'merhaba\r'], ['Ana anahtar DECKENT_ANTHROPIC_KEY bu projede kullanılsın mı?', ''],
      ['y evet, izin ver', '\u0003', 'next'], ['ERR:SECRET_GRANT_REQUIRED', EXIT, 'fresh']]);
    expect(out).toContain('bir AI oturumu bu kartı yanıtlayamaz');
    expect(existsSync(where.marker)).toBe(false);
  });
  it('team: no card; the refusal names the admin command', async () => {
    const where = await installation('core:team');
    const out = await run(where, 'en', [['READY', 'hello\r'], ['ERR:SECRET_GRANT_REQUIRED', EXIT, 'fresh']]);
    expect(out).not.toContain('Use the main key');
    expect(out).toContain('deckent secret grant DECKENT_ANTHROPIC_KEY --scope scope-a');
    expect(out).toContain('an admin grants it');
    expect(existsSync(where.marker)).toBe(false);
  });
});

describe('PRE-8 first-use card: who can answer', () => {
  // The same built offer decision outside a terminal: a pipe, and an agent's host shell (stdin ignored, its own session, no controlling terminal).
  const offer = async (where: Awaited<ReturnType<typeof installation>>, stdio: 'pipe' | 'agent-shell') => {
    const child = spawn(process.execPath, [fixture, 'offer'], { cwd: where.project, env: { PATH: process.env['PATH'] ?? '', PRE8_PTY_ROOT: where.root },
      stdio: stdio === 'pipe' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'], detached: stdio === 'agent-shell' });
    let out = '', err = '';
    child.stdout!.on('data', chunk => { out += String(chunk); }); child.stderr!.on('data', chunk => { err += String(chunk); });
    if (stdio === 'pipe') child.stdin!.end('y\n');
    await new Promise(done => child.once('exit', done));
    return { out, err };
  };
  beforeEach(async context => { if (process.platform !== 'linux') context.skip('LINUX_ATTESTATION_ONLY'); await access(resolve('dist/composition/core/terminal-chat/index.js')); });
  it('a pipe and an agent shell are never offered the card on a solo installation', async () => {
    const where = await installation('core:solo');
    for (const stdio of ['pipe', 'agent-shell'] as const) expect(await offer(where, stdio), stdio).toEqual({ out: 'false', err: '' });
  });
});
