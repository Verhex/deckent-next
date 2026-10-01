import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';

/**
 * Astra 2189 R7 (adopted reviewer negative, astra-2188-open-ancestor): the full-access open view protects its state roots by mount points,
 * and a mount point's writable ancestor must not be renamable — `mv` of the ancestor would carry the mount away with the renamed dentry and
 * let a command recreate the original path with bytes of its choosing. Real runtime service, real policy/full-access grant,
 * `terminal.shell.realm=require-sandbox`, real bubblewrap. Expected: the rename fails (EBUSY: every ancestor is a mount point), the
 * original path keeps its bytes.
 */
const roots: string[] = [];
afterEach(async () => { await closeModeRuntimes(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const grants = [rule('shell', 'agent-tool', ['run_shell'], 'require-approval', true), rule('run', 'operation', ['host.shell.run'], 'allow'),
  rule('full', 'permission-mode', ['full-access'], 'allow', false, ['set'])];
const original = '{"mcpServers":{}}\n';

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] full access cannot replace the HOME state registry by renaming HOME (closed view control, then open view)', async () => {
  const f = await modeRuntime({ mode: 'full-auto', dataRoot: '.deckent/data', shell: { schemaVersion: 1, realm: 'require-sandbox' }, grants });
  const home = join(dirname(f.project), 'home'); vi.stubEnv('HOME', home);
  roots.push(`${home}-moved`);
  const state = join(home, '.deckent'); await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(join(state, 'mcp.json'), original, { mode: 0o600 });
  // Expanded names: the OS boundary must hold where no lexical check could classify the path.
  const command = 'p="$HOME"; mv "$p" "$p-moved" && mkdir -p "$p/.deckent" && printf REPLACED-SYNTHETIC > "$p/.deckent/mcp.json"';
  const closed = await f.call('run_shell', { command }, 'allow');
  expect(await readFile(join(state, 'mcp.json'), 'utf8')).toBe(original);
  console.log('R7_CLOSED_CONTROL', JSON.stringify({ status: closed.status, card: closed.card, text: closed.text }));
  const result = await f.call('run_shell', { command }, 'deny', { fullAccess: true });
  const current = await readFile(join(state, 'mcp.json'), 'utf8').catch(() => null);
  const moved = await readFile(join(`${home}-moved`, '.deckent/mcp.json'), 'utf8').catch(() => null);
  console.log('R7_OPEN_HOME', JSON.stringify({ status: result.status, card: result.card, text: result.text, current, moved }));
  expect(result.card).toBe(false);
  expect(result.text).toMatch(/Device or resource busy/);
  expect(current).toBe(original);
  expect(moved).toBeNull();
}, 60_000);

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] full access cannot replace a nested global state root by renaming its parent (HOME not moved)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'deckent-r7-state-parent-')); roots.push(base);
  const parent = join(base, 'authority'), state = join(parent, 'state'); await mkdir(state, { recursive: true, mode: 0o700 });
  vi.stubEnv('DECKENT_GLOBAL_HOME', state);
  const f = await modeRuntime({ mode: 'full-auto', dataRoot: '.deckent/data', shell: { schemaVersion: 1, realm: 'require-sandbox' }, grants });
  vi.stubEnv('HOME', join(dirname(f.project), 'home'));
  await writeFile(join(state, 'mcp.json'), original, { mode: 0o600 });
  // One and more than one ancestor: the direct parent, then the grandparent.
  for (const target of [parent, base]) {
    const command = `p='${target}'; mv "$p" "$p-moved" && mkdir -p '${state}' && printf REPLACED-SYNTHETIC > '${state}/mcp.json'`;
    roots.push(`${target}-moved`);
    const result = await f.call('run_shell', { command }, 'deny', { fullAccess: true });
    const current = await readFile(join(state, 'mcp.json'), 'utf8').catch(() => null);
    console.log('R7_OPEN_GLOBAL_PARENT', JSON.stringify({ target, status: result.status, card: result.card, text: result.text, current }));
    expect(result.text).toMatch(/Device or resource busy/);
    expect(current).toBe(original);
  }
}, 60_000);
