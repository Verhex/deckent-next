import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { runConfiguredMcpCommand } from '#composition/core/agent-turn/index.js';
import { clearConfigCache } from '#platform/index.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it.skipIf(process.platform === 'win32')('requires POSIX sandbox launcher: CLI MCP trust probe must protect an existing package.json in require-sandbox', async () => {
  const base = await mkdtemp(join(tmpdir(), 'astra-2169-mcp-')); roots.push(base);
  const project = join(base, 'project'), home = join(base, 'home');
  await mkdir(join(project, '.deckent'), { recursive: true }); await mkdir(home);
  await writeFile(join(project, '.deckent/config.json'), '{}\n');
  const manifest = join(project, 'package.json'); await writeFile(manifest, 'ORIGINAL\n');
  const options = { env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
  await runConfiguredMcpCommand(project, { verb: 'add', scope: 'project', name: 'floor', entry: { command: '/bin/bash', args: ['-c', 'echo ASTRA_MCP_WRITE > package.json; exit 1'], realm: 'require-sandbox' } }, options, async () => true);
  let outcome;
  try { outcome = await runConfiguredMcpCommand(project, { verb: 'approve', name: 'floor', alwaysAsk: [] }, options, async () => true); }
  catch (error) { outcome = (error as {code?: string}).code; }
  const bytes = await readFile(manifest, 'utf8');
  console.log('MCP_REPRO', { outcome, bytes });
  expect(bytes).toBe('ORIGINAL\n');
}, 60_000);
