import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runConfiguredMcpCommand } from '#composition/core/agent-turn/index.js';
import { clearConfigCache, DeckentError, loadConfig, productResourcePath } from '#platform/index.js';
import { main } from '#surfaces/core/cli/index.js';

// LANG-CRASH (live session 1d428e9f, 2026-09-29): `deckent mcp add` inside the sandbox reached the trust audit, whose ledger preflight refused a
// companion file it did not own (`MANAGED_FILE_UNSAFE`). The raw ManagedFileError escaped the MCP command as an uncaught exception: a crash
// report under the project's `.deckent/crashes` instead of a typed, localized CLI error. Every `mcp` verb that records trust goes through
// the same audit, so each is a boundary case here; nothing in these tests starts a server.
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function unsafeLedgerProject() {
  const base = mkdtempSync(join(tmpdir(), 'deckent-mcp-errors-')); roots.push(base);
  const project = join(base, 'project'), home = join(base, 'home');
  mkdirSync(join(project, '.deckent'), { recursive: true }); mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(project, '.deckent', 'config.json'), '{}\n');
  // The project registry holds one undecided server (a project entry is asked on first use: adding it records no trust, no audit).
  writeFileSync(join(project, '.deckent', 'mcp.json'), `${JSON.stringify({ mcpServers: { fx: { type: 'stdio', command: process.execPath, args: ['-e', ''] } } }, null, 2)}\n`);
  const env = { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', DECKENT_LANGUAGE: 'tr' };
  const layout = (await loadConfig(project, { env })).productLayout;
  const ledger = productResourcePath(layout, 'ledger');
  mkdirSync(join(ledger, '..'), { recursive: true, mode: 0o700 });
  // What the sandbox showed: a ledger companion that is not private (mode 0644 here; another owner through a user namespace live).
  writeFileSync(`${ledger}-wal`, ''); chmodSync(`${ledger}-wal`, 0o644);
  return { project, env, crashes: productResourcePath(layout, 'crashes'), ledger };
}

describe.skipIf(process.platform !== 'linux')('MCP command boundary: managed-file refusals are typed CLI errors, never crashes', () => {
  it('CLI remove and terminal /mcp approve (reset) on an unsafe ledger companion: MANAGED_FILE_UNSAFE with its diagnosis, localized, exit 1, no crash report', async () => {
    const w = await unsafeLedgerProject();
    // `/mcp approve <name>` is the host's `reset` verb: typed, with the diagnosis the owner can act on (checked first: `remove` changes the registry).
    const direct = await runConfiguredMcpCommand(w.project, { verb: 'reset', name: 'fx' }, { env: w.env }, async () => null).then(() => null, (error: unknown) => error);
    expect(direct).toBeInstanceOf(DeckentError);
    expect(direct).toMatchObject({ code: 'MANAGED_FILE_UNSAFE', params: { resource: 'ledger', companion: '-wal', reason: 'mode', mode: 0o644 } });
    const err: string[] = [];
    const code = await main(['mcp', 'remove', 'fx'], { root: w.project, env: w.env, stdout: { write: () => true },
      stderr: { write: (text: string) => { err.push(text); return true; } }, runMcpCommand: runConfiguredMcpCommand });
    const shown = err.join('');
    expect(code).toBe(1);
    expect(shown).toContain('MANAGED_FILE_UNSAFE');
    // Turkish catalog text (the caller's locale), never the raw exception.
    expect(shown).toContain('Yönetilen depolama');
    expect(shown).not.toContain('at privateFile');
    expect(existsSync(w.crashes)).toBe(false);
    // Nothing was repaired silently: the unsafe companion is left as found.
    expect(readFileSync(`${w.ledger}-wal`, 'utf8')).toBe('');
  });

  it('an unexpected (non-product) failure still reaches the crash boundary: only product refusals are mapped', async () => {
    const w = await unsafeLedgerProject();
    const code = await main(['mcp', 'list'], { root: w.project, env: w.env, stdout: { write: () => true }, stderr: { write: () => true },
      runMcpCommand: async () => { throw new TypeError('boom'); } });
    expect(code).toBe(1);
    expect(existsSync(w.crashes)).toBe(true);
  });
});
