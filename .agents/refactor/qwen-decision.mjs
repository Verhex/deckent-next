#!/usr/bin/env node
// Explicit host provider: existing Jev commands/defaults remain unchanged.
import { constants } from 'node:fs';
import { open, readFile, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensure } from './jev-context.mjs';
import { privateDirectory } from './jev-journal.mjs';
import { validateLocalConfig } from './qwen-decision-client.mjs';
import { createDecisionEngine, errorCode } from './qwen-decision-store.mjs';
import { createDecisionServer } from './qwen-decision-api.mjs';

export async function readPrivateToken(path) {
  ensure(process.platform !== 'win32' && constants.O_NOFOLLOW > 0, 'QWEN_API_TOKEN_UNSUPPORTED');
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat(); ensure(s.isFile() && s.uid === process.getuid() && (s.mode & 0o077) === 0
      && s.size <= 128, 'QWEN_API_TOKEN');
    const token = (await h.readFile('utf8')).trim(); ensure(/^[a-f0-9]{64}$/.test(token), 'QWEN_API_TOKEN'); return token;
  } finally { await h.close(); }
}
async function input(path, limit) {
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = await h.stat(); ensure(s.isFile() && s.size <= limit, 'QWEN_REQUEST_TOO_LARGE'); return JSON.parse(await h.readFile('utf8')); }
  finally { await h.close(); }
}
export async function loadSettings() {
  const path = resolve(process.env.DECKENT_QWEN_DECISION_CONFIG ?? fileURLToPath(new URL('./qwen-decision.config.json', import.meta.url)));
  const config = validateLocalConfig(await input(path, 16384));
  const policy = JSON.parse(await readFile(new URL('./jev.review.config.json', import.meta.url), 'utf8'));
  return { config, policy, root: resolve(dirname(path), config.journalRoot), authFile: resolve(dirname(path), config.authFile) };
}
async function main(args) {
  const [mode, first, second, ...extra] = args;
  ensure(['prepare', 'ask', 'record', 'outcome', 'inspect', 'report', 'init-api', 'serve'].includes(mode)
    && extra.length === 0, 'QWEN_USAGE');
  ensure(['report', 'init-api', 'serve'].includes(mode) ? !first && !second
    : ['record', 'outcome'].includes(mode) ? first && second
      : mode === 'ask' ? first : first && !second, 'QWEN_USAGE');
  const settings = await loadSettings(); const { config, policy, root, authFile } = settings;
  if (mode === 'init-api') {
    await privateDirectory(dirname(authFile));
    const h = await open(authFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await h.writeFile(randomBytes(32).toString('hex') + '\n'); await h.sync(); } finally { await h.close(); }
    return { scope: 'development-host', tokenFile: authFile, tokenPrinted: false };
  }
  let token;
  try { token = await readPrivateToken(authFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const engine = createDecisionEngine({ config, policy, root, secret: token });
  if (mode === 'serve') {
    ensure(token, 'QWEN_API_TOKEN');
    const server = createDecisionServer({ engine, token, maxRequestBytes: config.maxRequestBytes, timeoutMs: config.timeoutMs });
    server.listen(config.port, '127.0.0.1', () => process.stdout.write(JSON.stringify({ listening: `http://127.0.0.1:${config.port}`,
      scope: 'development-host', authentication: 'private-bearer-token', automaticRouting: false }) + '\n'));
    server.on('error', () => { process.stderr.write('{"error":"QWEN_API_LISTEN"}\n'); process.exitCode = 1; });
    const stop = () => { server.close(); server.closeAllConnections(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop); return;
  }
  if (mode === 'report') return engine.report();
  if (mode === 'inspect') return engine.inspect(first);
  if (mode === 'record' || mode === 'outcome') return engine.followup(first, mode === 'record' ? 'decision' : 'outcome', await input(second, policy.maxCaseBytes));
  const c = await input(first, policy.maxCaseBytes);
  return mode === 'prepare' ? { network: false, ...engine.prepare(c) } : engine.ask(c, { id: second });
}
if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n');
    if (result?.status === 'unknown') process.exitCode = 1;
  }).catch(e => { process.stderr.write(JSON.stringify({ error: errorCode(e) }) + '\n'); process.exitCode = 1; });
}
